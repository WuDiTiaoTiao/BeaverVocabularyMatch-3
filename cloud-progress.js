const EXACT_COLUMNS = 'book_id, scope, seed, completed_pair_ids, score, correct_matches, attempts, client_updated_at, updated_at';
const BOOK_IDS = new Set(['ielts', 'cet6', 'postgrad', 'cet4']);
const SCOPES = new Set(['frequent', 'full']);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class CloudProgressError extends Error {
  constructor(message, { code = 'cloud_error', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CloudProgressError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const fail = (message, code = 'invalid_record', cause) => {
  throw new CloudProgressError(message, { code, cause });
};

const isNetworkError = (error) => {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  const name = String(error?.name ?? '').toLowerCase();
  const code = String(error?.code ?? '').toLowerCase();
  return error?.status === 0
    || (name === 'typeerror' && /(fetch|network)/.test(message))
    || /(network|offline|failed to fetch|load failed|connection reset|internet)/.test(`${code} ${message}`);
};

const wrap = (error, message = 'Cloud progress request failed') => {
  if (error instanceof CloudProgressError) return error;
  return new CloudProgressError(message, { code: isNetworkError(error) ? 'offline' : 'request_failed', cause: error });
};

const requireUser = (getUser) => {
  let user;
  try {
    user = getUser?.();
  } catch (error) {
    throw wrap(error, 'Authentication lookup failed');
  }
  if (!user || typeof user.id !== 'string' || user.id.trim() === '') {
    fail('Authentication required', 'unauthenticated');
  }
  return user;
};

const accountChanged = (getUser, expectedId) => {
  let user;
  try {
    user = getUser?.();
  } catch (error) {
    throw new CloudProgressError('Authenticated account changed', { code: 'account_changed', cause: error });
  }
  if (!user || user.id !== expectedId) {
    fail('Authenticated account changed', 'account_changed');
  }
  return user;
};

const isSafeEpoch = (value) => Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0;

const toIsoTimestamp = (value) => {
  if (!isSafeEpoch(value)) fail('Invalid client timestamp');
  try {
    return new Date(value).toISOString();
  } catch (error) {
    fail('Invalid client timestamp', 'invalid_record', error);
  }
};

const validateRecord = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Invalid progress record');
  if (!BOOK_IDS.has(record.bookId) || !SCOPES.has(record.scope)) fail('Invalid progress challenge');
  if (!Number.isSafeInteger(record.seed) || record.seed < 0 || record.seed > MAX_SAFE) fail('Invalid progress seed');
  if (!Array.isArray(record.completedPairIds)) fail('Invalid completed pair ids');
  const pairIds = [];
  const seen = new Set();
  for (const pairId of record.completedPairIds) {
    if (typeof pairId !== 'string' || pairId.length === 0) fail('Invalid completed pair id');
    if (!seen.has(pairId)) {
      seen.add(pairId);
      pairIds.push(pairId);
    }
  }
  for (const key of ['score', 'correctMatches', 'attempts']) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) fail(`Invalid ${key}`);
  }
  if (record.correctMatches > record.attempts) fail('Invalid match counters');
  toIsoTimestamp(record.clientUpdatedAt);
  return {
    bookId: record.bookId,
    scope: record.scope,
    seed: record.seed,
    completedPairIds: pairIds,
    score: record.score,
    correctMatches: record.correctMatches,
    attempts: record.attempts,
    clientUpdatedAt: record.clientUpdatedAt,
  };
};

const validateExpected = (record) => {
  if (!record || typeof record !== 'object' || !BOOK_IDS.has(record.bookId) || !SCOPES.has(record.scope)) {
    fail('Invalid progress challenge');
  }
  return {
    bookId: record.bookId,
    scope: record.scope,
    clientUpdatedAt: toIsoTimestamp(record.clientUpdatedAt),
  };
};

const dateMillis = (value) => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Number.isSafeInteger(parsed) ? parsed : null;
};

const normalizeRow = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Invalid cloud progress row', 'invalid_response');
  if (!BOOK_IDS.has(row.book_id) || !SCOPES.has(row.scope)) fail('Invalid cloud progress challenge', 'invalid_response');
  if (row.seed === null || row.seed === '' || (typeof row.seed !== 'number' && typeof row.seed !== 'string')) {
    fail('Invalid cloud progress seed', 'invalid_response');
  }
  const seedText = typeof row.seed === 'string' ? row.seed : String(row.seed);
  if (!/^(0|[1-9]\d*)$/.test(seedText)) fail('Invalid cloud progress seed', 'invalid_response');
  const seed = Number(seedText);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SAFE) fail('Invalid cloud progress seed', 'invalid_response');
  if (!Array.isArray(row.completed_pair_ids)) fail('Invalid cloud pair ids', 'invalid_response');
  const seen = new Set();
  for (const pairId of row.completed_pair_ids) {
    if (typeof pairId !== 'string' || pairId.length === 0 || seen.has(pairId)) fail('Invalid cloud pair ids', 'invalid_response');
    seen.add(pairId);
  }
  for (const key of ['score', 'correct_matches', 'attempts']) {
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) fail(`Invalid cloud ${key}`, 'invalid_response');
  }
  if (row.correct_matches > row.attempts) fail('Invalid cloud match counters', 'invalid_response');
  const clientUpdatedAt = dateMillis(row.client_updated_at);
  const serverUpdatedAt = dateMillis(row.updated_at);
  if (clientUpdatedAt === null || serverUpdatedAt === null) fail('Invalid cloud timestamps', 'invalid_response');
  return {
    bookId: row.book_id,
    scope: row.scope,
    seed,
    completedPairIds: [...row.completed_pair_ids],
    score: row.score,
    correctMatches: row.correct_matches,
    attempts: row.attempts,
    clientUpdatedAt,
    serverUpdatedAt,
  };
};

