export const CHALLENGE_PROGRESS_KEY = 'synonym-match-challenge-v1';

const normalizeRecord = (record, vocabulary) => {
  if (!record || record.version !== 1) return null;
  if (record.bookId !== vocabulary.bookId || record.scope !== vocabulary.scope) return null;
  if (!Number.isFinite(record.seed) || !Number.isFinite(record.score)) return null;
  if (!Array.isArray(record.completedPairIds)) return null;

  const validPairIds = new Set(vocabulary.pairs.map((pair) => pair.pairId));
  const completedPairIds = [...new Set(record.completedPairIds)]
    .filter((pairId) => typeof pairId === 'string' && validPairIds.has(pairId));
  if (completedPairIds.length >= vocabulary.pairs.length) return null;

  return {
    bookId: record.bookId,
    scope: record.scope,
    seed: record.seed,
    score: Math.max(0, record.score),
    correctMatches: Number.isFinite(record.correctMatches) ? Math.max(0, record.correctMatches) : 0,
    attempts: Number.isFinite(record.attempts) ? Math.max(0, record.attempts) : 0,
    completedPairIds,
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
    if (record?.version !== 1 || typeof record.bookId !== 'string' || typeof record.scope !== 'string') {
      return null;
    }
    return { bookId: record.bookId, scope: record.scope };
  } catch {
    return null;
  }
};

export const saveChallengeProgress = (storage, state) => {
  const record = {
    version: 1,
    bookId: state.bookId,
    scope: state.scope,
    seed: state.seed,
    score: state.score,
    correctMatches: state.correctMatches ?? 0,
    attempts: state.attempts ?? 0,
    completedPairIds: [...new Set(state.completedBookPairIds)],
  };
  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify(record));
};

export const clearChallengeProgress = (storage) => {
  storage.removeItem(CHALLENGE_PROGRESS_KEY);
};
