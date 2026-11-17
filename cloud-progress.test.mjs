import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudProgressService, CloudProgressError } from './cloud-progress.js';

const LOCAL_RECORD = {
  bookId: 'postgrad', scope: 'frequent', seed: 42,
  completedPairIds: ['pair-1'], score: 100,
  correctMatches: 1, attempts: 2, clientUpdatedAt: 1000,
};

const CLOUD_ROW = {
  user_id: 'user-a', book_id: 'postgrad', scope: 'frequent', seed: '42',
  completed_pair_ids: ['pair-1'], score: 100, correct_matches: 1, attempts: 2,
  client_updated_at: new Date(1000).toISOString(),
  updated_at: new Date(2000).toISOString(),
};

const createCloudFixture = ({ user = { id: 'user-a' }, row = CLOUD_ROW,
  rpcResult = { status: 'merged', record: CLOUD_ROW }, fetchResult,
  upsertResult, deleteResult = { data: [{ user_id: 'user-a' }], error: null },
  rpcError, fetchError, upsertError, deleteError, getUser, onFetch } = {}) => {
  const calls = { rpc: [], upsert: [], deleteFilters: [], fetchFilters: [], select: [], from: [], maybeSingle: 0, single: 0 };
  const result = (data, error) => Promise.resolve({ data, error: error ?? null });
  const client = {
    from(table) {
      calls.from.push(table);
      const query = {
        _mode: 'read',
        select(columns) {
          calls.select.push(columns);
          query._columns = columns;
          if (query._mode === 'delete') {
            return deleteError ? Promise.reject(deleteError) : result(deleteResult.data, deleteResult.error);
          }
          return query;
        },
        maybeSingle() {
          calls.maybeSingle += 1;
          if (onFetch) onFetch(query);
          let data = fetchResult === undefined ? row : fetchResult;
          if (query.filters?.user_id && data?.user_id !== query.filters.user_id) data = null;
          return fetchError ? Promise.reject(fetchError) : result(data, null);
        },
        single() {
          calls.single += 1;
          return upsertError ? Promise.reject(upsertError) : result(upsertResult === undefined ? row : upsertResult, null);
        },
        upsert(payload, options) {
          calls.upsert.push({ ...payload, options });
          query._mode = 'upsert';
          return query;
        },
        delete() {
          query._mode = 'delete';
          return query;
        },
        filters: {},
        eq(column, value) {
          if (query._mode === 'delete') calls.deleteFilters.push({ [column]: value });
          else {
            calls.fetchFilters.push({ [column]: value });
            query.filters[column] = value;
          }
          return query;
        },
      };
      return query;
    },
    rpc(name, params) {
      calls.rpc.push({ name, params });
      return rpcError ? Promise.reject(rpcError) : result(rpcResult, null);
    },
  };
  const service = createCloudProgressService({ client, getUser: getUser ?? (() => user) });
  return { service, calls, client };
};

test('mergeProgress sends the normalized record to the atomic RPC', async () => {
  const fixture = createCloudFixture({ rpcResult: { status: 'merged', record: CLOUD_ROW } });
  const result = await fixture.service.mergeProgress(LOCAL_RECORD);

  assert.deepEqual(fixture.calls.rpc[0], {
    name: 'merge_challenge_progress',
    params: {
      p_book_id: 'postgrad', p_scope: 'frequent', p_seed: 42,
      p_completed_pair_ids: ['pair-1'], p_score: 100,
      p_correct_matches: 1, p_attempts: 2,
      p_client_updated_at: new Date(1000).toISOString(),
    },
  });
  assert.equal(result.status, 'merged');
});

test('outgoing records deduplicate pair ids in first-seen order', async () => {
  const fixture = createCloudFixture({});
  await fixture.service.mergeProgress({ ...LOCAL_RECORD, completedPairIds: ['pair-2', 'pair-1', 'pair-2'] });
  assert.deepEqual(fixture.calls.rpc[0].params.p_completed_pair_ids, ['pair-2', 'pair-1']);
});

test('outgoing records reject unsafe seeds, counters, and pair ids', async () => {
  const invalidRecords = [
    { ...LOCAL_RECORD, seed: Number.MAX_SAFE_INTEGER + 1 },
    { ...LOCAL_RECORD, completedPairIds: ['pair-1', 2] },
    { ...LOCAL_RECORD, score: -1 },
    { ...LOCAL_RECORD, correctMatches: 3 },
    { ...LOCAL_RECORD, clientUpdatedAt: Infinity },
  ];
  for (const record of invalidRecords) {
    const fixture = createCloudFixture({});
    await assert.rejects(() => fixture.service.mergeProgress(record), CloudProgressError);
  }
});

test('replaceProgress always uses the authenticated user id', async () => {
  const fixture = createCloudFixture({ user: { id: 'user-a' } });
  await fixture.service.replaceProgress(LOCAL_RECORD);
  assert.equal(fixture.calls.upsert[0].user_id, 'user-a');
});