const readResponse = async (request, message = 'Cloud progress request failed') => {
  let response;
  try {
    response = await request();
  } catch (error) {
    throw wrap(error, message);
  }
  if (!response || typeof response !== 'object') {
    fail('Invalid cloud progress response', 'invalid_response');
  }
  if (response.error) throw new CloudProgressError('Cloud progress request failed', {
    code: isNetworkError(response.error) ? 'offline' : 'request_failed',
    cause: response.error,
  });
  if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
    fail('Invalid cloud progress response', 'invalid_response');
  }
  return response.data;
};

const writeFields = (record, userId) => ({
  user_id: userId,
  book_id: record.bookId,
  scope: record.scope,
  seed: record.seed,
  completed_pair_ids: record.completedPairIds,
  score: record.score,
  correct_matches: record.correctMatches,
  attempts: record.attempts,
  client_updated_at: toIsoTimestamp(record.clientUpdatedAt),
});

export const createCloudProgressService = ({ client, getUser }) => {
  if (!client || typeof getUser !== 'function') throw new TypeError('client and getUser are required');

  const fetchRow = async (userId, filterByUser = false) => {
    const data = await readResponse(
      () => {
        let query = client.from('challenge_progress').select(EXACT_COLUMNS);
        if (filterByUser) query = query.eq('user_id', userId);
        return query.maybeSingle();
      },
      'Cloud progress fetch failed',
    );
    return data;
  };

  const fetchProgress = async () => {
    const user = requireUser(getUser);
    const data = await fetchRow(user.id);
    accountChanged(getUser, user.id);
    return data === null ? null : normalizeRow(data);
  };

  const mergeProgress = async (record) => {
    const normalized = validateRecord(record);
    const user = requireUser(getUser);
    const data = await readResponse(
      () => client.rpc('merge_challenge_progress', {
        p_book_id: normalized.bookId,
        p_scope: normalized.scope,
        p_seed: normalized.seed,
        p_completed_pair_ids: normalized.completedPairIds,
        p_score: normalized.score,
        p_correct_matches: normalized.correctMatches,
        p_attempts: normalized.attempts,
        p_client_updated_at: toIsoTimestamp(normalized.clientUpdatedAt),
      }),
      'Cloud progress merge failed',
    );
    accountChanged(getUser, user.id);
    if (!data || typeof data !== 'object' || !['merged', 'conflict'].includes(data.status)) {
      fail('Invalid cloud merge response', 'invalid_response');
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'record')) fail('Invalid cloud merge response', 'invalid_response');
    return { status: data.status, record: normalizeRow(data.record) };
  };

  const replaceProgress = async (record) => {
    const normalized = validateRecord(record);
    const user = requireUser(getUser);
    const data = await readResponse(
      () => client.from('challenge_progress')
        .upsert(writeFields(normalized, user.id), { onConflict: 'user_id' })
        .select(EXACT_COLUMNS)
        .single(),
      'Cloud progress replacement failed',
    );
    accountChanged(getUser, user.id);
    return normalizeRow(data);
  };

  const clearProgress = async (expectedRecord) => {
    const expected = validateExpected(expectedRecord);
    const user = requireUser(getUser);
    const deleted = await readResponse(
      () => client.from('challenge_progress')
        .delete()
        .eq('user_id', user.id)
        .eq('book_id', expected.bookId)
        .eq('scope', expected.scope)
        .eq('client_updated_at', expected.clientUpdatedAt)
        .select('user_id'),
      'Cloud progress deletion failed',
    );
    accountChanged(getUser, user.id);
    if (!Array.isArray(deleted)) fail('Invalid cloud deletion response', 'invalid_response');
    if (deleted.length > 1) fail('Invalid cloud deletion response', 'invalid_response');
    if (deleted.length > 0) return 'cleared';
    accountChanged(getUser, user.id);
    const current = await fetchRow(user.id, true);
    accountChanged(getUser, user.id);
    if (current === null) return 'empty';
    normalizeRow(current);
    return 'changed';
  };

  return { fetchProgress, mergeProgress, replaceProgress, clearProgress };
};

