import {
  GAME_CONSTANTS,
  completePendingMatch,
  createGameState,
  getTilePresentation,
  getWaveReview,
  restartGame,
  selectTile,
  startNextWave,
  tick,
  useHint,
} from './game.js?v=7';

const MATCH_ANIMATION_MS = 1_800;
const WAVE_CLEAR_MS = 650;

const board = document.querySelector('#game-board');
const playfield = document.querySelector('.playfield');
const scoreEl = document.querySelector('#score');
const waveEl = document.querySelector('#wave');
const timerEl = document.querySelector('#timer');
const timerFill = document.querySelector('#timer-fill');
const timerCard = document.querySelector('#timer-card');
const progressEl = document.querySelector('#progress');
const progressFill = document.querySelector('#progress-fill');
const comboEl = document.querySelector('#combo');
const comboChip = document.querySelector('#combo-chip');
const statusLine = document.querySelector('#status-line');
const hintButton = document.querySelector('#hint-button');
const soundButton = document.querySelector('#sound-button');
const soundLabel = document.querySelector('#sound-label');
const restartButton = document.querySelector('#restart-button');
const ratingOverlay = document.querySelector('#rating-overlay');
const ratingLabel = document.querySelector('#rating-label');
const ratingBonus = document.querySelector('#rating-bonus');
const reviewModal = document.querySelector('#review-modal');
const reviewTitle = document.querySelector('#review-title');
const reviewSummary = document.querySelector('#review-summary');
const reviewPairs = document.querySelector('#review-pairs');
const reviewExtras = document.querySelector('#review-extras');
const reviewContinue = document.querySelector('#review-continue');
const resultModal = document.querySelector('#result-modal');
const finalScore = document.querySelector('#final-score');
const finalAccuracy = document.querySelector('#final-accuracy');
const resultMessage = document.querySelector('#result-message');
const modalRestart = document.querySelector('#modal-restart');
const toastLayer = document.querySelector('#toast-layer');

let state = createGameState(Date.now());
let timerId = null;
let matchTimeout = null;
let waveClearTimeout = null;
let hintTimeout = null;
let soundOn = true;
let reviewOpen = false;
let audioContext = null;

const formatScore = (score) => String(score).padStart(4, '0');

const getStatusCopy = (currentState) => {
  if (currentState.status === 'resolving') return '配对成功，记住刚刚出现的中文释义';
  if (currentState.status === 'wave-cleared') return '本组完成，正在整理词汇回顾';
  if (currentState.status === 'wave-expired') return '时间到，先把刚才的词读一遍';
  if (currentState.status === 'complete') return '三波挑战完成，看看你的最终成绩';
  if (currentState.lastResult === 'match') return '配对成功！继续保持连击';
  if (currentState.lastResult === 'miss') return '意思不太一样，再试试别的组合';
  if (currentState.lastResult === 'unpairable') return '这个词没有同义词搭档，换一个试试';
  if (currentState.lastResult === 'hint') return '提示已亮起，找到这一对吧';
  return currentState.selectedTileId ? '再选一个意思相近的词' : '点击任意词块开始配对';
};

const showToast = (message, tone = 'neutral') => {
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  toastLayer.append(toast);
  window.setTimeout(() => toast.remove(), 2_300);
};

const playTone = (kind) => {
  if (!soundOn) return;
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) return;
  audioContext ??= new AudioContextClass();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.type = 'sine';
  oscillator.frequency.value = kind === 'match' ? 660 : kind === 'hint' ? 510 : 220;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.07, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.18);
};

const appendReviewDetails = (container, { word, phonetic, meanings }) => {
  const english = document.createElement('strong');
  english.className = 'review-english';
  english.textContent = word;
  const ipa = document.createElement('span');
  ipa.className = 'review-phonetic';
  ipa.textContent = phonetic;
  const meaningList = document.createElement('span');
  meaningList.className = 'review-meanings';
  meaningList.textContent = meanings.map((meaning) => meaning.text).join('；');
  container.append(english, ipa, meaningList);
};

const createReviewWord = (entry) => {
  const row = document.createElement('div');
  row.className = 'review-word';
  appendReviewDetails(row, entry);
  return row;
};

