import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyncController } from './sync-controller.js';

const VOCABULARIES = {
  'postgrad:frequent': { bookId: 'postgrad', scope: 'frequent', pairs: [{ pairId: 'pair-1' }, { pairId: 'pair-2' }, { pairId: 'pair-3' }] },
  'cet4:full': { bookId: 'cet4', scope: 'full', pairs: [{ pairId: 'pair-a' }, { pairId: 'pair-b' }, { pairId: 'pair-c' }, { pairId: 'pair-d' }] },
};
const record = (overrides = {}) => ({
  bookId: 'postgrad', scope: 'frequent', seed: 1, completedPairIds: ['pair-1'],
  score: 10, correctMatches: 1, attempts: 2, clientUpdatedAt: 1000, ...overrides,
});
const LOCAL_RECORD = record();
const CLOUD_RECORD_SAME_BOOK = record({ completedPairIds: ['pair-2'], clientUpdatedAt: 2000, score: 20 });
const CLOUD_RECORD_DIFFERENT_BOOK = { ...record({ bookId: 'cet4', scope: 'full', completedPairIds: ['pair-a'] }) };
const COMPLETED_RECORD = record({ completedPairIds: ['pair-1', 'pair-2'] });
const NEW_LOCAL_RECORD = record({ completedPairIds: ['pair-1', 'pair-2'], clientUpdatedAt: 3000 });

const createControllerFixture = ({ authUser = null, localRecord = null, cloudRecord = null, pendingDelete = null,
  mergeBehavior, clearBehavior, fetchBehavior, loadVocabulary, online = true } = {}) => {
  const calls = {
    fetchProgress: 0, mergeProgress: [], mergeUsers: [], replaceProgress: [], clearProgress: [], replaceLocal: [],
    clearLocal: 0, savePendingDelete: [], clearPendingDelete: 0, order: [], timers: [],
  };
  let user = authUser;
  let local = localRecord;
  let marker = pendingDelete;
  const auth = { getUser: () => user, signOut: async () => { user = null; } };
  const cloud = cloudRecord === undefined ? null : {
    fetchProgress: async () => { calls.fetchProgress += 1; if (fetchBehavior) return fetchBehavior(calls); return cloudRecord; },
    mergeProgress: async (value) => {
      calls.order.push('mergeProgress'); calls.mergeProgress.push(value); calls.mergeUsers.push(user?.id ?? null);
      if (mergeBehavior) return mergeBehavior(value, calls);
      return { status: 'merged', record: value };
    },
    replaceProgress: async (value) => { calls.replaceProgress.push(value); return value; },
    clearProgress: async (value) => {
      calls.order.push('clearProgress'); calls.clearProgress.push(value);
      return clearBehavior ? clearBehavior(value, calls) : 'cleared';
    },
  };
  const localAdapter = {
    getSelection: () => local ? { bookId: local.bookId, scope: local.scope } : null,
    load: () => local,
    replace: (value) => { calls.replaceLocal.push(value); local = value; },
    clear: () => { calls.clearLocal += 1; calls.order.push('clearLocal'); local = null; },
  };
  const pending = {
    load: () => marker,
    save: (_id, value) => { calls.savePendingDelete.push(value); marker = value; calls.order.push('savePendingDelete'); },
    clear: () => { calls.clearPendingDelete += 1; marker = null; },
  };
  const controller = createSyncController({
    auth, cloud, local: localAdapter, pendingDeletes: pending,
    loadVocabulary: loadVocabulary ?? (async (bookId, scope) => VOCABULARIES[`${bookId}:${scope}`]),
    now: () => 5000, setTimer: (callback, delayMs) => { const timer = { callback, delayMs }; calls.timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cancelled = true; }, isOnline: () => online,
  });
  return { controller, calls, auth, localAdapter, pending, setUser: (value) => { user = value; }, setOnline: (value) => { online = value; } };
};

test('guest initialization returns local progress without cloud calls', async () => {
  const fixture = createControllerFixture({ authUser: null, localRecord: LOCAL_RECORD });
  const result = await fixture.controller.initialize();
  assert.deepEqual(result.record, LOCAL_RECORD);
  assert.equal(fixture.calls.fetchProgress, 0);
  assert.equal(result.syncState, 'guest');
});

test('same-book login merges and writes the merged record locally', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: CLOUD_RECORD_SAME_BOOK });
  const result = await fixture.controller.initialize();
  assert.deepEqual(result.record.completedPairIds, ['pair-1', 'pair-2']);
  assert.deepEqual(fixture.calls.replaceLocal[0], result.record);
  assert.equal(result.syncState, 'synced');
});

