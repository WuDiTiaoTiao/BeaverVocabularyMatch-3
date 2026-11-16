const ROUND_SECONDS = 30;
const TOTAL_WAVES = 3;
const PAIRS_PER_WAVE = 5;
const HINT_COST = 25;

export const SYNONYM_BANK = [
  { pairId: 'abandon', words: [['abandon', '放弃'], ['desert', '遗弃']] },
  { pairId: 'accelerate', words: [['accelerate', '加速'], ['speed up', '提速']] },
  { pairId: 'avoid', words: [['avoid', '避免'], ['evade', '逃避']] },
  { pairId: 'compare', words: [['compare', '比较'], ['contrast', '对比']] },
  { pairId: 'begin', words: [['begin', '开始'], ['commence', '着手']] },
  { pairId: 'accurate', words: [['accurate', '准确的'], ['precise', '精确的']] },
  { pairId: 'demand', words: [['demand', '要求'], ['require', '需要']] },
  { pairId: 'select', words: [['select', '选择'], ['choose', '挑选']] },
  { pairId: 'support', words: [['support', '支持'], ['assist', '协助']] },
  { pairId: 'preserve', words: [['preserve', '保护'], ['conserve', '保存']] },
  { pairId: 'expand', words: [['expand', '扩大'], ['extend', '延伸']] },
  { pairId: 'essential', words: [['essential', '必要的'], ['vital', '至关重要的']] },
];

const DISTRACTORS = [
  ['exercise', '练习'],
  ['trigger', '触发'],
  ['record', '记录'],
  ['root', '根源'],
  ['subdivide', '细分'],
  ['policy', '政策'],
  ['outcome', '结果'],
  ['feature', '特征'],
  ['region', '地区'],
  ['maintain', '维持'],
];

const clone = (state, changes = {}) => ({
  ...state,
  ...changes,
  tiles: changes.tiles ?? state.tiles.map((tile) => ({ ...tile })),
  matchedPairIds: changes.matchedPairIds ?? [...state.matchedPairIds],
  wrongTileIds: changes.wrongTileIds ?? [...state.wrongTileIds],
});

const seededRandom = (seed) => {
  let value = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffle = (items, seed) => {
  const random = seededRandom(seed);
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
};

const pickPairs = (wave, seed) => {
  const start = ((wave - 1) * PAIRS_PER_WAVE) % SYNONYM_BANK.length;
  const ordered = Array.from({ length: SYNONYM_BANK.length }, (_, offset) =>
    SYNONYM_BANK[(start + offset) % SYNONYM_BANK.length],
  );
  return shuffle(ordered, seed).slice(0, PAIRS_PER_WAVE);
};

const buildTiles = (wave, seed) => {
  const selectedPairs = pickPairs(wave, seed);
  const pairedTiles = selectedPairs.flatMap((pair) =>
    pair.words.map(([word, gloss], variant) => ({
      id: `${pair.pairId}-${variant}`,
      word,
      gloss,
      pairId: pair.pairId,
      distractor: false,
    })),
  );
  const usedWords = new Set(pairedTiles.map((tile) => tile.word));
  const distractors = shuffle(DISTRACTORS, seed + 17)
    .filter(([word]) => !usedWords.has(word))
    .slice(0, PAIRS_PER_WAVE)
    .map(([word, gloss], index) => ({
      id: `distractor-${wave}-${index}`,
      word,
      gloss,
      pairId: `distractor-${wave}-${index}`,
      distractor: true,
    }));

  return shuffle([...pairedTiles, ...distractors], seed + 31);
};

export const createGameState = (seed = Date.now(), wave = 1, score = 0) => ({
  seed,
  wave,
  totalWaves: TOTAL_WAVES,
  tiles: buildTiles(wave, seed),
  matchedPairIds: [],
  selectedTileId: null,
  hintPairId: null,
  wrongTileIds: [],
  lastResult: null,
  score,
  combo: 0,
  correctMatches: 0,
  attempts: 0,
  timeLeft: ROUND_SECONDS,
  status: 'playing',
});

export const selectTile = (state, tileId) => {
  if (state.status !== 'playing') return state;
  const tile = state.tiles.find((candidate) => candidate.id === tileId);
  if (!tile || state.matchedPairIds.includes(tile.pairId)) return state;

  if (state.selectedTileId === null) {
    return clone(state, {
      selectedTileId: tileId,
      hintPairId: null,
      wrongTileIds: [],
      lastResult: null,
    });
  }

  if (state.selectedTileId === tileId) {
    return clone(state, { selectedTileId: null });
  }

  const selectedTile = state.tiles.find((candidate) => candidate.id === state.selectedTileId);
  const isMatch = selectedTile && !selectedTile.distractor && !tile.distractor && selectedTile.pairId === tile.pairId;
  const attempts = state.attempts + 1;

  if (isMatch) {
    const matchedPairIds = [...state.matchedPairIds, tile.pairId];
    const combo = state.combo + 1;
    const score = state.score + 100 + combo * 25;
    const allPairsMatched = matchedPairIds.length === PAIRS_PER_WAVE;
    return clone(state, {
      selectedTileId: null,
      matchedPairIds,
      hintPairId: null,
      wrongTileIds: [],
      lastResult: 'match',
      score,
      combo,
      correctMatches: state.correctMatches + 1,
      attempts,
      status: allPairsMatched ? 'wave-cleared' : 'playing',
    });
  }

  return clone(state, {
    selectedTileId: null,
    hintPairId: null,
    wrongTileIds: [state.selectedTileId, tileId],
    lastResult: 'miss',
    combo: 0,
    attempts,
  });
};

export const useHint = (state) => {
  if (state.status !== 'playing') return state;
  const validPair = state.tiles.find(
    (tile) => !tile.distractor && !state.matchedPairIds.includes(tile.pairId),
  )?.pairId ?? null;
  if (!validPair) return state;
  return clone(state, {
    selectedTileId: null,
    hintPairId: validPair,
    score: Math.max(0, state.score - HINT_COST),
    lastResult: 'hint',
  });
};

export const tick = (state, seconds = 1) => {
  if (state.status !== 'playing') return state;
  const timeLeft = Math.max(0, state.timeLeft - seconds);
  return clone(state, {
    timeLeft,
    status: timeLeft === 0 ? 'wave-expired' : state.status,
    selectedTileId: timeLeft === 0 ? null : state.selectedTileId,
    lastResult: timeLeft === 0 ? 'expired' : state.lastResult,
  });
};

export const startNextWave = (state) => {
  if (state.status !== 'wave-cleared') return state;
  if (state.wave >= TOTAL_WAVES) return clone(state, { status: 'complete' });
  return {
    ...createGameState(state.seed + state.wave * 101, state.wave + 1, state.score),
    correctMatches: state.correctMatches,
    attempts: state.attempts,
  };
};

export const restartGame = (state) => createGameState(state.seed);

export const GAME_CONSTANTS = {
  ROUND_SECONDS,
  TOTAL_WAVES,
  PAIRS_PER_WAVE,
  HINT_COST,
};
