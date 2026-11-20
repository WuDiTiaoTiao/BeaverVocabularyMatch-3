import { getReviewMeanings, getWordSharedMeaning, resolveSharedMeaning, splitMeanings } from './meanings.js?v=32';

const ROUND_SECONDS = 60;
const GAME_MODES = Object.freeze({
  desktop: Object.freeze({
    TILES_PER_WAVE: 15,
    PAIRS_PER_WAVE: 7,
    DISTRACTORS_PER_WAVE: 1,
  }),
  phone: Object.freeze({
    TILES_PER_WAVE: 16,
    PAIRS_PER_WAVE: 8,
    DISTRACTORS_PER_WAVE: 0,
  }),
});
const DEFAULT_MODE = 'desktop';
const HINT_COST = 25;

const getModeConfig = (mode = DEFAULT_MODE) => GAME_MODES[mode] ?? GAME_MODES[DEFAULT_MODE];

const defineWord = (phonetic, ...meaningTexts) => ({
  phonetic,
  meanings: meaningTexts.map((text, index) => ({
    text,
    examFrequency: meaningTexts.length - index,
  })),
});

export const WORD_DETAILS = {
  abandon: defineWord('/əˈbændən/', 'v. 放弃；中止', 'v. 抛弃；离弃', 'n. 放任；纵情'),
  desert: defineWord('/dɪˈzɜːt; ˈdezət/', 'v. 抛弃；离弃', 'n. 沙漠；荒漠', 'v. 擅离（岗位）', 'adj. 荒凉的；无人居住的'),
  accelerate: defineWord('/əkˈseləreɪt/', 'v. 加速；促进', 'v.（车辆或人）加快速度'),
  'speed up': defineWord('/spiːd ʌp/', 'phr. 加快；使提速', 'phr. 促进；使进程更快'),
  avoid: defineWord('/əˈvɔɪd/', 'v. 避免；防止', 'v. 躲避；回避'),
  evade: defineWord('/ɪˈveɪd/', 'v. 逃避；规避', 'v. 躲开；避开', 'v. 未被（理解或记起）'),
  compare: defineWord('/kəmˈpeə(r)/', 'v. 比较；对照', 'v. 把……比作', 'v. 与……相似；媲美'),
  contrast: defineWord('/ˈkɒntrɑːst; kənˈtrɑːst/', 'n. 对比；差异', 'v. 对照；形成反差', 'n. 对照物'),
  begin: defineWord('/bɪˈɡɪn/', 'v. 开始；着手', 'v. 起初是；起源'),
  commence: defineWord('/kəˈmens/', 'v. 开始；着手', 'v. 获得学位'),
  accurate: defineWord('/ˈækjərət/', 'adj. 准确的；精确的', 'adj. 正确无误的'),
  precise: defineWord('/prɪˈsaɪs/', 'adj. 精确的；准确的', 'adj. 明确的；确切的', 'adj. 一丝不苟的'),
  demand: defineWord('/dɪˈmɑːnd/', 'n. 需求；要求', 'v. 要求；强烈要求', 'n. 所需之物；需求量'),
  require: defineWord('/rɪˈkwaɪə(r)/', 'v. 需要；要求', 'v. 规定；命令', 'v. 值得；应当'),
  select: defineWord('/sɪˈlekt/', 'v. 选择；挑选', 'adj. 精选的；优等的', 'adj. 少数人的；排外的'),
  choose: defineWord('/tʃuːz/', 'v. 选择；挑选', 'v. 宁愿；决定'),
  support: defineWord('/səˈpɔːt/', 'v. 支持；赞成', 'n. 支持；帮助', 'v. 支撑；承受', 'n. 证据；依据'),
  assist: defineWord('/əˈsɪst/', 'v. 帮助；协助', 'n. 帮助；援助'),
  preserve: defineWord('/prɪˈzɜːv/', 'v. 保护；维护', 'v. 保存；保藏', 'n. 保护区'),
  conserve: defineWord('/kənˈsɜːv/', 'v. 保护；节约', 'v. 保存；保藏', 'n. 蜜饯；果酱'),
  expand: defineWord('/ɪkˈspænd/', 'v. 扩大；扩展', 'v. 详述；展开', 'v. 膨胀；扩张'),
  extend: defineWord('/ɪkˈstend/', 'v. 延伸；扩大', 'v. 延长；延期', 'v. 提供；给予', 'v. 伸展；展开'),
  essential: defineWord('/ɪˈsenʃl/', 'adj. 必不可少的；必要的', 'n. 要素；必需品', 'adj. 本质的；基本的'),
  vital: defineWord('/ˈvaɪtl/', 'adj. 至关重要的；必不可少的', 'adj. 充满活力的', 'adj. 生命的；维持生命的'),
  exercise: defineWord('/ˈeksəsaɪz/', 'n. 锻炼；运动', 'v. 行使；运用', 'n. 练习；训练', 'v. 使担忧；使烦恼'),
  trigger: defineWord('/ˈtrɪɡə(r)/', 'v. 引发；触发', 'n. 起因；诱因', 'n. 扳机'),
  record: defineWord('/ˈrekɔːd; rɪˈkɔːd/', 'n. 记录；记载', 'v. 记录；录制', 'n. 履历；档案', 'n. 最高纪录'),
  root: defineWord('/ruːt/', 'n. 根；根源', 'v. 生根；扎根', 'n. 词根；字根', 'v. 翻找；搜寻'),
  subdivide: defineWord('/ˌsʌbdɪˈvaɪd/', 'v. 再分；细分', 'v. 将土地分块'),
  policy: defineWord('/ˈpɒləsi/', 'n. 政策；方针', 'n. 原则；策略', 'n. 保险单'),
  outcome: defineWord('/ˈaʊtkʌm/', 'n. 结果；后果', 'n. 成果；结局'),
  feature: defineWord('/ˈfiːtʃə(r)/', 'n. 特征；特点', 'v. 以……为特色', 'n. 专题节目；特写', 'n. 面容的一部分；五官'),
  region: defineWord('/ˈriːdʒən/', 'n. 地区；区域', 'n.（身体）部位', 'n. 范围；领域'),
  maintain: defineWord('/meɪnˈteɪn/', 'v. 维持；保持', 'v. 坚称；主张', 'v. 维修；保养', 'v. 供养；负担生活'),
};

