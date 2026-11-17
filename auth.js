import {
  SUPABASE_CONFIG,
  SUPABASE_MODULE_URL,
  isSupabaseConfigured,
} from './supabase-config.js';

const AUTH_CODES = new Set([
  'invalid_email',
  'invalid_code',
  'otp_expired',
  'rate_limited',
  'offline',
  'unknown',
]);

const messages = {
  invalid_email: 'Enter a valid email address.',
  invalid_code: 'Enter the six-digit code.',
  otp_expired: 'That code has expired. Request a new code.',
  rate_limited: 'Too many attempts. Please wait and try again.',
  offline: 'Authentication is unavailable while offline.',
  unknown: 'Authentication is temporarily unavailable.',
};

export class AuthError extends Error {
  constructor(code, message = messages[code] ?? messages.unknown, cause) {
    const normalizedCode = AUTH_CODES.has(code) ? code : 'unknown';
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AuthError';
    this.code = normalizedCode;
    if (cause !== undefined) this.cause = cause;
  }
}

const normalizeEmail = (email) => {
  if (typeof email !== 'string') throw new AuthError('invalid_email');
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf('@');
  const valid = at > 0
    && at === normalized.lastIndexOf('@')
    && at < normalized.length - 1
    && normalized.slice(at + 1).includes('.')
    && !normalized.slice(at + 1).startsWith('.')
    && !normalized.slice(at + 1).endsWith('.')
    && !normalized.slice(at + 1).includes('..')
    && !normalized.startsWith('.')
    && !normalized.slice(0, at).endsWith('.')
    && !/[\s]/.test(normalized);
  if (!valid) throw new AuthError('invalid_email');
  return normalized;
};

const isOfflineError = (error) => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const message = String(error?.message ?? error ?? '').toLowerCase();
  const name = String(error?.name ?? '').toLowerCase();
  const code = String(error?.code ?? '').toLowerCase();
  return error?.status === 0
    || name === 'typeerror' && /(fetch|network)/.test(message)
    || /(network|offline|failed to fetch|load failed|connection reset|internet)/.test(`${code} ${message}`);
};

const normalizeRemoteError = (error) => {
  if (error instanceof AuthError) return error;
  if (isOfflineError(error)) return new AuthError('offline', undefined, error);

  const status = Number(error?.status ?? error?.statusCode ?? 0);
  const haystack = `${String(error?.code ?? '')} ${String(error?.message ?? error ?? '')}`.toLowerCase();
  if (status === 429 || /(rate.?limit|too many requests|over_request_rate_limit|too_many_requests)/.test(haystack)) {
    return new AuthError('rate_limited', undefined, error);
  }
  if (/(otp|one.?time|token|code).*(expired|expire)|expired.*(otp|one.?time|token|code)/.test(haystack)) {
    return new AuthError('otp_expired', undefined, error);
  }
  if (/(invalid|incorrect|mismatch|bad).*(otp|one.?time|token|code)|invalid_otp|otp_invalid|invalid_grant|invalid_code/.test(haystack)) {
    return new AuthError('invalid_code', undefined, error);
  }
  return new AuthError('unknown', undefined, error);
};

const defaultImportSupabase = () => import(SUPABASE_MODULE_URL);

