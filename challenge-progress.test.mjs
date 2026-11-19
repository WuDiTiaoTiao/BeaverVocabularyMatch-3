import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHALLENGE_PROGRESS_KEY,
  createChallengeProgressAdapter,
  createPendingCloudDeleteAdapter,
  isChallengeProgressEquivalent,
  clearChallengeProgress,
  getChallengeProgressSelection,
  loadChallengeProgress,
  replaceChallengeProgress,
  savePendingCloudDelete,
  loadPendingCloudDelete,
  clearPendingCloudDelete,
  saveChallengeProgress,
  shouldRebuildFromSyncRecord,
} from './challenge-progress.js';
import * as challengeProgress from './challenge-progress.js';

test('local sync echo is equivalent to the live challenge while remote changes are adoptable', () => {
  const live = {
    bookId: 'postgrad', scope: 'frequent', seed: 7, score: 40,
    correctMatches: 2, attempts: 3, completedBookPairIds: ['pair-1', 'pair-2'],
  };
  const record = { ...live, completedPairIds: live.completedBookPairIds, clientUpdatedAt: 20 };
  assert.equal(isChallengeProgressEquivalent(record, live), true);
  assert.equal(isChallengeProgressEquivalent({ ...record, completedPairIds: ['pair-1', 'pair-2', 'pair-3'] }, live), false);
  assert.equal(isChallengeProgressEquivalent({ ...record, score: 99 }, live), false);
});

test('same timestamp sync snapshots rebuild when progress content changes', () => {
  const live = {
    bookId: 'postgrad', scope: 'frequent', seed: 7, score: 40,
    correctMatches: 2, attempts: 3, completedBookPairIds: ['pair-1'],
  };
  const record = { ...live, completedPairIds: ['pair-1', 'pair-2'], clientUpdatedAt: 20 };
  assert.equal(shouldRebuildFromSyncRecord(record, live, true), true);
  assert.equal(shouldRebuildFromSyncRecord({ ...record, completedPairIds: ['pair-1'] }, live, true), false);
});

test('controller adapters bind challenge and user-scoped pending-delete storage', () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  const local = createChallengeProgressAdapter(storage);
  const pending = createPendingCloudDeleteAdapter(storage);
  const vocabulary = { bookId: 'postgrad', scope: 'frequent', pairs: [{ pairId: 'pair-1' }] };
  const record = { bookId: 'postgrad', scope: 'frequent', seed: 1, score: 2, completedPairIds: [], correctMatches: 0, attempts: 0, clientUpdatedAt: 10 };
  local.replace(record);
  assert.deepEqual(local.getSelection(), { bookId: 'postgrad', scope: 'frequent' });
  assert.deepEqual(local.load(vocabulary), { ...record, clientUpdatedAt: 10 });
  pending.save('user-a', record);
  assert.deepEqual(pending.load('user-a'), record);
  assert.equal(pending.load('user-b'), null);
  pending.clear('user-a');
  assert.equal(pending.load('user-a'), null);
});

const VOCABULARY = {
  bookId: 'postgrad',
  scope: 'frequent',
  pairs: Array.from({ length: 7 }, (_, index) => ({
    pairId: `pair-${index + 1}`,
    words: [`word-${index * 2 + 1}`, `word-${index * 2 + 2}`],
  })),
};

const createStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

const CATALOG = {
  books: {
    postgrad: { scopes: { frequent: {}, full: {} } },
    ielts: { scopes: { frequent: {}, full: {} } },
  },
};

test('vocabulary selection survives after the active challenge is cleared', () => {
  const storage = createStorage();
  challengeProgress.saveVocabularySelection(storage, { bookId: 'ielts', scope: 'full' });
  challengeProgress.clearChallengeProgress(storage);

  assert.deepEqual(challengeProgress.loadVocabularySelection(storage, CATALOG), {
    bookId: 'ielts',
    scope: 'full',
  });
});

test('invalid or unavailable saved vocabulary selections do not skip setup', () => {
  const storage = createStorage();
  storage.setItem('synonym-match-vocabulary-v1', JSON.stringify({ bookId: 'unknown', scope: 'full' }));
  assert.equal(challengeProgress.loadVocabularySelection(storage, CATALOG), null);

  storage.setItem('synonym-match-vocabulary-v1', JSON.stringify({ bookId: 'ielts', scope: 'other' }));
  assert.equal(challengeProgress.loadVocabularySelection(storage, CATALOG), null);

  challengeProgress.clearVocabularySelection(storage);
  assert.equal(storage.getItem('synonym-match-vocabulary-v1'), null);
});

test('startup selection prefers active progress, then account metadata, then local storage', () => {
  const localSelection = { bookId: 'postgrad', scope: 'frequent' };
  const accountSelection = { bookId: 'ielts', scope: 'full' };
  const activeRecord = { bookId: 'postgrad', scope: 'full' };

  assert.deepEqual(challengeProgress.chooseStartupVocabularySelection(CATALOG, {
    activeRecord,
    accountSelection,
    localSelection,
  }), activeRecord);
  assert.deepEqual(challengeProgress.chooseStartupVocabularySelection(CATALOG, {
    accountSelection,
    localSelection,
  }), accountSelection);
  assert.deepEqual(challengeProgress.chooseStartupVocabularySelection(CATALOG, {
    localSelection,
  }), localSelection);
  assert.equal(challengeProgress.chooseStartupVocabularySelection(CATALOG, {
    accountSelection: { bookId: 'missing', scope: 'full' },
  }), null);
});

