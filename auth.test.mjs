import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AuthError,
  createAuthService,
  getAuthErrorCopy,
  getResendSeconds,
  maskEmail,
} from './auth.js';
import { isSupabaseConfigured, SUPABASE_CONFIG, SUPABASE_MODULE_URL } from './supabase-config.js';

const createAuthFixture = ({ session = null, authError = null, getSessionError = null } = {}) => {
  const calls = {
    signInWithOtp: [],
    verifyOtp: [],
    getSession: 0,
    signOut: 0,
    onAuthStateChange: 0,
    unsubscribe: 0,
    createClient: [],
  };
  let stateSession = session;
  let stateCallback;
  const client = {
    auth: {
      async getSession() {
        calls.getSession += 1;
        return { data: { session: stateSession }, error: getSessionError };
      },
      onAuthStateChange(callback) {
        calls.onAuthStateChange += 1;
        stateCallback = callback;
        return { data: { subscription: { unsubscribe: () => { calls.unsubscribe += 1; } } } };
      },
      async signInWithOtp(payload) {
        calls.signInWithOtp.push(payload);
        return { data: {}, error: authError };
      },
      async verifyOtp(payload) {
        calls.verifyOtp.push(payload);
        const user = { id: 'user-1', email: payload.email };
        stateSession = { user, access_token: 'access-token' };
        return { data: { user, session: stateSession }, error: authError };
      },
      async signOut() {
        calls.signOut += 1;
        stateSession = null;
        return { error: authError };
      },
    },
  };
  const auth = createAuthService({
    config: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
    importSupabase: async () => ({ createClient: (...args) => { calls.createClient.push(args); return client; } }),
  });
  return { auth, calls, client, emit: (event, nextSession) => stateCallback?.(event, nextSession) };
};

test('unconfigured auth initializes as guest without loading the remote module', async () => {
  let imports = 0;
  const auth = createAuthService({
    config: null,
    importSupabase: async () => { imports += 1; },
  });

  assert.deepEqual(await auth.initialize(), { status: 'guest', user: null, configured: false });
  assert.equal(imports, 0);
});

test('invalid Supabase configuration stays in guest mode without importing', async () => {
  let imports = 0;
  const auth = createAuthService({
    config: { url: 'http://insecure.example', anonKey: 'anon-key' },
    importSupabase: async () => { imports += 1; },
  });
  assert.deepEqual(await auth.initialize(), { status: 'guest', user: null, configured: false });
  assert.equal(imports, 0);
});

test('Supabase configuration exposes the pinned module URL and validator', () => {
  assert.deepEqual(SUPABASE_CONFIG, {
    url: 'https://tsgpfthearuejylackke.supabase.co',
    anonKey: 'sb_publishable_4o1RfD9G6z_ZQ7K7I-0AGA_MwMrzQNL',
  });
  assert.equal(SUPABASE_MODULE_URL, 'https://esm.sh/@supabase/supabase-js@2.45.4');
  assert.equal(isSupabaseConfigured(SUPABASE_CONFIG), true);
  assert.equal(isSupabaseConfigured({ url: 'https://example.supabase.co', anonKey: 'key' }), true);
  assert.equal(isSupabaseConfigured({ url: 'http://example.supabase.co', anonKey: 'key' }), false);
});

test('sendOtp normalizes the email and asks Supabase to create the user', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.initialize();
  await auth.sendOtp('  Learner@Example.COM ');
  assert.deepEqual(calls.signInWithOtp[0], {
    email: 'learner@example.com',
    options: { shouldCreateUser: true },
  });
});

test('verifyOtp uses the email token flow', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.initialize();
  await auth.verifyOtp('learner@example.com', '123456');
  assert.deepEqual(calls.verifyOtp[0], {
    email: 'learner@example.com', token: '123456', type: 'email',
  });
});

test('initialize creates one persistent Supabase client', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.initialize();
  await auth.initialize();
  assert.equal(calls.createClient.length, 1);
  assert.deepEqual(calls.createClient[0], [
    'https://example.supabase.co',
    'anon-key',
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
  ]);
});

