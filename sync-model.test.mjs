import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSyncRecord,
  mergeSameChallenge,
  decideProgressSync,
} from './sync-model.js';

const VOCABULARY = {
  bookId: 'postgrad',
  scope: 'frequent',
  pairs: Array.from({ length: 7 }, (_, index) => ({ pairId: `pair-${index + 1}` })),
};

const record = (overrides = {}) => ({
  bookId: 'postgrad', scope: 'frequent', seed: 10,
  completedPairIds: ['pair-1'], score: 100,
  correctMatches: 2, attempts: 3, clientUpdatedAt: 1000,
  ...overrides,
});

test('normalizes sync records and filters duplicate and unknown pair ids', () => {
  assert.deepEqual(normalizeSyncRecord(record({
    completedPairIds: ['pair-2', 'unknown', 'pair-2', 'pair-1'],
  }), VOCABULARY), record({ completedPairIds: ['pair-2', 'pair-1'] }));
});

test('rejects malformed sync records and completed whole-book records', () => {
  assert.equal(normalizeSyncRecord(null, VOCABULARY), null);
  assert.equal(normalizeSyncRecord(record({ bookId: 'ielts' }), VOCABULARY), null);
  assert.equal(normalizeSyncRecord(record({
    completedPairIds: VOCABULARY.pairs.map(({ pairId }) => pairId),
  }), VOCABULARY), null);
});

test('rejects unsafe, fractional, negative, and inconsistent sync counters', () => {
  const invalid = [
    ['seed', 1.5], ['seed', -1], ['seed', Number.MAX_SAFE_INTEGER + 1],
    ['score', 1.5], ['score', -1], ['score', Number.MAX_SAFE_INTEGER + 1],
    ['correctMatches', 1.5], ['correctMatches', -1], ['correctMatches', Number.MAX_SAFE_INTEGER + 1],
    ['attempts', 1.5], ['attempts', -1], ['attempts', Number.MAX_SAFE_INTEGER + 1],
    ['clientUpdatedAt', 1.5], ['clientUpdatedAt', -1], ['clientUpdatedAt', Number.MAX_SAFE_INTEGER + 1],
    ['correctMatches', 4, { attempts: 3 }],
  ];
  for (const [key, value, extra = {}] of invalid) {
    assert.equal(normalizeSyncRecord(record({ ...extra, [key]: value }), VOCABULARY), null, `${key}=${value}`);
  }
});

test('merges pair ids while taking seed and statistics from the newer record', () => {
  const local = {
    bookId: 'postgrad', scope: 'frequent', seed: 10,
    completedPairIds: ['pair-1', 'pair-2'],
    score: 100, correctMatches: 2, attempts: 3, clientUpdatedAt: 1000,
  };
  const cloud = {
    bookId: 'postgrad', scope: 'frequent', seed: 20,
    completedPairIds: ['pair-2', 'pair-3'],
    score: 180, correctMatches: 3, attempts: 5, clientUpdatedAt: 2000,
  };

  assert.deepEqual(mergeSameChallenge(local, cloud), {
    bookId: 'postgrad', scope: 'frequent', seed: 20,
    completedPairIds: ['pair-1', 'pair-2', 'pair-3'],
    score: 180, correctMatches: 3, attempts: 5, clientUpdatedAt: 2000,
  });
});

test('equal timestamps prefer cloud statistics and merge idempotently', () => {
  const local = record({ completedPairIds: ['pair-1', 'pair-3'] });
  const cloud = record({ seed: 99, completedPairIds: ['pair-2'], score: 200 });
  const merged = mergeSameChallenge(local, cloud);
  assert.equal(merged.seed, 99);
  assert.deepEqual(merged.completedPairIds, ['pair-1', 'pair-2', 'pair-3']);
  assert.deepEqual(mergeSameChallenge(merged, merged), merged);
});

test('different active books require an explicit conflict choice', () => {
  assert.equal(
    decideProgressSync(
      { bookId: 'cet4', scope: 'full', completedPairIds: [], clientUpdatedAt: 10 },
      { bookId: 'ielts', scope: 'frequent', completedPairIds: [], clientUpdatedAt: 20 },
    ).type,
    'conflict',
  );
});

test('sync decisions cover empty, local, cloud, and merge states', () => {
  assert.deepEqual(decideProgressSync(null, null), { type: 'empty', record: null });
  assert.deepEqual(decideProgressSync(record(), null), { type: 'use-local', record: record() });
  assert.deepEqual(decideProgressSync(null, record()), { type: 'use-cloud', record: record() });
  assert.equal(decideProgressSync(record(), record({ clientUpdatedAt: 2000 })).type, 'merge');
});
