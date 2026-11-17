import {
  GAME_CONSTANTS,
  completePendingMatch,
  createGameState,
  getChallengeProgress,
  getTilePresentation,
  getWaveReview,
  restartGame,
  selectTile,
  startNextWave,
  tick,
  useHint,
} from './game.js?v=14';
import {
  loadVocabulary,
  loadVocabularyCatalog,
} from './vocabulary.js?v=14';
import {
  clearChallengeProgress,
  loadChallengeProgress,
  createChallengeProgressAdapter,
  createPendingCloudDeleteAdapter,
  shouldRebuildFromSyncRecord,
  saveChallengeProgress,
} from './challenge-progress.js?v=14';
import { createAuthService, getAuthErrorCopy, getResendSeconds, maskEmail } from './auth.js?v=14';
import { createCloudProgressService } from './cloud-progress.js?v=14';
import { createSyncController } from './sync-controller.js?v=14';

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
const bookPairProgress = document.querySelector('#book-pair-progress');
const bookPairFill = document.querySelector('#book-pair-fill');
const bookChallengeProgress = document.querySelector('#book-challenge-progress');
const bookChallengeFill = document.querySelector('#book-challenge-fill');
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
const resultTitle = document.querySelector('#result-title');
const modalRestart = document.querySelector('#modal-restart');
const toastLayer = document.querySelector('#toast-layer');
const gameFrame = document.querySelector('.game-frame');
const gameSubtitle = document.querySelector('#game-subtitle');
const currentVocabulary = document.querySelector('#current-vocabulary');
const footerCopy = document.querySelector('#footer-copy');
const changeBookButton = document.querySelector('#change-book-button');
const setupModal = document.querySelector('#setup-modal');
const setupForm = document.querySelector('#setup-form');
const startGameButton = document.querySelector('#start-game-button');
const setupError = document.querySelector('#setup-error');
const frequentCount = document.querySelector('#frequent-count');
const fullCount = document.querySelector('#full-count');
const resetModal = document.querySelector('#reset-modal');
const resetCancel = document.querySelector('#reset-cancel');
const resetConfirm = document.querySelector('#reset-confirm');
const resetError = document.querySelector('#reset-error');
const accountButton = document.querySelector('#account-button');
const accountLabel = document.querySelector('#account-label');
const syncStatus = document.querySelector('#sync-status');
const authModal = document.querySelector('#auth-modal');
const authClose = document.querySelector('#auth-close');
const authEmailStep = document.querySelector('#auth-email-step');
const authCodeStep = document.querySelector('#auth-code-step');
const authAccountStep = document.querySelector('#auth-account-step');
const authEmail = document.querySelector('#auth-email');
const authEmailDisplay = document.querySelector('#auth-email-display');
const authCode = document.querySelector('#auth-code');
const authSend = document.querySelector('#auth-send');
const authVerify = document.querySelector('#auth-verify');
const authResend = document.querySelector('#auth-resend');
const authChangeEmail = document.querySelector('#auth-change-email');
const authSignOut = document.querySelector('#auth-sign-out');
const authAccountEmail = document.querySelector('#auth-account-email');
const authError = document.querySelector('#auth-error');
const conflictModal = document.querySelector('#conflict-modal');
const conflictClose = document.querySelector('#conflict-close');
const useCloudProgress = document.querySelector('#use-cloud-progress');
const useLocalProgress = document.querySelector('#use-local-progress');
const localReplaceConfirmation = document.querySelector('#local-replace-confirmation');
const confirmUseLocal = document.querySelector('#confirm-use-local');
const cancelUseLocal = document.querySelector('#cancel-use-local');
const conflictError = document.querySelector('#conflict-error');
const conflictLocalBook = document.querySelector('#conflict-local-book');
const conflictLocalProgress = document.querySelector('#conflict-local-progress');
const conflictLocalUpdated = document.querySelector('#conflict-local-updated');
const conflictCloudBook = document.querySelector('#conflict-cloud-book');
const conflictCloudProgress = document.querySelector('#conflict-cloud-progress');
const conflictCloudUpdated = document.querySelector('#conflict-cloud-updated');