test('verifyOtp updates the latest user before returning it', async () => {
  const { auth } = createAuthFixture();
  await auth.initialize();
  const user = await auth.verifyOtp('learner@example.com', '123456');
  assert.equal(auth.getUser(), user);
});

test('initialize restores an authenticated persisted session', async () => {
  const persisted = { user: { id: 'persisted' }, access_token: 'persisted-token' };
  const { auth } = createAuthFixture({ session: persisted });
  assert.deepEqual(await auth.initialize(), {
    status: 'authenticated', user: persisted.user, configured: true,
  });
  assert.equal(auth.getUser(), persisted.user);
  assert.equal(auth.getClient() !== null, true);
});

test('initialization failure returns guest and clears the unusable client', async () => {
  const auth = createAuthService({
    config: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
    importSupabase: async () => { throw new Error('network down'); },
  });
  const result = await auth.initialize();
  assert.equal(result.status, 'guest');
  assert.equal(result.configured, true);
  assert.equal(result.user, null);
  assert.equal(result.error.code, 'offline');
  assert.equal(auth.getClient(), null);
});

test('transient initialization failure is retryable and preserves the first error snapshot', async () => {
  let imports = 0;
  const retryUser = { id: 'retry-user' };
  const auth = createAuthService({
    config: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
    importSupabase: async () => {
      imports += 1;
      if (imports === 1) throw new Error('network down');
      return {
        createClient: () => ({ auth: {
          async getSession() { return { data: { session: { user: retryUser } }, error: null }; },
        } }),
      };
    },
  });
  const first = await auth.initialize();
  assert.equal(first.status, 'guest');
  assert.equal(first.error.code, 'offline');
  const second = await auth.initialize();
  assert.deepEqual(second, { status: 'authenticated', user: retryUser, configured: true });
  assert.equal(imports, 2);
});

const createRejectingFixture = ({ method, error }) => {
  const session = { user: { id: 'u' }, access_token: 'token' };
  let getSessionCalls = 0;
  const client = { auth: {
    async getSession() {
      getSessionCalls += 1;
      if (method === 'getSession' && getSessionCalls > 1) throw error;
      return { data: { session }, error: null };
    },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async signInWithOtp() {
      if (method === 'sendOtp') throw error;
      return { data: {}, error: null };
    },
    async verifyOtp() {
      if (method === 'verifyOtp') throw error;
      return { data: { user: session.user, session }, error: null };
    },
    async signOut() {
      if (method === 'signOut') throw error;
      return { error: null };
    },
  } };
  return createAuthService({
    config: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
    importSupabase: async () => ({ createClient: () => client }),
  });
};

test('rejected sendOtp promises normalize network errors with their cause', async () => {
  const failure = new TypeError('Failed to fetch');
  const auth = createRejectingFixture({ method: 'sendOtp', error: failure });
  await auth.initialize();
  await assert.rejects(() => auth.sendOtp('learner@example.com'), (error) => {
    assert.equal(error.code, 'offline');
    assert.equal(error.cause, failure);
    return true;
  });
});

test('rejected verifyOtp promises normalize auth-code errors with their cause', async () => {
  const failure = { code: 'invalid_otp', message: 'Invalid OTP' };
  const auth = createRejectingFixture({ method: 'verifyOtp', error: failure });
  await auth.initialize();
  await assert.rejects(() => auth.verifyOtp('learner@example.com', '123456'), (error) => {
    assert.equal(error.code, 'invalid_code');
    assert.equal(error.cause, failure);
    return true;
  });
});

test('rejected signOut promises normalize errors with their cause', async () => {
  const failure = { status: 429, message: 'Too many requests' };
  const auth = createRejectingFixture({ method: 'signOut', error: failure });
  await auth.initialize();
  await assert.rejects(() => auth.signOut(), (error) => {
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.cause, failure);
    return true;
  });
});

