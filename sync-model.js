const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export const normalizeSyncRecord = (record, vocabulary) => {
  if (!record || typeof record !== 'object') return null;
  if (record.bookId !== vocabulary?.bookId || record.scope !== vocabulary?.scope) return null;
  if (!isNonNegativeSafeInteger(record.seed) || !isNonNegativeSafeInteger(record.score)) return null;
  if (!isNonNegativeSafeInteger(record.correctMatches) || !isNonNegativeSafeInteger(record.attempts)
    || record.correctMatches > record.attempts) return null;
  if (!isNonNegativeSafeInteger(record.clientUpdatedAt) || !Array.isArray(record.completedPairIds)) return null;

  const validPairIds = new Set((vocabulary.pairs ?? []).map((pair) => pair.pairId));
  const completedPairIds = [...new Set(record.completedPairIds)]
    .filter((pairId) => typeof pairId === 'string' && validPairIds.has(pairId));
  if (completedPairIds.length >= validPairIds.size) return null;

  return {
    bookId: record.bookId,
    scope: record.scope,
    seed: record.seed,
    completedPairIds,
    score: record.score,
    correctMatches: record.correctMatches,
    attempts: record.attempts,
    clientUpdatedAt: record.clientUpdatedAt,
    ...(isNonNegativeSafeInteger(record.serverUpdatedAt) ? { serverUpdatedAt: record.serverUpdatedAt } : {}),
  };
};

export const mergeSameChallenge = (localRecord, cloudRecord) => {
  const cloudIsNewer = cloudRecord.clientUpdatedAt >= localRecord.clientUpdatedAt;
  const source = cloudIsNewer ? cloudRecord : localRecord;
  return {
    ...source,
    completedPairIds: [...new Set([
      ...localRecord.completedPairIds,
      ...cloudRecord.completedPairIds,
    ])].sort(),
  };
};

export const decideProgressSync = (localRecord, cloudRecord) => {
  if (!localRecord && !cloudRecord) return { type: 'empty', record: null };
  if (!localRecord) return { type: 'use-cloud', record: cloudRecord };
  if (!cloudRecord) return { type: 'use-local', record: localRecord };
  if (localRecord.bookId !== cloudRecord.bookId || localRecord.scope !== cloudRecord.scope) {
    return { type: 'conflict', localRecord, cloudRecord };
  }
  return { type: 'merge', record: mergeSameChallenge(localRecord, cloudRecord) };
};