test('different books pause synchronization until the user chooses', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: CLOUD_RECORD_DIFFERENT_BOOK });
  const result = await fixture.controller.initialize();
  assert.equal(result.syncState, 'conflict');
  assert.equal(fixture.calls.replaceLocal.length, 0);
  assert.equal(fixture.calls.mergeProgress.length, 0);
});

test('a pending completion delete runs before a newer local upload', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, pendingDelete: COMPLETED_RECORD, localRecord: NEW_LOCAL_RECORD });
  await fixture.controller.initialize();
  assert.deepEqual(fixture.calls.order.slice(0, 2), ['clearProgress', 'mergeProgress']);
  assert.equal(fixture.calls.clearPendingDelete, 1);
});

test('rapid local writes coalesce into one newest upload after 600 ms', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.controller.notifyLocalProgress(NEW_LOCAL_RECORD);
  assert.equal(fixture.calls.timers.filter((timer) => timer.delayMs === 600).length, 1);
  const timer = fixture.calls.timers.find((entry) => entry.delayMs === 600);
  await timer.callback();
  assert.deepEqual(fixture.calls.mergeProgress.at(-1), NEW_LOCAL_RECORD);
});

test('newer write during upload is merged with response and remains pending', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value, calls) => { if (calls.mergeProgress.length === 1) await pending; return { status: 'merged', record: value }; },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  const timer = fixture.calls.timers.find((entry) => entry.delayMs === 600);
  const running = timer.callback();
  fixture.controller.notifyLocalProgress(NEW_LOCAL_RECORD);
  release();
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.calls.replaceLocal.at(-1).completedPairIds, ['pair-1', 'pair-2']);
  assert.equal(fixture.calls.timers.filter((entry) => entry.delayMs === 600).length, 2);
});

test('online failures use exactly three finite retry delays', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async () => { throw new Error('temporary'); },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  for (const delay of [600, 5000, 30000, 120000]) {
    const timer = fixture.calls.timers.find((entry) => entry.delayMs === delay && !entry.ran);
    assert.ok(timer);
    timer.ran = true;
    await timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.calls.timers.filter((entry) => [5000, 30000, 120000].includes(entry.delayMs)).length, 3);
});

test('offline notification schedules no timer and online retry uploads immediately', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null, online: false });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  assert.equal(fixture.calls.timers.length, 0);
  fixture.setOnline(true);
  await fixture.controller.retry();
  assert.equal(fixture.calls.mergeProgress.length, 1);
});

test('RPC conflict leaves the local record untouched', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value) => ({ status: 'conflict', record: { ...value, completedPairIds: ['pair-2'] } }),
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(NEW_LOCAL_RECORD);
  await fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.replaceLocal.length, 0);
  assert.equal(fixture.controller.getSnapshot().syncState, 'conflict');
});

test('subscriptions receive state changes and unsubscribe works', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null });
  const states = [];
  const unsubscribe = fixture.controller.subscribe((value) => states.push(value.syncState));
  await fixture.controller.initialize();
  assert.ok(states.includes('initializing'));
  unsubscribe();
  const before = states.length;
  fixture.controller.notifyLocalProgress(NEW_LOCAL_RECORD);
  assert.equal(states.length, before);
});

test('scheduled upload cannot cross accounts', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null });
  await fixture.controller.initialize();
  const baseline = fixture.calls.mergeProgress.length;
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.setUser({ id: 'user-b' });
  const timer = fixture.calls.timers.find((entry) => entry.delayMs === 600);
  await timer.callback();
  assert.equal(fixture.calls.mergeProgress.length, baseline);
  fixture.controller.notifyLocalProgress(NEW_LOCAL_RECORD);
  const bTimer = fixture.calls.timers.at(-1);
  await bTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.mergeUsers.at(-1), 'user-b');
  assert.equal(fixture.calls.mergeProgress.at(-1).clientUpdatedAt, 3000);
});

test('completion saves pending marker before clearing local progress', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null });
  await fixture.controller.initialize();
  fixture.controller.notifyChallengeComplete(LOCAL_RECORD);
  assert.deepEqual(fixture.calls.order.slice(-2), ['savePendingDelete', 'clearLocal']);
  assert.equal(fixture.controller.getSnapshot().record, null);
});