export const maskEmail = (email) => {
  if (typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}***${local.length > 1 ? local.at(-1) : ''}${domain}`;
};

const AUTH_ERROR_COPY = {
  invalid_email: '请输入有效邮箱地址。',
  invalid_code: '验证码不正确，请重新输入。',
  otp_expired: '验证码已过期，请重新发送。',
  rate_limited: '操作太频繁，请稍后再试。',
  offline: '当前网络不可用，游客进度仍会保存在本机。',
};

export const getAuthErrorCopy = (errorOrCode) => {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code;
  return AUTH_ERROR_COPY[code] ?? '登录服务暂时不可用，请稍后重试。';
};

export const getResendSeconds = (sentAtMs, nowMs = Date.now(), cooldownMs = 60_000) => {
  if (![sentAtMs, nowMs, cooldownMs].every(Number.isFinite) || cooldownMs < 0) return 0;
  return Math.max(0, Math.ceil((sentAtMs + cooldownMs - nowMs) / 1000));
};

export const createAuthService = ({
  config = SUPABASE_CONFIG,
  importSupabase = defaultImportSupabase,
} = {}) => {
  const configured = isSupabaseConfigured(config);
  let client = null;
  let session = null;
  let user = null;
  let clientReady = false;
  let initialized = false;
  let initializationPromise = null;

  const guestResult = (error) => ({
    status: 'guest',
    user: null,
    configured,
    ...(error ? { error } : {}),
  });

  const updateSession = (nextSession, fallbackUser = null) => {
    session = nextSession ?? null;
    user = session?.user ?? fallbackUser ?? null;
  };

  const initialize = async () => {
    if (initialized) {
      return session ? { status: 'authenticated', user, configured } : guestResult();
    }
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      if (!configured) {
        initialized = true;
        return guestResult();
      }
      try {
        const imported = await importSupabase();
        const createClient = imported?.createClient ?? imported?.default?.createClient;
        if (typeof createClient !== 'function') throw new Error('Supabase createClient is unavailable');
        client = createClient(config.url, config.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
        const result = await client.auth.getSession();
        if (result?.error) throw result.error;
        updateSession(result?.data?.session ?? null);
        clientReady = true;
        initialized = true;
        return session
          ? { status: 'authenticated', user, configured: true }
          : { status: 'guest', user: null, configured: true };
      } catch (error) {
        client = null;
        clientReady = false;
        updateSession(null);
        initialized = false;
        initializationPromise = null;
        return guestResult(normalizeRemoteError(error));
      }
    })();
    return initializationPromise;
  };

  const requireClient = async () => {
    if (!initialized) await initialize();
    if (!client) throw new AuthError('unknown');
    return client;
  };

  const sendOtp = async (email) => {
    const normalized = normalizeEmail(email);
    const authClient = await requireClient();
    let result;
    try {
      result = await authClient.auth.signInWithOtp({
        email: normalized,
        options: { shouldCreateUser: true },
      });
    } catch (error) {
      throw normalizeRemoteError(error);
    }
    if (result?.error) throw normalizeRemoteError(result.error);
  };

  const verifyOtp = async (email, token) => {
    const normalized = normalizeEmail(email);
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) throw new AuthError('invalid_code');
    const authClient = await requireClient();
    let result;
    try {
      result = await authClient.auth.verifyOtp({ email: normalized, token, type: 'email' });
    } catch (error) {
      throw normalizeRemoteError(error);
    }
    if (result?.error) throw normalizeRemoteError(result.error);
    updateSession(result?.data?.session ?? null, result?.data?.user ?? null);
    return result?.data?.user ?? user;
  };

  const signOut = async () => {
    if (!initialized) await initialize();
    if (!client) {
      updateSession(null);
      return;
    }
    let result;
    try {
      result = await client.auth.signOut();
    } catch (error) {
      throw normalizeRemoteError(error);
    }
    if (result?.error) throw normalizeRemoteError(result.error);
    updateSession(null);
  };

  const getSession = async () => {
    if (!initialized) await initialize();
    if (!client) return session;
    let result;
    try {
      result = await client.auth.getSession();
    } catch (error) {
      throw normalizeRemoteError(error);
    }
    if (result?.error) throw normalizeRemoteError(result.error);
    updateSession(result?.data?.session ?? null);
    return session;
  };

  const getUser = () => user;

  const getClient = () => (clientReady ? client : null);

  const subscribe = (listener) => {
    if (!client) return () => {};
    const result = client.auth.onAuthStateChange((event, nextSession) => {
      updateSession(nextSession);
      listener({ event, user });
    });
    return () => result?.data?.subscription?.unsubscribe?.();
  };

  return { initialize, sendOtp, verifyOtp, signOut, getSession, getUser, getClient, subscribe };
};