export const SYNONYM_BANK = [
  { pairId: 'abandon', words: ['abandon', 'desert'], sharedMeaning: { text: '抛弃；离弃', pos: 'v' } },
  { pairId: 'accelerate', words: ['accelerate', 'speed up'], sharedMeaning: { text: '加快；加速', pos: 'v' } },
  { pairId: 'avoid', words: ['avoid', 'evade'], sharedMeaning: { text: '躲避；避开', pos: 'v' } },
  { pairId: 'compare', words: ['compare', 'contrast'], sharedMeaning: { text: '比较；对照', pos: 'v' } },
  { pairId: 'begin', words: ['begin', 'commence'], sharedMeaning: { text: '开始；着手', pos: 'v' } },
  { pairId: 'accurate', words: ['accurate', 'precise'], sharedMeaning: { text: '准确的；精确的', pos: 'a' } },
  { pairId: 'demand', words: ['demand', 'require'], sharedMeaning: { text: '要求', pos: 'v' } },
  { pairId: 'select', words: ['select', 'choose'], sharedMeaning: { text: '选择；挑选', pos: 'v' } },
  { pairId: 'support', words: ['support', 'assist'], sharedMeaning: { text: '帮助；协助', pos: 'v' } },
  { pairId: 'preserve', words: ['preserve', 'conserve'], sharedMeaning: { text: '保存；保藏', pos: 'v' } },
  { pairId: 'expand', words: ['expand', 'extend'], sharedMeaning: { text: '扩大；扩展', pos: 'v' } },
  { pairId: 'essential', words: ['essential', 'vital'], sharedMeaning: { text: '必不可少的；必要的', pos: 'a' } },
];

const DISTRACTORS = [
  'exercise',
  'trigger',
  'record',
  'root',
  'subdivide',
  'policy',
  'outcome',
  'feature',
  'region',
  'maintain',
];

const DEFAULT_VOCABULARY = {
  bookId: 'postgrad',
  scope: 'frequent',
  label: '考研 · 高频词库',
  totalWords: Object.keys(WORD_DETAILS).length,
  entries: WORD_DETAILS,
  pairs: SYNONYM_BANK,
  distractors: DISTRACTORS,
};

const getWordEntry = (word, vocabulary) => {
  const details = vocabulary.entries[word];
  return {
    word,
    phonetic: details.phonetic,
    meanings: splitMeanings(details.meanings),
    gloss: splitMeanings(details.meanings)[0].text,
  };
};