test('explicit reset clears cloud before local progress', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null });
  await fixture.controller.initialize();
  await fixture.controller.clearActiveChallenge(LOCAL_RECORD);
  assert.deepEqual(fixture.calls.order.slice(-2), ['clearProgress', 'clearLocal']);
});

test('manual retry processes a persisted completion marker before progress', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null, online: false });
  await fixture.controller.initialize();
  fixture.controller.notifyChallengeComplete(LOCAL_RECORD);
  fixture.setOnline(true);
  await fixture.controller.retry();
  assert.equal(fixture.calls.clearProgress.length, 1);
  assert.equal(fixture.calls.mergeProgress.length, 0);
  assert.equal(fixture.calls.clearPendingDelete, 1);
});

test('local-only initialization failure remains retryable', async () => {
  let attempts = 0;
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null,
    mergeBehavior: async (value) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary merge failure');
      return { status: 'merged', record: value };
    },
  });
  const first = await fixture.controller.initialize();
  assert.equal(first.syncState, 'error');
  const second = await fixture.controller.retry();
  assert.equal(attempts, 2);
  assert.equal(second.syncState, 'synced');
});

test('cloud fetch failure remains retryable through manual retry', async () => {
  let fetches = 0;
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null,
    fetchBehavior: async () => { fetches += 1; if (fetches === 1) throw new Error('fetch failure'); return null; },
  });
  const first = await fixture.controller.initialize();
  assert.equal(first.syncState, 'error');
  const second = await fixture.controller.retry();
  assert.equal(fetches, 2);
  assert.equal(second.syncState, 'synced');
});

test('in-flight upload completion after sign-out cannot mutate guest state', async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value) => { await deferred; return { status: 'merged', record: value }; },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  const timer = fixture.calls.timers.find((entry) => entry.delayMs === 600);
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.controller.signOut();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.controller.getSnapshot().syncState, 'guest');
  assert.equal(fixture.calls.replaceLocal.length, 0);
});

test('explicit reset invalidates an in-flight upload and keeps local cleared', async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value) => { await deferred; return { status: 'merged', record: value }; },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  const reset = fixture.controller.clearActiveChallenge(LOCAL_RECORD);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await reset;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.clearLocal, 1);
  assert.equal(fixture.calls.replaceLocal.length, 0);
  assert.equal(fixture.controller.getSnapshot().record, null);
});

test('completion invalidates an in-flight upload and preserves its marker', async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value) => { await deferred; return { status: 'merged', record: value }; },
    online: true,
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.controller.notifyChallengeComplete(LOCAL_RECORD);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.replaceLocal.length, 0);
  assert.equal(fixture.controller.getSnapshot().record, null);
  assert.equal(fixture.calls.savePendingDelete.length, 1);
});

test('different-book newer write is retained when old upload succeeds', async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const otherBook = { ...LOCAL_RECORD, bookId: 'cet4', scope: 'full', completedPairIds: ['pair-a'], clientUpdatedAt: 4000 };
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value, calls) => { if (calls.mergeProgress.length === 1) await deferred; return { status: 'merged', record: value }; },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.controller.notifyLocalProgress(otherBook);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.replaceLocal.length, 0);
  assert.equal(fixture.controller.getSnapshot().conflict.local.record.bookId, 'cet4');
});

test('background conflict uses newest local record and cloud vocabulary totals', async () => {
  const otherBook = { ...LOCAL_RECORD, bookId: 'cet4', scope: 'full', completedPairIds: ['pair-a'], clientUpdatedAt: 4000 };
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value) => ({ status: 'conflict', record: { ...value, bookId: 'cet4', scope: 'full', completedPairIds: ['pair-a'] } }),
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.controller.notifyLocalProgress(otherBook);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  const result = fixture.controller.getSnapshot();
  assert.equal(result.syncState, 'conflict');
  assert.equal(result.conflict.local.record.bookId, 'cet4');
  assert.equal(result.conflict.cloud.totalPairs, 4);
});

test('completion changed clears stale marker and reconciles current cloud challenge', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: CLOUD_RECORD_DIFFERENT_BOOK,
    clearBehavior: async (_value, calls) => calls.clearProgress.length === 1 ? 'changed' : 'cleared',
  });
  await fixture.controller.initialize();
  fixture.controller.notifyChallengeComplete(LOCAL_RECORD);
  const completionTimer = fixture.calls.timers.find((entry) => entry.delayMs === 0);
  await completionTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.clearPendingDelete, 1);
  assert.equal(fixture.controller.getSnapshot().conflict, null);
  assert.equal(fixture.controller.getSnapshot().record.bookId, 'cet4');
});