test('clearProgress is restricted to the expected challenge', async () => {
  const fixture = createCloudFixture({ user: { id: 'user-a' } });
  await fixture.service.clearProgress(LOCAL_RECORD);
  assert.deepEqual(Object.assign({}, ...fixture.calls.deleteFilters), {
    user_id: 'user-a', book_id: 'postgrad', scope: 'frequent',
    client_updated_at: new Date(1000).toISOString(),
  });
});

test('rejects every operation when no valid authenticated user exists', async () => {
  for (const user of [null, {}, { id: '' }, { id: 42 }]) {
    const fixture = createCloudFixture({ user });
    for (const operation of [
      () => fixture.service.fetchProgress(),
      () => fixture.service.mergeProgress(LOCAL_RECORD),
      () => fixture.service.replaceProgress(LOCAL_RECORD),
      () => fixture.service.clearProgress(LOCAL_RECORD),
    ]) {
      await assert.rejects(operation, (error) => error instanceof CloudProgressError);
    }
    assert.equal(fixture.calls.from.length, 0);
    assert.equal(fixture.calls.rpc.length, 0);
  }
});

test('aborts clearProgress when the account changes before its fallback read', async () => {
  let currentUser = { id: 'user-a' };
  let releaseDelete;
  const deleteFinished = new Promise((resolve) => { releaseDelete = resolve; });
  const calls = { from: [], fallbackReads: 0 };
  const client = {
    from(table) {
      calls.from.push(table);
      const query = {
        _deleted: false,
        delete: () => { query._deleted = true; return query; },
        _filtered: false,
        eq: () => { query._filtered = true; return query; },
        select: () => {
          if (query._filtered && !query._deleted) calls.fallbackReads += 1;
          return deleteFinished;
        },
      };
      return query;
    },
  };
  const service = createCloudProgressService({ client, getUser: () => currentUser });
  const pending = service.clearProgress(LOCAL_RECORD);
  currentUser = { id: 'user-b' };
  releaseDelete({ data: [], error: null });
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CloudProgressError);
    assert.equal(error.code, 'account_changed');
    return true;
  });
  assert.equal(calls.fallbackReads, 0);
});

test('pins the fallback read to user A and rejects a switch during its response', async () => {
  let currentUser = { id: 'user-a' };
  const fixture = createCloudFixture({
    row: { ...CLOUD_ROW, user_id: 'user-b' },
    deleteResult: { data: [], error: null },
    getUser: () => currentUser,
    onFetch: (query) => {
      if (query.filters.user_id === 'user-a') currentUser = { id: 'user-b' };
    },
  });

  await assert.rejects(
    () => fixture.service.clearProgress(LOCAL_RECORD),
    (error) => error instanceof CloudProgressError && error.code === 'account_changed',
  );
  assert.deepEqual(fixture.calls.fetchFilters, [{ user_id: 'user-a' }]);
});

test('fetchProgress returns null for an empty maybeSingle result', async () => {
  const fixture = createCloudFixture({ fetchResult: null });
  assert.equal(await fixture.service.fetchProgress(), null);
});

test('fetchProgress maps a valid row including serverUpdatedAt', async () => {
  const fixture = createCloudFixture({});
  assert.deepEqual(await fixture.service.fetchProgress(), {
    bookId: 'postgrad', scope: 'frequent', seed: 42,
    completedPairIds: ['pair-1'], score: 100, correctMatches: 1, attempts: 2,
    clientUpdatedAt: 1000, serverUpdatedAt: 2000,
  });
  assert.equal(fixture.calls.select[0], 'book_id, scope, seed, completed_pair_ids, score, correct_matches, attempts, client_updated_at, updated_at');
});

test('rejects malformed cloud rows before returning them', async () => {
  const malformed = [
    { ...CLOUD_ROW, book_id: 'invalid' },
    { ...CLOUD_ROW, scope: 'other' },
    { ...CLOUD_ROW, seed: '9007199254740992' },
    { ...CLOUD_ROW, seed: ' 42' },
    { ...CLOUD_ROW, seed: '4e1' },
    { ...CLOUD_ROW, seed: '042' },
    { ...CLOUD_ROW, completed_pair_ids: ['pair-1', 2] },
    { ...CLOUD_ROW, completed_pair_ids: ['pair-1', 'pair-1'] },
    { ...CLOUD_ROW, score: -1 },
    { ...CLOUD_ROW, correct_matches: 1.5 },
    { ...CLOUD_ROW, attempts: -1 },
    { ...CLOUD_ROW, correct_matches: 3 },
    { ...CLOUD_ROW, client_updated_at: 'bad date' },
    { ...CLOUD_ROW, updated_at: 'bad date' },
  ];
  for (const row of malformed) {
    const fixture = createCloudFixture({ fetchResult: row });
    await assert.rejects(() => fixture.service.fetchProgress(), CloudProgressError);
  }
});

test('rejects client timestamps that cannot be serialized as ISO dates', async () => {
  const fixture = createCloudFixture({});
  await assert.rejects(
    () => fixture.service.mergeProgress({ ...LOCAL_RECORD, clientUpdatedAt: 8640000000000001 }),
    (error) => error instanceof CloudProgressError && error.code === 'invalid_record',
  );
  assert.equal(fixture.calls.rpc.length, 0);
});