const clone = (state, changes = {}) => ({
  ...state,
  ...changes,
  tiles: changes.tiles ?? state.tiles.map((tile) => ({ ...tile })),
  matchedPairIds: changes.matchedPairIds ?? [...state.matchedPairIds],
  completedBookPairIds: changes.completedBookPairIds ?? [...state.completedBookPairIds],
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

const selectUniqueWordPairs = (candidates, limit, seed, usedWords) => {
  if (limit <= 0) return [];
  const selected = [];
  for (const pair of shuffle(candidates, seed)) {
    if (pair.words.some((word) => usedWords.has(word))) continue;
    selected.push(pair);
    pair.words.forEach((word) => usedWords.add(word));
    if (selected.length === limit) break;
  }
  return selected;
};

const assemblePairSelection = (progressCandidates, fillerCandidates, progressLimit, seed, pairsPerWave) => {
  const fillerLimit = pairsPerWave - progressLimit;
  let best = { progressPairs: [], fillerPairs: [] };

  for (let attempt = 0; attempt < 64; attempt += 1) {
    const usedWords = new Set();
    const fillerFirst = attempt % 2 === 0;
    let progressPairs;
    let fillerPairs;

    if (fillerFirst) {
      fillerPairs = selectUniqueWordPairs(fillerCandidates, fillerLimit, seed + attempt * 37, usedWords);
      progressPairs = selectUniqueWordPairs(progressCandidates, progressLimit, seed + attempt * 53 + 1, usedWords);
    } else {
      progressPairs = selectUniqueWordPairs(progressCandidates, progressLimit, seed + attempt * 53, usedWords);
      fillerPairs = selectUniqueWordPairs(fillerCandidates, fillerLimit, seed + attempt * 37 + 1, usedWords);
    }

    if (progressPairs.length + fillerPairs.length > best.progressPairs.length + best.fillerPairs.length) {
      best = { progressPairs, fillerPairs };
    }
    if (progressPairs.length === progressLimit && fillerPairs.length === fillerLimit) {
      return { progressPairs, fillerPairs };
    }
  }

  return best;
};

const pickPairs = (seed, vocabulary, completedBookPairIds, mode = DEFAULT_MODE) => {
  const { PAIRS_PER_WAVE } = getModeConfig(mode);
  const completedIds = new Set(completedBookPairIds);
  const progressCandidates = vocabulary.pairs.filter((pair) => !completedIds.has(pair.pairId));
  const fillerCandidates = vocabulary.pairs.filter((pair) => completedIds.has(pair.pairId));
  const partialChallengePairs = completedIds.size % PAIRS_PER_WAVE;
  const openProgressSlots = partialChallengePairs === 0
    ? PAIRS_PER_WAVE
    : PAIRS_PER_WAVE - partialChallengePairs;
  const progressLimit = Math.min(openProgressSlots, progressCandidates.length);
  const { progressPairs, fillerPairs } = assemblePairSelection(
    progressCandidates,
    fillerCandidates,
    progressLimit,
    seed,
    PAIRS_PER_WAVE,
  );
  return [
    ...progressPairs.map((pair) => ({ ...pair, countsForBookProgress: true })),
    ...fillerPairs.map((pair) => ({ ...pair, countsForBookProgress: false })),
  ];
};

const buildTiles = (wave, seed, vocabulary, completedBookPairIds, mode = DEFAULT_MODE) => {
  const { DISTRACTORS_PER_WAVE } = getModeConfig(mode);
  const selectedPairs = pickPairs(seed, vocabulary, completedBookPairIds, mode);
  const pairedTiles = selectedPairs.flatMap((pair) =>
    pair.words.map((word, variant) => ({
      id: `${pair.pairId}-${variant}`,
      ...getWordEntry(word, vocabulary),
      sharedMeaning: resolveSharedMeaning(pair, vocabulary.entries),
      pairId: pair.pairId,
      distractor: false,
      countsForBookProgress: pair.countsForBookProgress,
    })),
  );
  const usedWords = new Set(pairedTiles.map((tile) => tile.word));
  const distractors = shuffle(vocabulary.distractors, seed + 17)
    .filter((word) => !usedWords.has(word))
    .slice(0, DISTRACTORS_PER_WAVE)
    .map((word, index) => ({
      id: `distractor-${wave}-${index}`,
      ...getWordEntry(word, vocabulary),
      pairId: `distractor-${wave}-${index}`,
      distractor: true,
      countsForBookProgress: false,
    }));

  return shuffle([...pairedTiles, ...distractors], seed + 31);
};

export const getPerformanceRating = (durationMs) => {
  const label = durationMs <= 1_000
    ? 'UNBELIEVABLE'
    : durationMs <= 3_000
      ? 'AMAZING'
      : durationMs <= 5_000
        ? 'EXCELLENT'
        : durationMs <= 8_000
          ? 'PERFECT'
          : 'GOOD';
  const bonus = durationMs <= 2_000 ? 100 : durationMs <= 4_000 ? 70 : 40;
  return { label, bonus };
};

const RATING_PRESENTATIONS = {
  UNBELIEVABLE: { label: 'Unbelievable!', asset: 'unbelievable' },
  AMAZING: { label: 'Amazing!', asset: 'amazing' },
  EXCELLENT: { label: 'Excellent!', asset: 'excellent' },
  PERFECT: { label: 'Perfect!', asset: 'perfect' },
  GOOD: { label: 'Good!', asset: 'good' },
};

export const getRatingPresentation = (rating) => RATING_PRESENTATIONS[rating]
  ?? { label: typeof rating === 'string' ? rating : '', asset: null };

export const createGameState = (
  seed = Date.now(),
  wave = 1,
  score = 0,
  vocabulary = DEFAULT_VOCABULARY,
  completedBookPairIds = [],
  sessionStats = {},
  options = {},
) => {
  const mode = GAME_MODES[options.mode] ? options.mode : DEFAULT_MODE;
  const modeConfig = getModeConfig(mode);
  const validPairIds = new Set(vocabulary.pairs.map((pair) => pair.pairId));
  const normalizedCompletedIds = [...new Set(completedBookPairIds)].filter((pairId) => validPairIds.has(pairId));
  const totalWaves = Math.ceil(vocabulary.pairs.length / modeConfig.PAIRS_PER_WAVE);
  return {
    seed,
    wave,
    totalWaves,
    vocabulary,
    bookId: vocabulary.bookId,
    scope: vocabulary.scope,
    mode,
    vocabularyLabel: vocabulary.label,
    vocabularyWordCount: vocabulary.totalWords,
    tiles: buildTiles(wave, seed, vocabulary, normalizedCompletedIds, mode),
    matchedPairIds: [],
    completedBookPairIds: normalizedCompletedIds,
    selectedTileId: null,
    selectedAtMs: null,
    pendingMatch: null,
    hintTileId: null,
    wrongTileIds: [],
    lastResult: null,
    score,
    combo: 0,
    correctMatches: Math.max(0, sessionStats.correctMatches ?? 0),
    attempts: Math.max(0, sessionStats.attempts ?? 0),
    timeLeft: ROUND_SECONDS,
    status: normalizedCompletedIds.length >= vocabulary.pairs.length ? 'complete' : 'playing',
  };
};

export const getChallengeProgress = (state) => {
  const { PAIRS_PER_WAVE } = getModeConfig(state.mode);
  const totalPairs = state.vocabulary.pairs.length;
  const completedPairs = Math.min(totalPairs, new Set(state.completedBookPairIds).size);
  const totalChallenges = Math.ceil(totalPairs / PAIRS_PER_WAVE);
  return {
    completedPairs,
    totalPairs,
    completedChallenges: completedPairs === totalPairs
      ? totalChallenges
      : Math.floor(completedPairs / PAIRS_PER_WAVE),
    totalChallenges,
  };
};

export const selectTile = (state, tileId, nowMs = Date.now()) => {
  if (state.status !== 'playing') return state;
  const tile = state.tiles.find((candidate) => candidate.id === tileId);
  if (!tile || state.matchedPairIds.includes(tile.pairId)) return state;

  if (state.selectedTileId === null) {
    const hintedCounterpart = state.hintTileId === tileId
      ? state.tiles.find((candidate) => candidate.pairId === tile.pairId && candidate.id !== tileId)?.id ?? null
      : null;
    return clone(state, {
      selectedTileId: tileId,
      selectedAtMs: nowMs,
      hintTileId: hintedCounterpart,
      wrongTileIds: [],
      lastResult: null,
    });
  }

  if (state.selectedTileId === tileId) {
    return clone(state, { selectedTileId: null, selectedAtMs: null, hintTileId: null });
  }

  const selectedTile = state.tiles.find((candidate) => candidate.id === state.selectedTileId);
  const isMatch = selectedTile && !selectedTile.distractor && !tile.distractor && selectedTile.pairId === tile.pairId;
  const attempts = state.attempts + 1;

  if (isMatch) {
    const durationMs = Math.max(0, nowMs - (state.selectedAtMs ?? nowMs));
    const rating = getPerformanceRating(durationMs);
    const combo = state.combo + 1;
    return clone(state, {
      selectedTileId: null,
      selectedAtMs: null,
      pendingMatch: {
        pairId: tile.pairId,
        tileIds: [state.selectedTileId, tileId],
        rating: rating.label,
        bonus: rating.bonus,
        durationMs,
      },
      hintTileId: null,
      wrongTileIds: [],
      lastResult: 'match',
      score: state.score + rating.bonus,
      combo,
      attempts,
      status: 'resolving',
    });
  }

  return clone(state, {
    selectedTileId: null,
    selectedAtMs: null,
    hintTileId: null,
    wrongTileIds: [state.selectedTileId, tileId],
    lastResult: 'miss',
    combo: 0,
    attempts,
  });
};

export const completePendingMatch = (state) => {
  const { PAIRS_PER_WAVE } = getModeConfig(state.mode);
  if (state.status !== 'resolving' || !state.pendingMatch) return state;
  const matchedPairIds = [...state.matchedPairIds, state.pendingMatch.pairId];
  const matchedTile = state.tiles.find((tile) => tile.pairId === state.pendingMatch.pairId);
  const completedBookPairIds = matchedTile?.countsForBookProgress
    ? [...new Set([...state.completedBookPairIds, state.pendingMatch.pairId])]
    : state.completedBookPairIds;
  return clone(state, {
    matchedPairIds,
    completedBookPairIds,
    pendingMatch: null,
    correctMatches: state.correctMatches + 1,
    status: matchedPairIds.length === PAIRS_PER_WAVE ? 'wave-cleared' : 'playing',
  });
};

export const getWaveReview = (state) => {
  const pairMap = new Map();
  const extras = [];

  for (const tile of state.tiles) {
    const entry = {
      word: tile.word,
      gloss: tile.gloss,
      phonetic: tile.phonetic,
      meanings: getReviewMeanings(tile.meanings, tile.sharedMeaning),
    };
    if (tile.distractor) {
      extras.push(entry);
      continue;
    }
    const pair = pairMap.get(tile.pairId) ?? { pairId: tile.pairId, words: [] };
    pair.words.push(entry);
    pairMap.set(tile.pairId, pair);
  }

  const pairs = [...pairMap.values()];
  return {
    pairs,
    extras,
    allWords: [...pairs.flatMap((pair) => pair.words), ...extras],
    totalWords: state.tiles.length,
  };
};

export const getTilePresentation = (state, tile) => {
  const resolving = state.pendingMatch?.tileIds.includes(tile.id) ?? false;
  return {
    hidden: state.matchedPairIds.includes(tile.pairId),
    resolving,
    gloss: resolving ? getWordSharedMeaning(tile.meanings, tile.sharedMeaning)?.text ?? null : null,
  };
};

export const useHint = (state) => {
  if (state.status !== 'playing') return state;
  const selectedTile = state.tiles.find((tile) => tile.id === state.selectedTileId);
  if (selectedTile?.distractor) {
    return clone(state, {
      selectedTileId: null,
      selectedAtMs: null,
      hintTileId: null,
      wrongTileIds: [selectedTile.id],
      score: Math.max(0, state.score - HINT_COST),
      lastResult: 'unpairable',
    });
  }
  const validTile = state.tiles.find(
    (tile) => !tile.distractor && !state.matchedPairIds.includes(tile.pairId),
  );
  const targetTile = selectedTile && !selectedTile.distractor
    ? state.tiles.find((tile) => tile.pairId === selectedTile.pairId && tile.id !== selectedTile.id)
    : validTile;
  if (!targetTile) return state;
  return clone(state, {
    hintTileId: targetTile.id,
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
  const progress = getChallengeProgress(state);
  if (progress.completedPairs >= progress.totalPairs) return clone(state, { status: 'complete' });
  return {
    ...createGameState(
      state.seed + state.wave * 101,
      state.wave + 1,
      state.score,
      state.vocabulary,
      state.completedBookPairIds,
      { correctMatches: state.correctMatches, attempts: state.attempts },
      { mode: state.mode },
    ),
  };
};

export const restartGame = (state) => {
  const progress = getChallengeProgress(state);
  const wave = Math.min(progress.totalChallenges, progress.completedChallenges + 1);
  return createGameState(
    state.seed,
    wave,
    state.score,
    state.vocabulary,
    state.completedBookPairIds,
    { correctMatches: state.correctMatches, attempts: state.attempts },
    { mode: state.mode },
  );
};

export const getGameModeConfig = (mode) => ({ ...getModeConfig(mode) });

export const GAME_CONSTANTS = {
  ROUND_SECONDS,
  ...GAME_MODES.desktop,
  HINT_COST,
};