test('user snapshots recursively remove credentials and isolate nested mutation', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a', profile: { name: 'A', sessionToken: 'hidden' } }, localRecord: null, cloudRecord: null });
  const result = await fixture.controller.initialize();
  assert.equal(result.user.profile.sessionToken, undefined);
  result.user.profile.name = 'mutated';
  assert.equal(fixture.controller.getSnapshot().user.profile.name, 'A');
});

test('direct account switch discards A pending data and lets B schedule its own upload', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.setUser({ id: 'user-b' });
  await fixture.controller.retry();
  const bRecord = { ...LOCAL_RECORD, clientUpdatedAt: 9000 };
  fixture.controller.notifyLocalProgress(bRecord);
  const timer = fixture.calls.timers.at(-1);
  await timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.calls.mergeUsers, ['user-b']);
  assert.equal(fixture.calls.mergeProgress.at(-1).clientUpdatedAt, 9000);
});

test('initialization load await cannot write after account switch', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: CLOUD_RECORD_SAME_BOOK,
    loadVocabulary: async (bookId, scope) => { await gate; return VOCABULARIES[`${bookId}:${scope}`]; },
  });
  const initializing = fixture.controller.initialize();
  fixture.setUser({ id: 'user-b' });
  await fixture.controller.signOut();
  release();
  await initializing;
  assert.equal(fixture.controller.getSnapshot().syncState, 'guest');
  assert.equal(fixture.calls.replaceLocal.length, 0);
});

test('background response vocabulary await cannot write after account switch', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let vocabularyCalls = 0;
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value) => ({ status: 'merged', record: value }),
    loadVocabulary: async (bookId, scope) => { vocabularyCalls += 1; if (vocabularyCalls >= 1) await gate; return VOCABULARIES[`${bookId}:${scope}`]; },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.setUser({ id: 'user-b' });
  await fixture.controller.signOut();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.replaceLocal.length, 0);
  assert.equal(fixture.controller.getSnapshot().syncState, 'guest');
});

test('changed reset reconciliation failure rejects and keeps local progress', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null,
    clearBehavior: async () => 'changed', fetchBehavior: async () => { throw new Error('fetch down'); },
  });
  await assert.rejects(() => fixture.controller.clearActiveChallenge(LOCAL_RECORD));
  assert.equal(fixture.calls.clearLocal, 0);
  assert.equal(fixture.controller.getSnapshot().syncState, 'error');
});

test('completion marker survives controller recreation and initializes away', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null, online: false });
  await fixture.controller.initialize();
  fixture.controller.notifyChallengeComplete(LOCAL_RECORD);
  const recreated = createSyncController({
    auth: fixture.auth, cloud: {
      fetchProgress: async () => null,
      mergeProgress: async (value) => ({ status: 'merged', record: value }),
      replaceProgress: async (value) => value,
      clearProgress: async () => 'cleared',
    }, local: fixture.localAdapter, pendingDeletes: fixture.pending,
    loadVocabulary: async (bookId, scope) => VOCABULARIES[`${bookId}:${scope}`],
    setTimer: (callback, delayMs) => ({ callback, delayMs }), clearTimer: () => {}, isOnline: () => true,
  });
  await recreated.initialize();
  assert.equal(fixture.calls.clearPendingDelete, 1);
});

test('background rejection updates error state without an unhandled rejection', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null, mergeBehavior: async () => { throw new Error('upload failed'); } });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.controller.getSnapshot().syncState, 'error');
  assert.equal(fixture.controller.getSnapshot().error.message, 'upload failed');
});

test('cloud-only initialization restores cloud progress locally', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: CLOUD_RECORD_SAME_BOOK });
  const result = await fixture.controller.initialize();
  assert.equal(result.syncState, 'synced');
  assert.equal(fixture.calls.replaceLocal.length, 1);
});

test('malformed cloud record preserves valid local progress', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: { ...CLOUD_RECORD_SAME_BOOK, attempts: 'bad' } });
  const result = await fixture.controller.initialize();
  assert.equal(result.syncState, 'error');
  assert.deepEqual(result.record, LOCAL_RECORD);
  assert.equal(fixture.calls.replaceLocal.length, 0);
});