let state = createGameState(Date.now());
let catalog = null;
let timerId = null;
let matchTimeout = null;
let waveClearTimeout = null;
let hintTimeout = null;
let soundOn = true;
let reviewOpen = false;
let activeChallengeLoaded = false;
let audioContext = null;
const auth = createAuthService();
let syncController = null;
let syncSnapshot = { syncState: 'guest', record: null, user: null, conflict: null, error: null };
let authUnsubscribe = () => {};
let authModalWasPlaying = false;
let authEmailValue = '';
let resendSentAt = 0;
let resendTimer = null;
let conflictWasPlaying = false;
let controllerClient = null;
let controllerSubscription = () => {};

const SETTINGS_KEY = 'synonym-match-vocabulary-v1';
const numberFormatter = new Intl.NumberFormat('zh-CN');

const formatScore = (score) => String(score).padStart(4, '0');

const getLocalAdapter = () => createChallengeProgressAdapter(window.localStorage);
const getPendingDeleteAdapter = () => createPendingCloudDeleteAdapter(window.localStorage);
const syncStatusCopy = (syncState) => ({ guest: '本机保存', initializing: '同步中', syncing: '同步中', synced: '已同步', offline: '离线保存', error: '同步失败', conflict: '待选择进度' }[syncState] ?? '本机保存');
const updateAccountUi = () => {
  const user = syncSnapshot.user ?? auth.getUser?.();
  accountLabel.textContent = user?.email ? maskEmail(user.email) : '登录同步';
  syncStatus.textContent = syncStatusCopy(syncSnapshot.syncState);
  accountButton.disabled = false;
  authAccountEmail.textContent = user?.email ? maskEmail(user.email) : '';
};
const catalogLabel = (record) => `${catalog?.books?.[record.bookId]?.label ?? record.bookId} · ${record.scope === 'frequent' ? '高频词库' : '完整词库'}`;
const formatUpdated = (record) => Number.isFinite(record?.clientUpdatedAt) ? new Date(record.clientUpdatedAt).toLocaleString('zh-CN') : '时间未知';
const renderConflict = (conflict) => {
  const wasVisible = !conflictModal.hidden;
  conflictModal.hidden = !conflict;
  if (!conflict) {
    if (wasVisible) gameFrame.inert = false;
    return;
  }
  if (!wasVisible) {
    conflictWasPlaying = state.status === 'playing';
    stopTimer();
    gameFrame.inert = true;
    useCloudProgress.focus();
  }
  const local = conflict.local; const cloud = conflict.cloud;
  conflictLocalBook.textContent = catalogLabel(local.record); conflictCloudBook.textContent = catalogLabel(cloud.record);
  conflictLocalProgress.textContent = `${local.record.completedPairIds.length} / ${local.totalPairs} 组已完成`;
  conflictCloudProgress.textContent = `${cloud.record.completedPairIds.length} / ${cloud.totalPairs} 组已完成`;
  conflictLocalUpdated.textContent = `最近更新：${formatUpdated(local.record)}`; conflictCloudUpdated.textContent = `最近更新：${formatUpdated(cloud.record)}`;
};
const rebuildFromRecord = async (record) => {
  if (!record || !catalog?.books?.[record.bookId]?.scopes?.[record.scope]) return false;
  const vocabulary = await loadVocabulary(catalog, record.bookId, record.scope);
  const totalChallenges = Math.ceil(vocabulary.pairs.length / GAME_CONSTANTS.PAIRS_PER_WAVE);
  const wave = Math.min(totalChallenges, Math.floor(record.completedPairIds.length / GAME_CONSTANTS.PAIRS_PER_WAVE) + 1);
  state = createGameState(record.seed, wave, record.score, vocabulary, record.completedPairIds, { correctMatches: record.correctMatches, attempts: record.attempts });
  setupForm.elements.book.value = record.bookId; setupForm.elements.scope.value = record.scope; activeChallengeLoaded = true;
  setSetupOpen(false); render(); if (!syncSnapshot.conflict) startTimer(); return true;
};
const onSyncSnapshot = (next) => {
  syncSnapshot = next; updateAccountUi(); renderConflict(next.conflict);
  if (shouldRebuildFromSyncRecord(next.record, state, activeChallengeLoaded)) void rebuildFromRecord(next.record).catch(() => {});
};
const createController = () => {
  if (!catalog) return syncController;
  const client = auth.getClient();
  if (syncController && client === controllerClient) return syncController;
  controllerSubscription();
  syncController = createSyncController({ auth, cloud: client ? createCloudProgressService({ client, getUser: auth.getUser }) : null, local: getLocalAdapter(), pendingDeletes: getPendingDeleteAdapter(), loadVocabulary: (bookId, scope) => loadVocabulary(catalog, bookId, scope), isOnline: () => window.navigator.onLine !== false });
  controllerClient = client;
  controllerSubscription = syncController.subscribe(onSyncSnapshot);
  return syncController;
};