const renderTiles = () => {
  const fragment = document.createDocumentFragment();
  for (const tile of state.tiles) {
    const presentation = getTilePresentation(state, tile);
    const slot = document.createElement('div');
    const button = document.createElement('button');
    const isSelected = state.selectedTileId === tile.id;
    const isHinted = state.hintTileId === tile.id;
    const isWrong = state.wrongTileIds.includes(tile.id);

    slot.className = 'tile-slot';
    slot.setAttribute('role', 'gridcell');
    button.type = 'button';
    button.className = 'tile';
    if (presentation.hidden) button.classList.add('is-cleared');
    if (presentation.resolving) button.classList.add('is-resolving');
    if (isSelected) button.classList.add('is-selected');
    if (isHinted) button.classList.add('is-hint');
    if (isWrong) button.classList.add('is-wrong');
    button.dataset.tileId = tile.id;
    button.disabled = presentation.hidden || state.status !== 'playing';
    button.setAttribute('aria-pressed', String(isSelected));
    button.setAttribute('aria-label', tile.word);

    const word = document.createElement('span');
    word.className = 'tile-word';
    word.textContent = tile.word;
    button.append(word);
    slot.append(button);

    if (presentation.gloss) {
      const reveal = document.createElement('span');
      reveal.className = 'tile-reveal';
      reveal.setAttribute('role', 'status');
      reveal.textContent = presentation.gloss;
      slot.append(reveal);
    }
    fragment.append(slot);
  }
  board.replaceChildren(fragment);
};

const renderRating = () => {
  const pending = state.pendingMatch;
  const visible = state.status === 'resolving' && pending;
  ratingOverlay.hidden = !visible;
  if (!visible) return;
  ratingOverlay.dataset.rating = pending.rating;
  ratingLabel.textContent = pending.rating;
  ratingBonus.textContent = `+${pending.bonus}`;
};

const renderReview = () => {
  const visible = state.status === 'wave-cleared' && reviewOpen;
  reviewModal.hidden = !visible;
  if (!visible) return;

  const review = getWaveReview(state);
  reviewTitle.textContent = `第 ${state.wave} 波完成`;
  reviewSummary.textContent = `本波回顾 · ${review.pairs.length} 组同义词 · ${review.totalWords} 个词`;
  reviewContinue.firstChild.textContent = state.wave < state.totalWaves ? '下一波 ' : '查看总成绩 ';

  const pairFragment = document.createDocumentFragment();
  for (const pair of review.pairs) {
    const card = document.createElement('article');
    card.className = 'review-pair';
    for (const word of pair.words) card.append(createReviewWord(word));
    pairFragment.append(card);
  }
  reviewPairs.replaceChildren(pairFragment);

  const extrasFragment = document.createDocumentFragment();
  for (const entry of review.extras) {
    const card = document.createElement('article');
    card.className = 'review-extra';
    appendReviewDetails(card, entry);
    extrasFragment.append(card);
  }
  reviewExtras.replaceChildren(extrasFragment);
};

const renderResult = () => {
  const visible = state.status === 'complete' || state.status === 'wave-expired';
  resultModal.hidden = !visible;
  if (!visible) return;

  const accuracy = state.attempts ? Math.round((state.correctMatches / state.attempts) * 100) : 0;
  finalScore.textContent = formatScore(state.score);
  finalAccuracy.textContent = `${accuracy}%`;
  resultMessage.textContent = state.status === 'wave-expired'
    ? '时间管理也是考研的一部分，复盘后再来一次。'
    : accuracy >= 80
      ? '词感在线，下一组继续冲刺。'
      : '把错题再读一遍，你会更稳。';
};

