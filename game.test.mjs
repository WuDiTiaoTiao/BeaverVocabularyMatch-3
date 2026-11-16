import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completePendingMatch,
  createGameState,
  getPerformanceRating,
  getTilePresentation,
  getWaveReview,
  restartGame,
  selectTile,
  startNextWave,
  tick,
  useHint,
} from './game.js';

const TEST_VOCABULARY = {
  bookId: 'ielts',
  scope: 'full',
  label: '雅思 · 完整词库',
  totalWords: 18,
  entries: Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => {
      const word = `ielts-word-${index + 1}`;
      return [word, {
        phonetic: `/test-${index + 1}/`,
        meanings: [{ text: `释义 ${index + 1}`, examFrequency: 1 }],
      }];
    }),
  ),
  pairs: Array.from({ length: 7 }, (_, index) => ({
    pairId: `ielts-pair-${index + 1}`,
    words: [`ielts-word-${index * 2 + 1}`, `ielts-word-${index * 2 + 2}`],
  })),
  distractors: ['ielts-word-15', 'ielts-word-16', 'ielts-word-17', 'ielts-word-18'],
};

test('creates fifteen tiles with twelve matchable words and three distractors', () => {
  const state = createGameState(7);
  assert.equal(state.tiles.length, 15);
  assert.equal(state.tiles.filter((tile) => !tile.distractor).length, 12);
  assert.equal(state.tiles.filter((tile) => tile.distractor).length, 3);
  assert.equal(new Set(state.tiles.filter((tile) => !tile.distractor).map((tile) => tile.pairId)).size, 6);
});

test('creates every tile from the selected vocabulary book', () => {
  const state = createGameState(7, 1, 0, TEST_VOCABULARY);

  assert.equal(state.bookId, 'ielts');
  assert.equal(state.scope, 'full');
  assert.equal(state.vocabularyLabel, '雅思 · 完整词库');
  assert.equal(state.vocabularyWordCount, 18);
  assert.equal(state.tiles.length, 15);
  assert.equal(state.tiles.every((tile) => tile.word.startsWith('ielts-word-')), true);
});

test('keeps the selected vocabulary through the next wave and restart', () => {
  const state = createGameState(7, 1, 80, TEST_VOCABULARY);
  const cleared = {
    ...state,
    status: 'wave-cleared',
    matchedPairIds: state.tiles.filter((tile) => !tile.distractor).map((tile) => tile.pairId),
  };

  const nextWave = startNextWave(cleared);
  const restarted = restartGame(nextWave);

  assert.equal(nextWave.bookId, 'ielts');
  assert.equal(nextWave.scope, 'full');
  assert.equal(nextWave.tiles.every((tile) => tile.word.startsWith('ielts-word-')), true);
  assert.equal(restarted.bookId, 'ielts');
  assert.equal(restarted.scope, 'full');
  assert.equal(restarted.tiles.every((tile) => tile.word.startsWith('ielts-word-')), true);
});

test('a round starts with sixty seconds and expires at zero', () => {
  const state = createGameState(7);
  assert.equal(state.timeLeft, 60);
  const expired = tick(state, 61);
  assert.equal(expired.timeLeft, 0);
  assert.equal(expired.status, 'wave-expired');
});

test('a correct pair enters a resolving phase before it is cleared', () => {
  const state = createGameState(7);
  const pair = state.tiles.find((tile) => !tile.distractor).pairId;
  const ids = state.tiles.filter((tile) => tile.pairId === pair).map((tile) => tile.id);
  const afterFirst = selectTile(state, ids[0], 1_000);
  const resolving = selectTile(afterFirst, ids[1], 2_500);

  assert.equal(resolving.status, 'resolving');
  assert.equal(resolving.matchedPairIds.includes(pair), false);
  assert.deepEqual(resolving.pendingMatch, {
    pairId: pair,
    tileIds: ids,
    rating: 'PERFECT',
    bonus: 100,
    durationMs: 1_500,
  });

  const cleared = completePendingMatch(resolving);
  assert.equal(cleared.status, 'playing');
  assert.equal(cleared.matchedPairIds.includes(pair), true);
  assert.equal(cleared.score, 100);
});

