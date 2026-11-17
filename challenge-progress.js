export const CHALLENGE_PROGRESS_KEY = 'synonym-match-challenge-v1';

const normalizeRecord = (record, vocabulary) => {
  if (!record || ![1, 2].includes(record.version)) return null;
  if (record.bookId !== vocabulary.bookId || record.scope !== vocabulary.scope) return null;
  const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!isNonNegativeSafeInteger(record.seed) || !isNonNegativeSafeInteger(record.score)) return null;
  if (!Array.isArray(record.completedPairIds)) return null;
  const clientUpdatedAt = record.version === 1 ? 0 : record.clientUpdatedAt;
  if (!isNonNegativeSafeInteger(clientUpdatedAt)) return null;
  const correctMatches = record.version === 1 && record.correctMatches === undefined ? 0 : record.correctMatches;
  const attempts = record.version === 1 && record.attempts === undefined ? 0 : record.attempts;
  if (!isNonNegativeSafeInteger(correctMatches) || !isNonNegativeSafeInteger(attempts)
    || correctMatches > attempts) return null;

  const validPairIds = new Set(vocabulary.pairs.map((pair) => pair.pairId));
  const completedPairIds = [...new Set(record.completedPairIds)]
    .filter((pairId) => typeof pairId === 'string' && validPairIds.has(pairId));
  if (completedPairIds.length >= vocabulary.pairs.length) return null;

  return {
    bookId: record.bookId,
    scope: record.scope,
    seed: record.seed,
    score: record.score,
    correctMatches,
    attempts,
    completedPairIds,
    clientUpdatedAt,
    ...(Number.isFinite(record.serverUpdatedAt) ? { serverUpdatedAt: record.serverUpdatedAt } : {}),
  };
};

export const loadChallengeProgress = (storage, vocabulary) => {
  try {
    const serialized = storage.getItem(CHALLENGE_PROGRESS_KEY);
    if (!serialized) return null;
    return normalizeRecord(JSON.parse(serialized), vocabulary);
  } catch {
    return null;
  }
};

export const getChallengeProgressSelection = (storage) => {
  try {
    const serialized = storage.getItem(CHALLENGE_PROGRESS_KEY);
    if (!serialized) return null;
    const record = JSON.parse(serialized);
    if (![1, 2].includes(record?.version) || typeof record.bookId !== 'string' || typeof record.scope !== 'string') {
      return null;
    }
    return { bookId: record.bookId, scope: record.scope };
  } catch {
    return null;
  }
};

export const saveChallengeProgress = (storage, state, nowMs = Date.now()) => {
  const record = {
    version: 2,
    bookId: state.bookId,
    scope: state.scope,
    seed: state.seed,
    score: state.score,
    correctMatches: state.correctMatches ?? 0,
    attempts: state.attempts ?? 0,
    completedPairIds: [...new Set(state.completedBookPairIds)],
    clientUpdatedAt: nowMs,
  };
  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify(record));
  const { version: _version, ...syncRecord } = record;
  return syncRecord;
};

export const replaceChallengeProgress = (storage, record) => {
  const persisted = { ...record, version: 2 };
  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify(persisted));
};

const pendingDeleteKey = (userId) => `synonym-match-cloud-pending-delete-v1:${userId}`;

export const savePendingCloudDelete = (storage, userId, record) => {
  const pendingRecord = {
    bookId: record.bookId,
    scope: record.scope,
    seed: record.seed,
    completedPairIds: Array.isArray(record.completedPairIds) ? [...record.completedPairIds] : [],
    score: record.score,
    correctMatches: record.correctMatches,
    attempts: record.attempts,
    clientUpdatedAt: record.clientUpdatedAt,
    ...(Number.isFinite(record.serverUpdatedAt) ? { serverUpdatedAt: record.serverUpdatedAt } : {}),
  };
  storage.setItem(pendingDeleteKey(userId), JSON.stringify(pendingRecord));
};

export const loadPendingCloudDelete = (storage, userId) => {
  try {
    const serialized = storage.getItem(pendingDeleteKey(userId));
    return serialized ? JSON.parse(serialized) : null;
  } catch {
    return null;
  }
};

export const clearPendingCloudDelete = (storage, userId) => {
  storage.removeItem(pendingDeleteKey(userId));
};

export const clearChallengeProgress = (storage) => {
  storage.removeItem(CHALLENGE_PROGRESS_KEY);
};

export const createChallengeProgressAdapter = (storage) => ({
  getSelection: () => getChallengeProgressSelection(storage),
  load: (vocabulary) => loadChallengeProgress(storage, vocabulary),
  replace: (record) => replaceChallengeProgress(storage, record),
  clear: () => clearChallengeProgress(storage),
});

export const createPendingCloudDeleteAdapter = (storage) => ({
  load: (userId) => loadPendingCloudDelete(storage, userId),
  save: (userId, record) => savePendingCloudDelete(storage, userId, record),
  clear: (userId) => clearPendingCloudDelete(storage, userId),
});

export const isChallengeProgressEquivalent = (record, state) => {
  if (!record || !state || record.bookId !== state.bookId || record.scope !== state.scope || record.seed !== state.seed
    || record.score !== state.score || record.correctMatches !== (state.correctMatches ?? 0)
    || record.attempts !== (state.attempts ?? 0)) return false;
  const left = [...new Set(record.completedPairIds ?? [])].sort();
  const right = [...new Set(state.completedBookPairIds ?? [])].sort();
  return left.length === right.length && left.every((pairId, index) => pairId === right[index]);
};

export const shouldRebuildFromSyncRecord = (record, state, activeChallengeLoaded) => Boolean(
  record && (!activeChallengeLoaded || !isChallengeProgressEquivalent(record, state))
);