const getStatusCopy = (currentState) => {
  if (currentState.status === 'resolving') return '配对成功，记住刚刚出现的中文释义';
  if (currentState.status === 'wave-cleared') return '本组完成，正在整理词汇回顾';
  if (currentState.status === 'wave-expired') return '时间到，先把刚才的词读一遍';
  if (currentState.status === 'complete') return '整本词书挑战完成，看看你的最终成绩';
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
  const challengeProgress = getChallengeProgress(state);
  const bookComplete = challengeProgress.completedPairs === challengeProgress.totalPairs;
  reviewTitle.textContent = `第 ${state.wave} 局完成`;
  reviewSummary.textContent = `本局回顾 · ${review.pairs.length} 组同义词 · ${review.totalWords} 个词`;
  reviewContinue.firstChild.textContent = bookComplete ? '查看总成绩 ' : '下一局 ';

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
  resultTitle.textContent = state.status === 'wave-expired' ? '时间到，进度已经保存' : '这本词书，挑战完成';
  finalScore.textContent = formatScore(state.score);
  finalAccuracy.textContent = `${accuracy}%`;
  resultMessage.textContent = state.status === 'wave-expired'
    ? '重新开始本局时，已经消除的词对不会丢失。'
    : accuracy >= 80
      ? '词感在线，可以开始下一本词书了。'
      : '整本词书已经完成，可以开始下一本了。';
  modalRestart.firstChild.textContent = state.status === 'complete' ? '选择新词书 ' : '继续挑战 ';
};