test('mergeProgress normalizes merged and conflict RPC rows', async () => {
  for (const status of ['merged', 'conflict']) {
    const fixture = createCloudFixture({ rpcResult: { status, record: CLOUD_ROW } });
    const result = await fixture.service.mergeProgress(LOCAL_RECORD);
    assert.equal(result.status, status);
    assert.equal(result.record.serverUpdatedAt, 2000);
  }
});

test('mergeProgress rejects unknown status and malformed result', async () => {
  for (const rpcResult of [
    { status: 'unknown', record: CLOUD_ROW },
    { status: 'merged', record: { ...CLOUD_ROW, attempts: -1 } },
    { status: 'merged' },
  ]) {
    const fixture = createCloudFixture({ rpcResult });
    await assert.rejects(() => fixture.service.mergeProgress(LOCAL_RECORD), CloudProgressError);
  }
});

test('replaceProgress sends only explicit fields, conflict target, and exact columns', async () => {
  const fixture = createCloudFixture({});
  await fixture.service.replaceProgress({ ...LOCAL_RECORD, serverUpdatedAt: 9999, extra: 'omit' });
  assert.deepEqual(fixture.calls.upsert[0], {
    user_id: 'user-a', book_id: 'postgrad', scope: 'frequent', seed: 42,
    completed_pair_ids: ['pair-1'], score: 100, correct_matches: 1,
    attempts: 2, client_updated_at: new Date(1000).toISOString(),
    options: { onConflict: 'user_id' },
  });
  assert.equal(fixture.calls.select.at(-1), 'book_id, scope, seed, completed_pair_ids, score, correct_matches, attempts, client_updated_at, updated_at');
});

test('clearProgress returns cleared when one row is deleted', async () => {
  const fixture = createCloudFixture({ deleteResult: { data: [{ user_id: 'user-a' }], error: null } });
  assert.equal(await fixture.service.clearProgress(LOCAL_RECORD), 'cleared');
});

test('clearProgress distinguishes empty and changed after no deletion', async () => {
  const empty = createCloudFixture({ deleteResult: { data: [], error: null }, fetchResult: null });
  assert.equal(await empty.service.clearProgress(LOCAL_RECORD), 'empty');
  assert.deepEqual(empty.calls.fetchFilters, [{ user_id: 'user-a' }]);
  const changed = createCloudFixture({ deleteResult: { data: [], error: null }, fetchResult: CLOUD_ROW });
  assert.equal(await changed.service.clearProgress(LOCAL_RECORD), 'changed');
  assert.deepEqual(changed.calls.fetchFilters, [{ user_id: 'user-a' }]);
});

test('same book/scope newer client timestamp is not deleted and returns changed', async () => {
  const newerRow = { ...CLOUD_ROW, client_updated_at: new Date(2000).toISOString(), updated_at: new Date(3000).toISOString() };
  const fixture = createCloudFixture({ deleteResult: { data: [], error: null }, fetchResult: newerRow });
  assert.equal(await fixture.service.clearProgress(LOCAL_RECORD), 'changed');
  assert.deepEqual(Object.assign({}, ...fixture.calls.deleteFilters), {
    user_id: 'user-a', book_id: 'postgrad', scope: 'frequent',
    client_updated_at: new Date(1000).toISOString(),
  });
});

test('clearProgress rejects missing or invalid expected timestamps', async () => {
  const fixture = createCloudFixture({});
  for (const clientUpdatedAt of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    await assert.rejects(
      () => fixture.service.clearProgress({ bookId: 'postgrad', scope: 'frequent', clientUpdatedAt }),
      (error) => error instanceof CloudProgressError && error.code === 'invalid_record',
    );
  }
  assert.equal(fixture.calls.from.length, 0);
});

test('wraps Supabase result errors and rejected network promises with their causes', async () => {
  const responseError = new Error('permission denied');
  const responseFixture = createCloudFixture({ fetchError: null });
  responseFixture.client.from = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: responseError }) }) });
  await assert.rejects(() => responseFixture.service.fetchProgress(), (error) => {
    assert.ok(error instanceof CloudProgressError);
    assert.equal(error.cause, responseError);
    return true;
  });
  responseFixture.client.from = () => ({ select: () => ({ maybeSingle: async () => ({ error: responseError }) }) });
  await assert.rejects(() => responseFixture.service.fetchProgress(), (error) => {
    assert.ok(error instanceof CloudProgressError);
    assert.equal(error.cause, responseError);
    return true;
  });
  const networkError = new Error('network down');
  const networkFixture = createCloudFixture({ rpcError: networkError });
  await assert.rejects(() => networkFixture.service.mergeProgress(LOCAL_RECORD), (error) => {
    assert.ok(error instanceof CloudProgressError);
    assert.equal(error.cause, networkError);
    assert.equal(error.code, 'offline');
    return true;
  });
});