test('performance rating uses the reference timing tiers', () => {
  assert.deepEqual(getPerformanceRating(2_000), { label: 'PERFECT', bonus: 100 });
  assert.deepEqual(getPerformanceRating(2_001), { label: 'GREAT', bonus: 70 });
  assert.deepEqual(getPerformanceRating(4_000), { label: 'GREAT', bonus: 70 });
  assert.deepEqual(getPerformanceRating(4_001), { label: 'GOOD', bonus: 40 });
});

test('tile presentation hides gloss until the matching animation', () => {
  const state = createGameState(7);
  const pairId = state.tiles.find((tile) => !tile.distractor).pairId;
  const pairTiles = state.tiles.filter((tile) => tile.pairId === pairId);
  assert.deepEqual(getTilePresentation(state, pairTiles[0]), {
    hidden: false,
    resolving: false,
    gloss: null,
  });

  const selected = selectTile(state, pairTiles[0].id, 1_000);
  const resolving = selectTile(selected, pairTiles[1].id, 1_800);
  assert.deepEqual(getTilePresentation(resolving, pairTiles[0]), {
    hidden: false,
    resolving: true,
    gloss: pairTiles[0].gloss,
  });

  const cleared = completePendingMatch(resolving);
  assert.deepEqual(getTilePresentation(cleared, pairTiles[0]), {
    hidden: true,
    resolving: false,
    gloss: null,
  });
});

test('hint preserves a selected word and highlights only its counterpart', () => {
  const state = createGameState(7, 1, 100);
  const pairId = state.tiles.find((tile) => !tile.distractor).pairId;
  const pairTiles = state.tiles.filter((tile) => tile.pairId === pairId);
  const selected = selectTile(state, pairTiles[0].id, 1_000);
  const hinted = useHint(selected);

  assert.equal(hinted.selectedTileId, pairTiles[0].id);
  assert.equal(hinted.hintTileId, pairTiles[1].id);
  assert.equal(hinted.tiles.length, 15);
  assert.equal(hinted.score < state.score, true);

  const resolving = selectTile(hinted, pairTiles[1].id, 1_600);
  assert.equal(resolving.status, 'resolving');
  assert.equal(resolving.hintTileId, null);
});

test('hint marks a selected distractor wrong without showing a yellow target', () => {
  const state = createGameState(7, 1, 100);
  const distractor = state.tiles.find((tile) => tile.distractor);
  const selected = selectTile(state, distractor.id, 1_000);
  const hinted = useHint(selected);

  assert.equal(hinted.selectedTileId, null);
  assert.equal(hinted.hintTileId, null);
  assert.deepEqual(hinted.wrongTileIds, [distractor.id]);
  assert.equal(hinted.lastResult, 'unpairable');
  assert.equal(hinted.score, 75);
});

test('wave review includes phonetics and frequency-ordered meanings for all fifteen words', () => {
  const state = createGameState(7);
  const review = getWaveReview(state);
  assert.equal(review.totalWords, 15);
  assert.equal(review.pairs.length, 6);
  assert.equal(review.extras.length, 3);
  assert.equal(review.pairs.every((pair) => pair.words.length === 2), true);
  assert.equal(review.allWords.every((entry) => entry.word && entry.phonetic), true);
  assert.equal(review.allWords.every((entry) => entry.meanings.length >= 2), true);
  assert.equal(review.allWords.every((entry) => entry.gloss === entry.meanings[0].text), true);
  assert.equal(review.allWords.every((entry) => entry.meanings.every(
    (meaning, index, meanings) => index === 0 || meanings[index - 1].examFrequency >= meaning.examFrequency,
  )), true);
});

test('clearing the sixth pair completes the wave', () => {
  const state = createGameState(7);
  const pairIds = [...new Set(state.tiles.filter((tile) => !tile.distractor).map((tile) => tile.pairId))];
  const finalPairId = pairIds.at(-1);
  const ids = state.tiles.filter((tile) => tile.pairId === finalPairId).map((tile) => tile.id);
  const almostDone = { ...state, matchedPairIds: pairIds.slice(0, -1) };
  const selected = selectTile(almostDone, ids[0], 10_000);
  const resolving = selectTile(selected, ids[1], 11_000);
  const completed = completePendingMatch(resolving);

  assert.equal(completed.status, 'wave-cleared');
  assert.equal(completed.matchedPairIds.length, 6);
});