const render = () => {
  const matchedCount = state.matchedPairIds.length;
  const progress = (matchedCount / GAME_CONSTANTS.PAIRS_PER_WAVE) * 100;
  const timeProgress = (state.timeLeft / GAME_CONSTANTS.ROUND_SECONDS) * 100;
  const challengeProgress = getChallengeProgress(state);
  const pairProgress = challengeProgress.totalPairs
    ? (challengeProgress.completedPairs / challengeProgress.totalPairs) * 100
    : 0;
  const completedChallengeProgress = challengeProgress.totalChallenges
    ? (challengeProgress.completedChallenges / challengeProgress.totalChallenges) * 100
    : 0;
  scoreEl.textContent = formatScore(state.score);
  waveEl.textContent = `第 ${state.wave} / ${state.totalWaves} 局`;
  timerEl.textContent = String(state.timeLeft).padStart(2, '0');
  timerFill.style.width = `${timeProgress}%`;
  timerCard.classList.toggle('is-warning', state.timeLeft <= 12 && state.status === 'playing');
  progressEl.textContent = `本局已配对 ${matchedCount} / ${GAME_CONSTANTS.PAIRS_PER_WAVE}`;
  progressFill.style.width = `${progress}%`;
  bookPairProgress.textContent = `${numberFormatter.format(challengeProgress.completedPairs)} / ${numberFormatter.format(challengeProgress.totalPairs)}`;
  bookPairFill.style.width = `${pairProgress}%`;
  bookChallengeProgress.textContent = `${numberFormatter.format(challengeProgress.completedChallenges)} / ${numberFormatter.format(challengeProgress.totalChallenges)}`;
  bookChallengeFill.style.width = `${completedChallengeProgress}%`;
  comboEl.textContent = `连击 ${state.combo}`;
  comboChip.dataset.active = String(state.combo > 0);
  currentVocabulary.textContent = `${state.vocabularyLabel} · ${numberFormatter.format(state.vocabularyWordCount)} 词`;
  gameSubtitle.textContent = `${state.vocabularyLabel}同义词配对挑战`;
  footerCopy.textContent = `当前使用 ${state.vocabularyLabel}，每局 15 个词块。`;
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

const persistActiveChallenge = () => {
  if (!activeChallengeLoaded) return;
  try {
    const record = saveChallengeProgress(window.localStorage, state);
    if (state.status === 'complete') {
      if (syncController && syncSnapshot.user) syncController.notifyChallengeComplete(record);
      else clearChallengeProgress(window.localStorage);
      activeChallengeLoaded = false;
      return;
    }
    syncController?.notifyLocalProgress(record);
  } catch {
    showToast('浏览器无法保存挑战进度', 'neutral');
  }
};

const clearActiveChallenge = async () => {
  try {
    const record = syncSnapshot.record ?? (activeChallengeLoaded ? saveChallengeProgress(window.localStorage, state) : null);
    if (syncController && syncSnapshot.user && record) await syncController.clearActiveChallenge(record);
    else clearChallengeProgress(window.localStorage);
    activeChallengeLoaded = false;
    return true;
  } catch {
    return false;
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
    persistActiveChallenge();
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
  persistActiveChallenge();
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
  persistActiveChallenge();
  render();
  startTimer();
};

const handleContinue = () => {
  reviewOpen = false;
  state = startNextWave(state);
  persistActiveChallenge();
  render();
  if (state.status === 'playing') startTimer();
};

const handleSound = () => {
  soundOn = !soundOn;
  soundButton.setAttribute('aria-pressed', String(soundOn));
  soundLabel.textContent = soundOn ? '音效开' : '音效关';
  showToast(soundOn ? '音效已打开' : '音效已关闭');
};

const getSelectedSetup = () => ({
  bookId: setupForm.elements.book.value,
  scope: setupForm.elements.scope.value,
});

const updateSetupCounts = () => {
  if (!catalog) return;
  for (const element of document.querySelectorAll('[data-book-count]')) {
    const book = catalog.books[element.dataset.bookCount];
    element.textContent = `${numberFormatter.format(book.scopes.full.wordCount)} 词`;
  }
  const { bookId } = getSelectedSetup();
  const selectedBook = catalog.books[bookId];
  frequentCount.textContent = `${numberFormatter.format(selectedBook.scopes.frequent.wordCount)} 词 · 高频优先`;
  fullCount.textContent = `${numberFormatter.format(selectedBook.scopes.full.wordCount)} 词 · 全量覆盖`;
};

const setSetupOpen = (open) => {
  setupModal.hidden = !open;
  gameFrame.inert = open;
  if (open) {
    stopTimer();
    setupForm.querySelector('input:checked')?.focus();
  }
};

const restoreSetupSelection = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY));
    if (catalog.books[saved.bookId]?.scopes[saved.scope]) {
      setupForm.elements.book.value = saved.bookId;
      setupForm.elements.scope.value = saved.scope;
    }
  } catch {
    // Keep the checked defaults when storage is unavailable or invalid.
  }
};

const handleStartGame = async (event) => {
  event.preventDefault();
  if (!catalog) return;
  const { bookId, scope } = getSelectedSetup();
  setupError.hidden = true;
  startGameButton.disabled = true;
  startGameButton.firstChild.textContent = '正在载入 ';

  try {
    const vocabulary = await loadVocabulary(catalog, bookId, scope);
    stopTimer();
    clearScheduledWork();
    reviewOpen = false;
    state = createGameState(Date.now(), 1, 0, vocabulary);
    activeChallengeLoaded = true;
    persistActiveChallenge();
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ bookId, scope }));
    setSetupOpen(false);
    render();
    startTimer();
  } catch (error) {
    setupError.textContent = error instanceof Error ? error.message : '词库加载失败，请稍后重试。';
    setupError.hidden = false;
  } finally {
    startGameButton.disabled = false;
    startGameButton.firstChild.textContent = '开始挑战 ';
  }
};

const handleChangeBook = () => {
  stopTimer();
  resetError.hidden = true;
  resetModal.hidden = false;
  gameFrame.inert = true;
  resetCancel.focus();
};

