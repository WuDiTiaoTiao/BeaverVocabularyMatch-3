import { normalizeSyncRecord, mergeSameChallenge, decideProgressSync } from './sync-model.js';

const RETRY_DELAYS = [5000, 30000, 120000];
const keyOf = (record) => record ? `${record.bookId}:${record.scope}` : '';
const copyRecord = (record) => record ? { ...record, completedPairIds: [...(record.completedPairIds ?? [])] } : null;
const copyError = (error) => {
  if (!error) return null;
  const clone = new Error(error.message);
  clone.name = error.name;
  if (error.code !== undefined) clone.code = error.code;
  if (error.cause !== undefined) clone.cause = typeof error.cause === 'object' ? copyUser(error.cause) : error.cause;
  return clone;
};
const copyUser = (user) => {
  const copy = (value, seen = new WeakMap()) => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const result = []; seen.set(value, result);
      for (const item of value) result.push(copy(item, seen));
      return result;
    }
    const result = {}; seen.set(value, result);
    for (const [key, nested] of Object.entries(value)) {
      if (/token|secret|session|credential/i.test(key)) continue;
      result[key] = copy(nested, seen);
    }
    return result;
  };
  return user && typeof user === 'object' ? copy(user) : null;
};
const copyConflict = (conflict) => conflict ? {
  local: { record: copyRecord(conflict.local.record), totalPairs: conflict.local.totalPairs },
  cloud: { record: copyRecord(conflict.cloud.record), totalPairs: conflict.cloud.totalPairs },
} : null;
const isOfflineError = (error, isOnline) => !isOnline() || error?.code === 'offline';
const errorWithCode = (message, code, cause) => {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

export const createSyncController = ({
  auth, cloud = null, local, pendingDeletes, loadVocabulary,
  now = () => Date.now(), setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (timerId) => clearTimeout(timerId), isOnline = () => true,
} = {}) => {
  if (!auth || !local || !pendingDeletes || typeof loadVocabulary !== 'function') {
    throw new TypeError('auth, local, pendingDeletes, and loadVocabulary are required');
  }

  let state = { syncState: 'guest', record: null, user: null, conflict: null, error: null };
  let listeners = new Set();
  let pendingRecord = null;
  let uploadTimer = null;
  let retryTimer = null;
  let completionTimers = new Set();
  let retryIndex = 0;
  let uploadInFlight = false;
  let pendingOwnerId = null;
  let needsReconcile = false;
  let operationEpoch = 0;
  let initializedUserId = null;

  const snapshot = () => ({
    syncState: state.syncState,
    record: copyRecord(state.record),
    user: copyUser(state.user),
    conflict: copyConflict(state.conflict),
    error: copyError(state.error),
  });
  const emit = () => {
    const value = snapshot();
    for (const listener of [...listeners]) {
      try { listener(value); } catch { /* subscriber failures do not break synchronization */ }
    }
  };
  const setState = (patch) => {
    state = { ...state, ...patch };
    emit();
    return snapshot();
  };
  const currentUser = () => {
    try { return auth.getUser?.() ?? null; } catch { return null; }
  };
  const activeUser = () => {
    const user = currentUser();
    return user && typeof user.id === 'string' && user.id ? user : null;
  };
  const accountError = () => errorWithCode('Authenticated account changed', 'account_changed');
  const assertActive = (userId, epoch) => {
    const user = activeUser();
    if (epoch !== operationEpoch || !user || user.id !== userId) throw accountError();
    return user;
  };
  const isStale = (userId, epoch) => epoch !== operationEpoch || activeUser()?.id !== userId;
  const classify = (error) => isOfflineError(error, isOnline) ? 'offline' : 'error';
  const setFailure = (error, record = state.record) => setState({ syncState: classify(error), record: copyRecord(record), error });

  const vocabCache = new Map();
  const getVocabulary = async (recordOrSelection) => {
    if (!recordOrSelection) return null;
    const bookId = recordOrSelection.bookId;
    const scope = recordOrSelection.scope;
    const key = `${bookId}:${scope}`;
    if (!vocabCache.has(key)) vocabCache.set(key, Promise.resolve().then(() => loadVocabulary(bookId, scope)));
    try {
      return await vocabCache.get(key);
    } catch (error) {
      vocabCache.delete(key);
      throw error;
    }
  };
  const normalizeWithVocabulary = (record, vocabulary) => {
    if (!record) return null;
    return normalizeSyncRecord(record, vocabulary);
  };
  const totalPairs = (vocabulary) => vocabulary?.pairs?.length ?? 0;
  const makeConflict = (localRecord, cloudRecord, localVocabulary, cloudVocabulary) => ({
    local: { record: copyRecord(localRecord), totalPairs: totalPairs(localVocabulary) },
    cloud: { record: copyRecord(cloudRecord), totalPairs: totalPairs(cloudVocabulary) },
  });

  const cancelTimer = (slot) => {
    if (slot) clearTimer(slot);
  };
  const cancelAllTimers = () => {
    cancelTimer(uploadTimer); uploadTimer = null;
    cancelTimer(retryTimer); retryTimer = null;
    for (const timer of completionTimers) clearTimer(timer);
    completionTimers.clear();
  };
  const scheduleUpload = (userId, epoch, delay = 600) => {
    if (uploadTimer || !pendingRecord || pendingOwnerId !== userId) return;
    uploadTimer = setTimer(() => {
      uploadTimer = null;
      if (epoch !== operationEpoch || activeUser()?.id !== userId) return;
      void runUpload(userId, epoch, false);
    }, delay);
  };
  const scheduleRetry = (userId, epoch) => {
    if (retryTimer || retryIndex >= RETRY_DELAYS.length || !pendingRecord || pendingOwnerId !== userId) return;
    const delay = RETRY_DELAYS[retryIndex++];
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (epoch !== operationEpoch || activeUser()?.id !== userId) return;
      void runUpload(userId, epoch, false);
    }, delay);
  };

  const processPendingDelete = async (userId, epoch) => {
    const marker = pendingDeletes.load(userId);
    if (!marker) return true;
    try {
      const result = await cloud.clearProgress(marker);
      assertActive(userId, epoch);
      if (result === 'cleared' || result === 'empty' || result === 'changed') pendingDeletes.clear(userId);
      if (!['cleared', 'empty', 'changed'].includes(result)) throw errorWithCode('Invalid cloud deletion result', 'invalid_response');
      return true;
    } catch (error) {
      if (isStale(userId, epoch)) throw accountError();
      if (error?.code === 'account_changed') throw error;
      setFailure(error, state.record);
      return false;
    }
  };

  const reconcile = async ({ user, localRecord, localVocabulary, cloudRecord, epoch }) => {
    const cloudVocabulary = cloudRecord ? await getVocabulary(cloudRecord) : null;
    assertActive(user.id, epoch);
    const decision = decideProgressSync(localRecord, cloudRecord);
    if (decision.type === 'empty') return setState({ syncState: 'synced', record: null, user, conflict: null, error: null });
    if (decision.type === 'use-cloud') {
      assertActive(user.id, epoch);
      local.replace(copyRecord(cloudRecord));
      return setState({ syncState: 'synced', record: cloudRecord, user, conflict: null, error: null });
    }
    if (decision.type === 'use-local') {
      try {
        const result = await cloud.mergeProgress(copyRecord(localRecord));
        assertActive(user.id, epoch);
        if (!['merged', 'conflict'].includes(result?.status)) throw errorWithCode('Invalid cloud merge response', 'invalid_response');
        const responseVocabulary = await getVocabulary(result?.record ?? localRecord);
        assertActive(user.id, epoch);
        const returned = normalizeWithVocabulary(result?.record, result.status === 'conflict' ? responseVocabulary : localVocabulary);
        if (!returned) throw errorWithCode('Invalid cloud merge response', 'invalid_response');
        if (result.status === 'conflict') {
          return setState({ syncState: 'conflict', record: localRecord, user, conflict: makeConflict(localRecord, returned, localVocabulary, responseVocabulary), error: null });
        }
        local.replace(copyRecord(returned));
        return setState({ syncState: 'synced', record: returned, user, conflict: null, error: null });
      } catch (error) {
        if (isStale(user.id, epoch)) throw accountError();
        if (error?.code === 'account_changed') throw error;
        return setFailure(error, localRecord);
      }
    }
    if (decision.type === 'conflict') {
      return setState({ syncState: 'conflict', record: localRecord, user, conflict: makeConflict(localRecord, cloudRecord, localVocabulary, cloudVocabulary), error: null });
    }
    const merged = decision.record;
    try {
      const result = await cloud.mergeProgress(copyRecord(merged));
      assertActive(user.id, epoch);
      if (!['merged', 'conflict'].includes(result?.status)) throw errorWithCode('Invalid cloud merge response', 'invalid_response');
      const responseVocabulary = await getVocabulary(result?.record ?? merged);
      assertActive(user.id, epoch);
      const returned = normalizeWithVocabulary(result?.record, result.status === 'conflict' ? responseVocabulary : localVocabulary);
      if (!returned) throw errorWithCode('Invalid cloud merge response', 'invalid_response');
      if (result.status === 'conflict') {
        return setState({ syncState: 'conflict', record: localRecord, user, conflict: makeConflict(localRecord, returned, localVocabulary, responseVocabulary), error: null });
      }
      local.replace(copyRecord(returned));
      return setState({ syncState: 'synced', record: returned, user, conflict: null, error: null });
    } catch (error) {
      if (isStale(user.id, epoch)) throw accountError();
      if (error?.code === 'account_changed') throw error;
      return setFailure(error, localRecord);
    }
  };

  const initialize = async () => {
    const epoch = ++operationEpoch;
    cancelTimer(uploadTimer); uploadTimer = null;
    cancelTimer(retryTimer); retryTimer = null;
    retryIndex = 0;
    const user = activeUser();
    const previousUserId = initializedUserId;
    if (previousUserId && previousUserId !== (user?.id ?? null)) {
      pendingRecord = null; pendingOwnerId = null;
    }
    initializedUserId = user?.id ?? null;
    setState({ syncState: user && cloud ? 'initializing' : 'guest', user, conflict: null, error: null });
    let selection = null;
    let localRecord = null;
    let localVocabulary = null;
    try {
      selection = local.getSelection?.() ?? null;
      if (selection) {
        localVocabulary = await getVocabulary(selection);
        localRecord = normalizeWithVocabulary(local.load(localVocabulary), localVocabulary);
      }
      if (!user || !cloud) return setState({ syncState: 'guest', record: localRecord, user: null, conflict: null, error: null });
      assertActive(user.id, epoch);
      if (!(await processPendingDelete(user.id, epoch))) return snapshot();
      const fetched = await cloud.fetchProgress();
      assertActive(user.id, epoch);
      let cloudRecord = null;
      if (fetched) {
        const vocabulary = await getVocabulary(fetched);
        assertActive(user.id, epoch);
        cloudRecord = normalizeWithVocabulary(fetched, vocabulary);
        if (!cloudRecord) throw errorWithCode('Invalid cloud progress record', 'invalid_response');
      }
      const result = await reconcile({ user, localRecord, localVocabulary, cloudRecord, epoch });
      needsReconcile = result.syncState === 'error' || result.syncState === 'offline';
      return result;
    } catch (error) {
      if (isStale(user?.id, epoch)) return snapshot();
      needsReconcile = true;
      return setFailure(error, localRecord);
    }
  };

  const runUpload = async (userId, epoch, explicit) => {
    if (uploadInFlight || !pendingRecord) return snapshot();
    if (!cloud || !activeUser() || activeUser().id !== userId || epoch !== operationEpoch || pendingOwnerId !== userId) return snapshot();
    if (!isOnline()) {
      setState({ syncState: 'offline', error: null });
      return snapshot();
    }
    uploadInFlight = true;
    const record = pendingRecord;
    pendingRecord = null;
    setState({ syncState: 'syncing', error: null, conflict: null, user: activeUser() });
    try {
      if (!(await processPendingDelete(userId, epoch))) {
        pendingRecord = pendingRecord ?? record;
        if (state.syncState === 'error' && isOnline()) scheduleRetry(userId, epoch);
        if (explicit) throw state.error;
        return snapshot();
      }
      const result = await cloud.mergeProgress(copyRecord(record));
      assertActive(userId, epoch);
      if (!['merged', 'conflict'].includes(result?.status)) throw errorWithCode('Invalid cloud merge response', 'invalid_response');
      const vocabulary = await getVocabulary(result?.record ?? record);
      assertActive(userId, epoch);
      const returned = normalizeWithVocabulary(result?.record, vocabulary);
      if (!returned) throw errorWithCode('Invalid cloud merge response', 'invalid_response');
      if (result.status === 'conflict') {
        const newest = pendingRecord ?? record;
        const newestVocabulary = await getVocabulary(newest);
        assertActive(userId, epoch);
        const conflict = makeConflict(newest, returned, newestVocabulary, vocabulary);
        setState({ syncState: 'conflict', record: newest, conflict, error: null });
        if (explicit) throw errorWithCode('Cloud progress conflict', 'conflict');
        return snapshot();
      }
      const newer = pendingRecord;
      if (newer && keyOf(newer) !== keyOf(returned)) {
        const newerVocabulary = await getVocabulary(newer);
        assertActive(userId, epoch);
        const conflict = makeConflict(newer, returned, newerVocabulary, vocabulary);
        setState({ syncState: 'conflict', record: newer, conflict, error: null });
        return snapshot();
      }
      let persisted = returned;
      if (newer && keyOf(newer) === keyOf(returned)) persisted = mergeSameChallenge(returned, newer);
      local.replace(copyRecord(persisted));
      retryIndex = 0;
      setState({ syncState: 'synced', record: persisted, conflict: null, error: null, user: activeUser() });
      if (newer) scheduleUpload(userId, epoch, 600);
      return snapshot();
    } catch (error) {
      if (isStale(userId, epoch)) {
        if (explicit) throw error;
        return snapshot();
      }
      pendingRecord = pendingRecord ?? record;
      const status = classify(error);
      setState({ syncState: status, error });
      if (status === 'error' && isOnline()) scheduleRetry(userId, epoch);
      if (explicit) throw error;
      return snapshot();
    } finally {
      if (operationEpoch === epoch) uploadInFlight = false;
    }
  };

  const notifyLocalProgress = (record) => {
    const user = activeUser();
    if (!cloud || !user) {
      pendingRecord = null; pendingOwnerId = null;
      setState({ syncState: 'guest', record: copyRecord(record), user: null, conflict: null, error: null });
      return;
    }
    if (pendingOwnerId && pendingOwnerId !== user.id) {
      operationEpoch += 1;
      uploadInFlight = false;
      cancelTimer(uploadTimer); uploadTimer = null;
      cancelTimer(retryTimer); retryTimer = null;
      pendingRecord = null; pendingOwnerId = null; retryIndex = 0;
    }
    pendingRecord = copyRecord(record);
    pendingOwnerId = user.id;
    if (!isOnline()) {
      setState({ syncState: 'offline', record: copyRecord(record), user, error: null });
      return;
    }
    setState({ record: copyRecord(record), user, error: null });
    scheduleUpload(user.id, operationEpoch, 600);
  };

  const notifyChallengeComplete = (record) => {
    const user = activeUser();
    if (!cloud || !user) {
      local.clear();
      pendingRecord = null; pendingOwnerId = null;
      setState({ syncState: 'guest', record: null, user: null, conflict: null, error: null });
      return;
    }
    operationEpoch += 1;
    cancelTimer(uploadTimer); uploadTimer = null;
    cancelTimer(retryTimer); retryTimer = null;
    uploadInFlight = false;
    pendingRecord = null; pendingOwnerId = null; retryIndex = 0;
    const epoch = operationEpoch;
    pendingDeletes.save(user.id, copyRecord(record));
    local.clear();
    pendingRecord = null;
    setState({ syncState: 'synced', record: null, user, conflict: null, error: null });
    const timer = setTimer(async () => {
      completionTimers.delete(timer);
      if (epoch !== operationEpoch || activeUser()?.id !== user.id) return;
      try {
        const result = await cloud.clearProgress(record);
        assertActive(user.id, epoch);
        if (result === 'cleared' || result === 'empty') {
          pendingDeletes.clear(user.id);
          setState({ syncState: 'synced', record: null, user, error: null });
        } else if (result === 'changed') {
          pendingDeletes.clear(user.id);
          await initialize();
        } else throw errorWithCode('Invalid cloud deletion result', 'invalid_response');
      } catch (error) {
        if (isStale(user.id, epoch)) return;
        setFailure(error, null);
      }
    }, 0);
    completionTimers.add(timer);
  };

  const resolveConflict = async (choice) => {
    if (!state.conflict || !['cloud', 'local'].includes(choice)) throw errorWithCode('No active conflict', 'conflict');
    const conflict = state.conflict;
    const user = activeUser();
    if (!user || !cloud) throw errorWithCode('Authentication required', 'unauthenticated');
    const epoch = operationEpoch;
    try {
      if (choice === 'cloud') {
        assertActive(user.id, epoch);
        local.replace(copyRecord(conflict.cloud.record));
        pendingRecord = null; pendingOwnerId = null;
        cancelTimer(uploadTimer); uploadTimer = null;
        cancelTimer(retryTimer); retryTimer = null;
        retryIndex = 0;
        return setState({ syncState: 'synced', record: conflict.cloud.record, user, conflict: null, error: null });
      }
      assertActive(user.id, epoch);
      const result = await cloud.replaceProgress(copyRecord(conflict.local.record));
      assertActive(user.id, epoch);
      const vocabulary = await getVocabulary(result);
      assertActive(user.id, epoch);
      const returned = normalizeWithVocabulary(result, vocabulary);
      if (!returned) throw errorWithCode('Invalid cloud replacement response', 'invalid_response');
      local.replace(copyRecord(returned));
      pendingRecord = null; pendingOwnerId = null;
      retryIndex = 0;
      return setState({ syncState: 'synced', record: returned, user, conflict: null, error: null });
    } catch (error) {
      if (isStale(user.id, epoch)) throw error;
      setFailure(error, conflict.local.record);
      throw error;
    }
  };

  const clearActiveChallenge = async (record) => {
    const user = activeUser();
    if (!cloud || !user) {
      local.clear(); pendingRecord = null;
      return setState({ syncState: 'guest', record: null, user: null, conflict: null, error: null });
    }
    operationEpoch += 1;
    cancelTimer(uploadTimer); uploadTimer = null;
    cancelTimer(retryTimer); retryTimer = null;
    uploadInFlight = false;
    pendingRecord = null; pendingOwnerId = null; retryIndex = 0;
    const epoch = operationEpoch;
    try {
      const result = await cloud.clearProgress(copyRecord(record));
      assertActive(user.id, epoch);
      if (result === 'cleared' || result === 'empty') {
        local.clear(); pendingDeletes.clear(user.id); pendingRecord = null; pendingOwnerId = null;
        return setState({ syncState: 'synced', record: null, user, conflict: null, error: null });
      }
      if (result === 'changed') {
        const reconciled = await initialize();
        if (['error', 'offline', 'conflict'].includes(reconciled.syncState)) {
          throw reconciled.error ?? errorWithCode('Reset reconciliation requires attention', reconciled.syncState);
        }
        return reconciled;
      }
      throw errorWithCode('Invalid cloud deletion result', 'invalid_response');
    } catch (error) {
      if (isStale(user.id, epoch)) throw error;
      setFailure(error, record);
      throw error;
    }
  };

  const retry = async () => {
    const user = activeUser();
    if (!cloud || !user) return setState({ syncState: 'guest', user: null, conflict: null, error: null });
    if (!isOnline()) return setState({ syncState: 'offline', user, error: null });
    cancelTimer(retryTimer); retryTimer = null;
    if (pendingOwnerId && pendingOwnerId !== user.id) {
      cancelTimer(uploadTimer); uploadTimer = null;
      cancelTimer(retryTimer); retryTimer = null;
      pendingRecord = null; pendingOwnerId = null; retryIndex = 0;
    }
    if (!(await processPendingDelete(user.id, operationEpoch))) throw state.error;
    if (needsReconcile) return initialize();
    if (!pendingRecord) return snapshot();
    return runUpload(user.id, operationEpoch, true);
  };

  const signOut = async () => {
    operationEpoch += 1;
    cancelAllTimers();
    pendingRecord = null; pendingOwnerId = null;
    uploadInFlight = false;
    retryIndex = 0;
    try {
      await auth.signOut?.();
      initializedUserId = null;
      return setState({ syncState: 'guest', user: null, conflict: null, error: null });
    } catch (error) {
      setFailure(error, state.record);
      throw error;
    }
  };

  const onlineHandler = () => {
    const user = activeUser();
    if (!cloud || !user || !isOnline()) return;
    if (needsReconcile && !pendingRecord) {
      void initialize();
      return;
    }
    if (!pendingRecord || pendingOwnerId !== user.id) return;
    cancelTimer(retryTimer); retryTimer = null;
    void runUpload(user.id, operationEpoch, false);
  };
  if (typeof globalThis.window?.addEventListener === 'function') globalThis.window.addEventListener('online', onlineHandler);

  return {
    initialize,
    notifyLocalProgress,
    notifyChallengeComplete,
    resolveConflict,
    clearActiveChallenge,
    signOut,
    retry,
    getSnapshot: snapshot,
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      try { listener(snapshot()); } catch { /* subscriber failures are isolated */ }
      return () => listeners.delete(listener);
    },
  };
};

