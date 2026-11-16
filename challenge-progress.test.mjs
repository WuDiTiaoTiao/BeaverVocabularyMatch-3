import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHALLENGE_PROGRESS_KEY,
  clearChallengeProgress,
  getChallengeProgressSelection,
  loadChallengeProgress,
  saveChallengeProgress,
} from './challenge-progress.js';

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
  });

  assert.deepEqual(loadChallengeProgress(storage, VOCABULARY), {
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 170,
    correctMatches: 2,
    attempts: 3,
    completedPairIds: ['pair-1', 'pair-2'],
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
  });

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