const handleCancelReset = () => {
  resetModal.hidden = true;
  gameFrame.inert = false;
  changeBookButton.focus();
  startTimer();
};

const handleConfirmReset = async () => {
  resetConfirm.disabled = true;
  if (!await clearActiveChallenge()) {
    resetError.hidden = false;
    resetConfirm.disabled = false;
    return;
  }
  clearScheduledWork();
  reviewOpen = false;
  reviewModal.hidden = true;
  resultModal.hidden = true;
  resetModal.hidden = true;
  updateSetupCounts();
  setSetupOpen(true);
  resetConfirm.disabled = false;
};

const handleResultAction = () => {
  if (state.status !== 'complete') {
    handleRestart();
    return;
  }
  resultModal.hidden = true;
  updateSetupCounts();
  setSetupOpen(true);
};

const restoreActiveChallenge = async () => {
  const selection = getLocalAdapter().getSelection();
  if (!selection || !catalog.books[selection.bookId]?.scopes[selection.scope]) return false;
  const vocabulary = await loadVocabulary(catalog, selection.bookId, selection.scope);
  const saved = loadChallengeProgress(window.localStorage, vocabulary);
  if (!saved) {
    clearActiveChallenge();
    return false;
  }

  const completedChallenges = Math.floor(saved.completedPairIds.length / GAME_CONSTANTS.PAIRS_PER_WAVE);
  const totalChallenges = Math.ceil(vocabulary.pairs.length / GAME_CONSTANTS.PAIRS_PER_WAVE);
  const wave = Math.min(totalChallenges, completedChallenges + 1);
  state = createGameState(saved.seed, wave, saved.score, vocabulary, saved.completedPairIds, {
    correctMatches: saved.correctMatches,
    attempts: saved.attempts,
  });
  setupForm.elements.book.value = saved.bookId;
  setupForm.elements.scope.value = saved.scope;
  activeChallengeLoaded = true;
  setSetupOpen(false);
  render();
  startTimer();
  showToast('已恢复上次挑战进度');
  return true;
};

const clearResendTimer = () => { if (resendTimer !== null) window.clearInterval(resendTimer); resendTimer = null; };
const setAuthError = (error) => { authError.textContent = getAuthErrorCopy(error); authError.hidden = false; };
const renderAuthStep = (step) => {
  authEmailStep.hidden = step !== 'email'; authCodeStep.hidden = step !== 'code'; authAccountStep.hidden = step !== 'account';
  if (step !== 'code') clearResendTimer();
};
const updateResendLabel = () => {
  const seconds = getResendSeconds(resendSentAt);
  authResend.disabled = seconds > 0; authResend.textContent = seconds > 0 ? `重新发送 (${seconds}s)` : '重新发送';
  if (!seconds) clearResendTimer();
};
const startResendTimer = () => { clearResendTimer(); updateResendLabel(); resendTimer = window.setInterval(updateResendLabel, 1000); };
const openAuth = () => {
  if (syncSnapshot.conflict) {
    renderConflict(syncSnapshot.conflict);
    conflictClose.focus();
    return;
  }
  authModalWasPlaying = state.status === 'playing'; stopTimer(); authError.hidden = true;
  renderAuthStep(syncSnapshot.user ? 'account' : (authEmailValue ? 'code' : 'email')); authModal.hidden = false;
  (syncSnapshot.user ? authClose : authEmail).focus();
};
const closeAuth = () => { authModal.hidden = true; clearResendTimer(); authError.hidden = true; accountButton.focus(); if (authModalWasPlaying) startTimer(); };
const handleSendOtp = async () => {
  authError.hidden = true; authSend.disabled = true;
  try { authEmailValue = authEmail.value.trim().toLowerCase(); await auth.sendOtp(authEmailValue); authEmailDisplay.textContent = maskEmail(authEmailValue); resendSentAt = Date.now(); renderAuthStep('code'); startResendTimer(); authCode.focus(); }
  catch (error) { setAuthError(error); authEmail.focus(); authEmail.setAttribute('aria-invalid', 'true'); }
  finally { authSend.disabled = false; }
};
const handleVerifyOtp = async () => {
  authError.hidden = true; authVerify.disabled = true;
  try { await auth.verifyOtp(authEmailValue || authEmail.value, authCode.value); createController(); await syncController.initialize(); closeAuth(); }
  catch (error) { setAuthError(error); authCode.focus(); authCode.setAttribute('aria-invalid', 'true'); }
  finally { authVerify.disabled = false; }
};
const handleResendOtp = async () => { if (authResend.disabled) return; authError.hidden = true; try { await auth.sendOtp(authEmailValue); resendSentAt = Date.now(); startResendTimer(); } catch (error) { setAuthError(error); } };
const handleSignOut = async () => { authSignOut.disabled = true; try { await syncController?.signOut(); renderAuthStep('email'); closeAuth(); } catch (error) { setAuthError(error); } finally { authSignOut.disabled = false; } };
const handleConflictChoice = async (choice) => {
  conflictError.hidden = true;
  try {
    await syncController.resolveConflict(choice);
    conflictModal.hidden = true;
    localReplaceConfirmation.hidden = true;
    gameFrame.inert = false;
    if (syncSnapshot.record) await rebuildFromRecord(syncSnapshot.record);
    else if (conflictWasPlaying) startTimer();
    conflictWasPlaying = false;
  } catch (error) {
    conflictError.textContent = '同步失败，请稍后重试。'; conflictError.hidden = false;
  }
};
const handleOnline = () => { void syncController?.retry().catch(() => {}); };
const handleOffline = () => { syncSnapshot = { ...syncSnapshot, syncState: 'offline' }; updateAccountUi(); };