const render = () => {
  const matchedCount = state.matchedPairIds.length;
  const progress = (matchedCount / GAME_CONSTANTS.PAIRS_PER_WAVE) * 100;
  const timeProgress = (state.timeLeft / GAME_CONSTANTS.ROUND_SECONDS) * 100;
  scoreEl.textContent = formatScore(state.score);
  waveEl.textContent = `第 ${state.wave} / ${state.totalWaves} 波`;
  timerEl.textContent = String(state.timeLeft).padStart(2, '0');
  timerFill.style.width = `${timeProgress}%`;
  timerCard.classList.toggle('is-warning', state.timeLeft <= 12 && state.status === 'playing');
  progressEl.textContent = `已配对 ${matchedCount} / ${GAME_CONSTANTS.PAIRS_PER_WAVE}`;
  progressFill.style.width = `${progress}%`;
  comboEl.textContent = `连击 ${state.combo}`;
  comboChip.dataset.active = String(state.combo > 0);
  statusLine.textContent = getStatusCopy(state);
  hintButton.disabled = state.status !== 'playing' || state.hintTileId !== null || state.wrongTileIds.length > 0;
  board.setAttribute('aria-busy', String(state.status !== 'playing'));
  playfield.classList.toggle('is-wave-cleared', state.status === 'wave-cleared');
  renderTiles();
  renderRating();
  renderReview();
  renderResult();
};

const stopTimer = () => {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
};

const startTimer = () => {
  stopTimer();
  if (state.status !== 'playing') return;
  timerId = window.setInterval(() => {
    state = tick(state, 1);
    render();
    if (state.status !== 'playing') stopTimer();
  }, 1_000);
};

const openWaveReview = () => {
  reviewOpen = true;
  render();
  reviewContinue.focus();
};

const scheduleMatchResolution = () => {
  stopTimer();
  if (matchTimeout !== null) window.clearTimeout(matchTimeout);
  matchTimeout = window.setTimeout(() => {
    state = completePendingMatch(state);
    render();
    if (state.status === 'playing') {
      startTimer();
      return;
    }
    if (state.status === 'wave-cleared') {
      waveClearTimeout = window.setTimeout(openWaveReview, WAVE_CLEAR_MS);
    }
  }, MATCH_ANIMATION_MS);
};

const handleTileClick = (event) => {
  const tileButton = event.target.closest('[data-tile-id]');
  if (!tileButton) return;
  state = selectTile(state, tileButton.dataset.tileId, Date.now());
  render();

  if (state.status === 'resolving') {
    playTone('match');
    scheduleMatchResolution();
  } else if (state.lastResult === 'miss') {
    playTone('miss');
  }
};

const handleHint = () => {
  const nextState = useHint(state);
  if (nextState === state) return;
  state = nextState;
  render();
  const unpairable = state.lastResult === 'unpairable';
  playTone(unpairable ? 'miss' : 'hint');
  showToast(unpairable ? '这个词无法配对，扣除 25 分' : '提示已使用，扣除 25 分', unpairable ? 'neutral' : 'hint');
  if (hintTimeout !== null) window.clearTimeout(hintTimeout);
  hintTimeout = window.setTimeout(() => {
    if (state.hintTileId !== null || state.wrongTileIds.length > 0) {
      state = { ...state, hintTileId: null, wrongTileIds: [], lastResult: null };
      render();
    }
  }, 1_800);
};

const clearScheduledWork = () => {
  for (const timeout of [matchTimeout, waveClearTimeout, hintTimeout]) {
    if (timeout !== null) window.clearTimeout(timeout);
  }
  matchTimeout = null;
  waveClearTimeout = null;
  hintTimeout = null;
};

const handleRestart = () => {
  stopTimer();
  clearScheduledWork();
  reviewOpen = false;
  state = restartGame(state);
  render();
  startTimer();
};

const handleContinue = () => {
  reviewOpen = false;
  state = startNextWave(state);
  render();
  if (state.status === 'playing') startTimer();
};

const handleSound = () => {
  soundOn = !soundOn;
  soundButton.setAttribute('aria-pressed', String(soundOn));
  soundLabel.textContent = soundOn ? '音效开' : '音效关';
  showToast(soundOn ? '音效已打开' : '音效已关闭');
};

board.addEventListener('click', handleTileClick);
hintButton.addEventListener('click', handleHint);
restartButton.addEventListener('click', handleRestart);
modalRestart.addEventListener('click', handleRestart);
reviewContinue.addEventListener('click', handleContinue);
soundButton.addEventListener('click', handleSound);

render();
startTimer();