test('saves and restores an unfinished vocabulary challenge', () => {
  const storage = createStorage();
  saveChallengeProgress(storage, {
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 170,
    correctMatches: 2,
    attempts: 3,
    completedBookPairIds: ['pair-1', 'pair-2'],
  }, 1234);

  assert.deepEqual(loadChallengeProgress(storage, VOCABULARY), {
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 170,
    correctMatches: 2,
    attempts: 3,
    completedPairIds: ['pair-1', 'pair-2'],
    clientUpdatedAt: 1234,
  });
});

test('reads the active book before its vocabulary file is loaded', () => {
  const storage = createStorage();
  saveChallengeProgress(storage, {
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 170,
    completedBookPairIds: ['pair-1'],
  }, 1234);

  assert.deepEqual(getChallengeProgressSelection(storage), {
    bookId: 'postgrad',
    scope: 'frequent',
  });
});

test('rejects malformed, mismatched, and already completed challenge records', () => {
  const storage = createStorage();
  storage.setItem(CHALLENGE_PROGRESS_KEY, '{not json');
  assert.equal(loadChallengeProgress(storage, VOCABULARY), null);

  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify({
    version: 1,
    bookId: 'ielts',
    scope: 'full',
    seed: 5,
    score: 0,
    completedPairIds: [],
  }));
  assert.equal(loadChallengeProgress(storage, VOCABULARY), null);

  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify({
    version: 1,
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 5,
    score: 0,
    completedPairIds: VOCABULARY.pairs.map((pair) => pair.pairId),
  }));
  assert.equal(loadChallengeProgress(storage, VOCABULARY), null);
});

test('rejects unsafe, fractional, negative, and inconsistent local counters', () => {
  const storage = createStorage();
  const base = {
    version: 2, bookId: 'postgrad', scope: 'frequent', seed: 5, score: 0,
    correctMatches: 0, attempts: 0, completedPairIds: [], clientUpdatedAt: 10,
  };
  const invalid = [
    ['seed', 1.5], ['seed', -1], ['seed', Number.MAX_SAFE_INTEGER + 1],
    ['score', 1.5], ['score', -1], ['score', Number.MAX_SAFE_INTEGER + 1],
    ['correctMatches', 1.5], ['correctMatches', -1], ['correctMatches', Number.MAX_SAFE_INTEGER + 1],
    ['attempts', 1.5], ['attempts', -1], ['attempts', Number.MAX_SAFE_INTEGER + 1],
    ['clientUpdatedAt', 1.5], ['clientUpdatedAt', -1], ['clientUpdatedAt', Number.MAX_SAFE_INTEGER + 1],
    ['correctMatches', 2, { attempts: 1 }],
  ];
  for (const [key, value, extra = {}] of invalid) {
    storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify({ ...base, ...extra, [key]: value }));
    assert.equal(loadChallengeProgress(storage, VOCABULARY), null, `${key}=${value}`);
  }
});

test('restored progress ignores duplicate and unknown pair ids', () => {
  const storage = createStorage();
  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify({
    version: 1,
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 5,
    score: 40,
    completedPairIds: ['pair-1', 'pair-1', 'unknown', 'pair-3'],
  }));

  assert.deepEqual(loadChallengeProgress(storage, VOCABULARY)?.completedPairIds, ['pair-1', 'pair-3']);
});

test('clearing progress removes the active challenge', () => {
  const storage = createStorage();
  saveChallengeProgress(storage, {
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 0,
    completedBookPairIds: [],
  });

  clearChallengeProgress(storage);

  assert.equal(storage.getItem(CHALLENGE_PROGRESS_KEY), null);
});

test('loads a version-one record with a stable migration timestamp', () => {
  const storage = createStorage();
  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify({
    version: 1,
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 70,
    correctMatches: 1,
    attempts: 2,
    completedPairIds: ['pair-1'],
  }));

  assert.equal(loadChallengeProgress(storage, VOCABULARY)?.clientUpdatedAt, 0);
});

test('writes version-two records with the supplied client timestamp', () => {
  const storage = createStorage();
  const result = saveChallengeProgress(storage, {
    bookId: 'postgrad', scope: 'frequent', seed: 42, score: 70,
    correctMatches: 1, attempts: 2, completedBookPairIds: ['pair-1'],
  }, 9876);

  assert.equal(JSON.parse(storage.getItem(CHALLENGE_PROGRESS_KEY)).version, 2);
  assert.equal(result.clientUpdatedAt, 9876);
});

test('a synchronized replacement preserves the source client timestamp', () => {
  const storage = createStorage();
  replaceChallengeProgress(storage, {
    bookId: 'postgrad', scope: 'full', seed: 42,
    completedPairIds: ['pair-1'], score: 100,
    correctMatches: 1, attempts: 2, clientUpdatedAt: 1234,
  });
  assert.equal(JSON.parse(storage.getItem(CHALLENGE_PROGRESS_KEY)).clientUpdatedAt, 1234);
});

test('pending cloud deletion is isolated by authenticated user id', () => {
  const storage = createStorage();
  const record = {
    bookId: 'postgrad', scope: 'frequent', seed: 42,
    completedPairIds: ['pair-1'], score: 100,
    correctMatches: 1, attempts: 2, clientUpdatedAt: 1234,
  };
  savePendingCloudDelete(storage, 'user-a', record);
  assert.equal(loadPendingCloudDelete(storage, 'user-b'), null);
  assert.equal(loadPendingCloudDelete(storage, 'user-a').bookId, record.bookId);
  clearPendingCloudDelete(storage, 'user-a');
  assert.equal(loadPendingCloudDelete(storage, 'user-a'), null);
});