const initializeVocabularySetup = async () => {
  startGameButton.disabled = true;
  try {
    const [catalogResult] = await Promise.allSettled([loadVocabularyCatalog(), auth.initialize()]);
    if (catalogResult.status === 'rejected') throw catalogResult.reason;
    catalog = catalogResult.value;
    restoreSetupSelection();
    updateSetupCounts();
    setupError.hidden = true;
    startGameButton.disabled = false;
    createController();
    const snapshot = await syncController.initialize();
    if (!snapshot.record) await restoreActiveChallenge();
    else await rebuildFromRecord(snapshot.record);
    authUnsubscribe = auth.subscribe(() => {
      updateAccountUi();
      if (catalog) void Promise.resolve().then(() => { createController(); return syncController.initialize(); }).catch(() => {});
    });
  } catch (error) {
    setupError.textContent = error instanceof Error ? error.message : '词库目录加载失败，请刷新重试。';
    setupError.hidden = false;
  }
};

board.addEventListener('click', handleTileClick);
hintButton.addEventListener('click', handleHint);
restartButton.addEventListener('click', handleRestart);
modalRestart.addEventListener('click', handleResultAction);
reviewContinue.addEventListener('click', handleContinue);
soundButton.addEventListener('click', handleSound);
changeBookButton.addEventListener('click', handleChangeBook);
resetCancel.addEventListener('click', handleCancelReset);
resetConfirm.addEventListener('click', handleConfirmReset);
setupForm.addEventListener('change', updateSetupCounts);
setupForm.addEventListener('submit', handleStartGame);
accountButton.addEventListener('click', openAuth);
syncStatus.addEventListener('click', openAuth);
authClose.addEventListener('click', closeAuth);
authSend.addEventListener('click', handleSendOtp);
authVerify.addEventListener('click', handleVerifyOtp);
authResend.addEventListener('click', handleResendOtp);
authChangeEmail.addEventListener('click', () => { authEmailValue = authEmail.value; renderAuthStep('email'); authEmail.focus(); });
authSignOut.addEventListener('click', handleSignOut);
useCloudProgress.addEventListener('click', () => handleConflictChoice('cloud'));
useLocalProgress.addEventListener('click', () => { localReplaceConfirmation.hidden = false; });
confirmUseLocal.addEventListener('click', () => handleConflictChoice('local'));
cancelUseLocal.addEventListener('click', () => { localReplaceConfirmation.hidden = true; });
conflictClose.addEventListener('click', () => { conflictModal.hidden = true; gameFrame.inert = false; accountButton.focus(); if (conflictWasPlaying) startTimer(); });
window.addEventListener('online', handleOnline);
window.addEventListener('offline', handleOffline);

render();
setSetupOpen(true);
initializeVocabularySetup();