test('rejected getSession promises normalize network errors with their cause', async () => {
  const failure = new TypeError('Network request failed');
  const auth = createRejectingFixture({ method: 'getSession', error: failure });
  await auth.initialize();
  await assert.rejects(() => auth.getSession(), (error) => {
    assert.equal(error.code, 'offline');
    assert.equal(error.cause, failure);
    return true;
  });
});

test('getUser is updated before a subscribed listener is notified', async () => {
  const { auth, emit } = createAuthFixture();
  await auth.initialize();
  const seen = [];
  auth.subscribe(({ event, user }) => seen.push({ event, user, current: auth.getUser() }));
  const nextUser = { id: 'next' };
  emit('SIGNED_IN', { user: nextUser });
  assert.deepEqual(seen, [{ event: 'SIGNED_IN', user: nextUser, current: nextUser }]);
});

test('unsubscribe calls the real Supabase subscription', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.initialize();
  const unsubscribe = auth.subscribe(() => {});
  unsubscribe();
  assert.equal(calls.unsubscribe, 1);
});

test('subscribe before successful initialization is a safe no-op', async () => {
  let notified = false;
  const auth = createAuthService({ config: null, importSupabase: async () => { notified = true; } });
  const unsubscribe = auth.subscribe(() => { notified = true; });
  unsubscribe();
  assert.equal(notified, false);
});

test('signOut clears service state without touching challenge storage', async () => {
  const { auth, calls } = createAuthFixture({ session: { user: { id: 'u' } } });
  await auth.initialize();
  await auth.signOut();
  assert.equal(calls.signOut, 1);
  assert.equal(auth.getUser(), null);
  assert.equal(await auth.getSession(), null);
});

test('malformed email is rejected locally', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.initialize();
  await assert.rejects(() => auth.sendOtp('not-an-email'), (error) => error.code === 'invalid_email');
  assert.equal(calls.signInWithOtp.length, 0);
});

test('token must be exactly six ASCII digits', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.initialize();
  await assert.rejects(() => auth.verifyOtp('learner@example.com', '１２３４５６'), (error) => error.code === 'invalid_code');
  await assert.rejects(() => auth.verifyOtp('learner@example.com', '12345'), (error) => error.code === 'invalid_code');
  assert.equal(calls.verifyOtp.length, 0);
});

test('maskEmail preserves only the first and last local-part characters', () => {
  assert.equal(maskEmail('learner@example.com'), 'l***r@example.com');
  assert.equal(maskEmail('a@example.com'), 'a***@example.com');
});

test('auth display helpers provide stable Chinese copy and resend countdowns', () => {
  assert.equal(getAuthErrorCopy('otp_expired'), '验证码已过期，请重新发送。');
  assert.equal(getAuthErrorCopy({ code: 'invalid_code' }), '验证码不正确，请重新输入。');
  assert.equal(getAuthErrorCopy('unrecognized'), '登录服务暂时不可用，请稍后重试。');
  assert.equal(getResendSeconds(1_000, 1_000), 60);
  assert.equal(getResendSeconds(1_000, 1_001), 60);
  assert.equal(getResendSeconds(1_000, 60_001), 1);
  assert.equal(getResendSeconds(1_000, 61_000), 0);
});

test('normalizes expired, invalid, rate-limited, offline, and unknown errors', async () => {
  const cases = [
    [{ status: 400, message: 'OTP expired' }, 'otp_expired'],
    [{ code: 'invalid_otp', message: 'Invalid OTP' }, 'invalid_code'],
    [{ status: 429, message: 'Too many requests' }, 'rate_limited'],
    [{ name: 'TypeError', message: 'Failed to fetch' }, 'offline'],
    [{ message: 'unexpected server error' }, 'unknown'],
  ];
  for (const [failure, expected] of cases) {
    const { auth } = createAuthFixture({ authError: failure });
    await auth.initialize();
    await assert.rejects(() => auth.sendOtp('learner@example.com'), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.cause, failure);
      return true;
    });
  }
});

test('AuthError carries a public code and original cause', () => {
  const cause = new Error('cause');
  const error = new AuthError('unknown', 'safe message', cause);
  assert.equal(error.code, 'unknown');
  assert.equal(error.cause, cause);
});