test('conflict resolution validates choices and supports cloud and local choices', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: CLOUD_RECORD_DIFFERENT_BOOK });
  await fixture.controller.initialize();
  await assert.rejects(() => fixture.controller.resolveConflict('invalid'));
  await fixture.controller.resolveConflict('cloud');
  assert.equal(fixture.calls.replaceLocal.length, 1);
  const second = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: CLOUD_RECORD_DIFFERENT_BOOK });
  await second.controller.initialize();
  await second.controller.resolveConflict('local');
  assert.equal(second.calls.replaceProgress.length, 1);
});

test('retry timer sequence has no fourth retry', async () => {
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null, mergeBehavior: async () => { throw new Error('down'); } });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  for (const delay of [600, 5000, 30000, 120000]) {
    const timer = fixture.calls.timers.find((entry) => entry.delayMs === delay && !entry.ran);
    timer.ran = true; timer.callback(); await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(fixture.calls.timers.map((entry) => entry.delayMs), [600, 5000, 30000, 120000]);
});

test('subscriptions expose syncing, offline, error, and synced transitions', async () => {
  let attempts = 0;
  const fixture = createControllerFixture({ authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null, mergeBehavior: async (value) => { attempts += 1; if (attempts === 1) throw new Error('retry'); return { status: 'merged', record: value }; } });
  const states = [];
  fixture.controller.subscribe((value) => states.push(value.syncState));
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(states.includes('error'));
  await fixture.controller.retry();
  fixture.setOnline(false);
  fixture.controller.notifyLocalProgress(NEW_LOCAL_RECORD);
  assert.ok(states.includes('syncing'));
  assert.ok(states.includes('error'));
  assert.ok(states.includes('offline'));
  assert.ok(states.includes('synced'));
});

test('initialization conflict response normalizes against its own vocabulary', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: null,
    mergeBehavior: async (value) => ({ status: 'conflict', record: { ...value, bookId: 'cet4', scope: 'full', completedPairIds: ['pair-a'] } }),
  });
  const result = await fixture.controller.initialize();
  assert.equal(result.syncState, 'conflict');
  assert.equal(result.conflict.cloud.totalPairs, 4);
});

test('vocabulary load failure preserves local record', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: LOCAL_RECORD, cloudRecord: CLOUD_RECORD_DIFFERENT_BOOK,
    loadVocabulary: async (bookId, scope) => {
      if (bookId === 'cet4' && scope === 'full') throw new Error('cloud vocabulary unavailable');
      return VOCABULARIES[`${bookId}:${scope}`];
    },
  });
  const result = await fixture.controller.initialize();
  assert.equal(result.syncState, 'error');
  assert.deepEqual(result.record, LOCAL_RECORD);
  assert.equal(fixture.calls.replaceLocal.length, 0);
});

test('stale pending-delete rejection after sign-out cannot overwrite guest state', async () => {
  let reject;
  const deferred = new Promise((_resolve, fail) => { reject = fail; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, pendingDelete: COMPLETED_RECORD, localRecord: LOCAL_RECORD, cloudRecord: null,
    clearBehavior: async () => deferred,
  });
  const initializing = fixture.controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.controller.signOut();
  reject(new Error('stale delete failure'));
  await initializing;
  assert.equal(fixture.controller.getSnapshot().syncState, 'guest');
  assert.equal(fixture.calls.clearPendingDelete, 0);
});

test('stale upload rejection after sign-out does not requeue A or schedule retry', async () => {
  let reject;
  const deferred = new Promise((_resolve, fail) => { reject = fail; });
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async () => deferred,
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.controller.signOut();
  reject(new Error('stale upload failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.controller.getSnapshot().syncState, 'guest');
  assert.equal(fixture.calls.timers.filter((entry) => [5000, 30000, 120000].includes(entry.delayMs)).length, 0);
});

test('B upload proceeds after A flight is detached during direct account switch', async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const bRecord = { ...LOCAL_RECORD, clientUpdatedAt: 9000 };
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, localRecord: null, cloudRecord: null,
    mergeBehavior: async (value, calls) => {
      if (calls.mergeUsers.at(-1) === 'user-a') await deferred;
      return { status: 'merged', record: value };
    },
  });
  await fixture.controller.initialize();
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  fixture.calls.timers.find((entry) => entry.delayMs === 600).callback();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.setUser({ id: 'user-b' });
  fixture.controller.notifyLocalProgress(bRecord);
  const bTimer = fixture.calls.timers.at(-1);
  await bTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.calls.mergeUsers, ['user-a', 'user-b']);
  assert.equal(fixture.calls.mergeProgress.at(-1).clientUpdatedAt, 9000);
});
