import {
  GAME_CONSTANTS,
  createGameState,
  restartGame,
  selectTile,
  startNextWave,
  tick,
  useHint,
} from './game.js';

const board = document.querySelector('#game-board');
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
const resultModal = document.querySelector('#result-modal');
const finalScore = document.querySelector('#final-score');
const finalAccuracy = document.querySelector('#final-accuracy');
const resultMessage = document.querySelector('#result-message');
const modalRestart = document.querySelector('#modal-restart');
const toastLayer = document.querySelector('#toast-layer');

let state = createGameState(Date.now());
let timerId = null;
let advanceTimeout = null;
let hintTimeout = null;
let soundOn = true;
let audioContext = null;

const formatScore = (score) => String(score).padStart(4, '0');

const getStatusCopy = (currentState) => {
  if (currentState.status === 'wave-cleared') return '这一波配对完成，准备进入下一波';
  if (currentState.status === 'wave-expired') return '时间到，先把刚才的词读一遍';
  if (currentState.status === 'complete') return '三波挑战完成，看看你的最终成绩';
  if (currentState.lastResult === 'match') return '配对成功！继续保持连击';
  if (currentState.lastResult === 'miss') return '意思不太一样，再试试别的组合';
  if (currentState.lastResult === 'hint') return '提示已亮起，找到这一对吧';
  return currentState.selectedTileId ? '再选一个意思相近的词' : '点击任意词块开始配对';
};

const showToast = (message, tone = 'neutral') => {
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  toastLayer.append(toast);
  window.setTimeout(() => toast.remove(), 2300);
};

const playTone = (kind) => {
  if (!soundOn) return;
  audioContext ??= new AudioContext();
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

const renderTiles = () => {
  const fragment = document.createDocumentFragment();
  for (const tile of state.tiles) {
    const button = document.createElement('button');
    const isMatched = state.matchedPairIds.includes(tile.pairId);
    const isSelected = state.selectedTileId === tile.id;
    const isHinted = state.hintPairId === tile.pairId;
    const isWrong = state.wrongTileIds.includes(tile.id);
    button.type = 'button';
    button.className = 'tile';
    if (isMatched) button.classList.add('is-matched');
    if (isSelected) button.classList.add('is-selected');
    if (isHinted) button.classList.add('is-hint');
    if (isWrong) button.classList.add('is-wrong');
    button.dataset.tileId = tile.id;
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-pressed', String(isSelected));
    button.setAttribute('aria-label', `${tile.word}，${tile.gloss}`);
    const word = document.createElement('span');
    word.className = 'tile-word';
    word.textContent = tile.word;
    const gloss = document.createElement('span');
    gloss.className = 'tile-gloss';
    gloss.textContent = tile.gloss;
    button.append(word, gloss);
    fragment.append(button);
  }
  board.replaceChildren(fragment);
};

const render = () => {
  const matchedCount = state.matchedPairIds.length;
  const progress = (matchedCount / GAME_CONSTANTS.PAIRS_PER_WAVE) * 100;
  const timeProgress = (state.timeLeft / GAME_CONSTANTS.ROUND_SECONDS) * 100;
  scoreEl.textContent = formatScore(state.score);
  waveEl.textContent = `第 ${state.wave} / ${state.totalWaves} 波`;
  timerEl.textContent = String(state.timeLeft).padStart(2, '0');
  timerFill.style.width = `${timeProgress}%`;
  timerCard.classList.toggle('is-warning', state.timeLeft <= 8 && state.status === 'playing');
  progressEl.textContent = `已配对 ${matchedCount} / ${GAME_CONSTANTS.PAIRS_PER_WAVE}`;
  progressFill.style.width = `${progress}%`;
  comboEl.textContent = `连击 ${state.combo}`;
  comboChip.dataset.active = String(state.combo > 0);
  statusLine.textContent = getStatusCopy(state);
  hintButton.disabled = state.status !== 'playing' || state.hintPairId !== null;
  board.setAttribute('aria-busy', String(state.status !== 'playing'));
  renderTiles();

  const showResult = state.status === 'complete' || state.status === 'wave-expired';
  resultModal.hidden = !showResult;
  if (showResult) {
    const accuracy = state.attempts ? Math.round((state.correctMatches / state.attempts) * 100) : 0;
    finalScore.textContent = formatScore(state.score);
    finalAccuracy.textContent = `${accuracy}%`;
    resultMessage.textContent = state.status === 'wave-expired'
      ? '时间管理也是考研的一部分，复盘后再来一次。'
      : accuracy >= 80
        ? '词感在线，下一组继续冲刺。'
        : '把错题再读一遍，你会更稳。';
  }
};

const stopTimer = () => {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
};

const startTimer = () => {
  stopTimer();
  timerId = window.setInterval(() => {
    state = tick(state, 1);
    render();
    if (state.status !== 'playing') stopTimer();
  }, 1000);
};

const scheduleNextWave = () => {
  if (advanceTimeout !== null) window.clearTimeout(advanceTimeout);
  advanceTimeout = window.setTimeout(() => {
    state = startNextWave(state);
    render();
    if (state.status === 'playing') startTimer();
  }, 850);
};

const handleTileClick = (event) => {
  const tileButton = event.target.closest('[data-tile-id]');
  if (!tileButton) return;
  const previousStatus = state.status;
  state = selectTile(state, tileButton.dataset.tileId);
  render();
  if (state.lastResult === 'match' && previousStatus === 'playing') {
    playTone('match');
    showToast(`配对成功 +${100 + state.combo * 25}`, 'success');
  }
  if (state.lastResult === 'miss') playTone('miss');
  if (state.status === 'wave-cleared') {
    stopTimer();
    if (state.wave < state.totalWaves) scheduleNextWave();
    else state = { ...state, status: 'complete' };
    render();
  }
};

const handleHint = () => {
  const nextState = useHint(state);
  if (nextState === state) return;
  state = nextState;
  render();
  playTone('hint');
  showToast('提示已使用，扣除 25 分', 'hint');
  if (hintTimeout !== null) window.clearTimeout(hintTimeout);
  hintTimeout = window.setTimeout(() => {
    if (state.hintPairId !== null) {
      state = { ...state, hintPairId: null, lastResult: null };
      render();
    }
  }, 1800);
};

const handleRestart = () => {
  stopTimer();
  if (advanceTimeout !== null) window.clearTimeout(advanceTimeout);
  state = restartGame(state);
  resultModal.hidden = true;
  render();
  startTimer();
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
soundButton.addEventListener('click', handleSound);

render();
startTimer();
