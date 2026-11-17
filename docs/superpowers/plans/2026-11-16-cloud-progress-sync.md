# 云端进度同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 GitHub Pages 单词消消乐增加邮箱验证码登录、Supabase 云端进度和跨设备恢复，同时保留完整游客模式与离线本机保存。

**Architecture:** 核心游戏继续完全独立于网络；`challenge-progress.js` 负责本机记录，新的纯函数同步模型决定合并或冲突，认证和云端读写分别封装。`ui.js` 只编排状态与页面，所有云端失败都降级到本机进度。Supabase 使用一条“当前挑战”记录、RLS 和原子合并函数，不引入自建服务器。

**Tech Stack:** 原生 HTML/CSS/ES modules、Node.js `node:test`、Supabase Auth、Supabase Postgres/PostgREST/RPC、GitHub Pages。

**Spec:** `docs/superpowers/specs/2026-11-16-cloud-progress-sync-design.md`

## Global Constraints

- 游客无需登录即可完整游玩，登录不是开始挑战的前置条件。
- 游戏先写 `localStorage`，再异步同步；网络失败不得阻塞匹配、计时器或复习页面。
- 每个账号最多保存一条未完成挑战；完成或确认重置后删除该记录。
- 登录方式为邮箱六位验证码，不增加密码或社交登录。
- 网站继续直接部署到 GitHub Pages，不增加构建步骤或自建服务器。
- 前端只能使用公开的 Supabase URL 与 `anon key`；不得接触或提交 `service_role key`。
- Supabase 不可用时核心游戏仍能加载并使用本机进度。
- Supabase 浏览器客户端固定使用 `@supabase/supabase-js@2.45.4`，不得引用浮动的 `@2` 标签。
- 保留 60 秒、15 个词块、6 对同义词、3 个干扰词以及现有动画和复习流程。
- 桌面、平板和 390px 手机布局不得横向溢出或遮挡词块。
- 当前目录不是本地 Git 仓库；不得使用 Git CLI 或 Sourcetree 提交。全部代码验证完成后，通过 GitHub 网站上传，点击最终提交前再次取得用户确认。
- 正式开放给任意邮箱前，在 Supabase 配置可用于公众邮件的 SMTP 服务；默认邮件服务只用于联调。

---

## File Structure

### Create

- `sync-model.js`：校验同步记录，判断本机/云端合并、冲突和空状态。
- `sync-model.test.mjs`：同步决策、合集、幂等和更新时间规则。
- `supabase-config.js`：公开 Supabase 配置与动态客户端模块地址；未配置时返回游客模式。
- `auth.js`：邮箱验证码、会话恢复、退出和脱敏邮箱。
- `auth.test.mjs`：使用完整形状的假 Supabase Auth 客户端验证认证边界。
- `cloud-progress.js`：云端读取、原子合并、明确替换和删除。
- `cloud-progress.test.mjs`：验证 RPC 参数、错误传播与记录转换。
- `sync-controller.js`：认证、本机记录、云端记录、离线重试和冲突选择的协调器。
- `sync-controller.test.mjs`：端到端状态机测试，不依赖 DOM。
- `supabase/schema.sql`：表、约束、RLS、触发器和原子合并函数。
- `supabase/SETUP.md`：Supabase、验证码模板、SMTP、URL 和发布配置。

### Modify

- `challenge-progress.js`：记录版本升级、`clientUpdatedAt` 和向后兼容迁移。
- `challenge-progress.test.mjs`：旧记录迁移和更新时间测试。
- `index.html`：账户按钮、验证码弹窗、同步冲突弹窗和资源版本。
- `styles.css`：账户、同步状态和两个新弹窗的桌面/平板/手机样式。
- `ui.js`：初始化同步控制器、暂停/恢复登录弹窗计时、保存通知、冲突选择、登录状态和云端重置。
- `package.json`：测试命令仍为 `node --test *.test.mjs`，不添加运行时构建依赖。

## Shared Contracts

All modules use the following normalized record. The persisted local object adds `version: 2`; database rows use snake_case names, but neither representation leaks across its adapter boundary.

```js
/**
 * @typedef {Object} SyncRecord
 * @property {'ielts'|'cet6'|'postgrad'|'cet4'} bookId
 * @property {'frequent'|'full'} scope
 * @property {number} seed
 * @property {string[]} completedPairIds
 * @property {number} score
 * @property {number} correctMatches
 * @property {number} attempts
 * @property {number} clientUpdatedAt Epoch milliseconds.
 * @property {number=} serverUpdatedAt Epoch milliseconds; cloud reads only.
 */
```

`createAuthService` keeps one initialized client and exposes this exact boundary:

```js
{
  initialize(): Promise<{ status: 'guest'|'authenticated', user: object|null,
    configured: boolean, error?: AuthError }>,
  sendOtp(email: string): Promise<void>,
  verifyOtp(email: string, token: string): Promise<object>,
  signOut(): Promise<void>,
  getSession(): Promise<object|null>,
  getUser(): object|null,
  getClient(): object|null,
  subscribe(listener: (snapshot: object) => void): () => void,
}
```

The controller receives adapters rather than touching browser globals directly:

```js
createSyncController({
  auth,
  cloud, // null in guest/unconfigured mode
  local: {
    getSelection(): { bookId: string, scope: string }|null,
    load(vocabulary: object): SyncRecord|null,
    replace(record: SyncRecord): void,
    clear(): void,
  },
  pendingDeletes: {
    load(userId: string): object|null,
    save(userId: string, record: SyncRecord): void,
    clear(userId: string): void,
  },
  loadVocabulary(bookId: string, scope: string): Promise<object>,
  now: () => number,
  setTimer: (callback: Function, delayMs: number) => unknown,
  clearTimer: (timerId: unknown) => void,
  isOnline: () => boolean,
})
```

`ControllerSnapshot` is always `{ syncState, record, user, conflict, error }`. `syncState` is one of `guest`, `initializing`, `syncing`, `synced`, `offline`, `error`, or `conflict`; absent values are `null`. A conflict is `{ local: { record, totalPairs }, cloud: { record, totalPairs } }`, which gives the dialog exact counts without loading data in the DOM layer. The controller exposes `getSnapshot()` and `subscribe(listener)` so background uploads can update the DOM without polling.

---

### Task 1: Upgrade Local Records and Add Pure Sync Decisions

**Files:**
- Modify: `challenge-progress.js:1-65`
- Modify: `challenge-progress.test.mjs`
- Create: `sync-model.js`
- Create: `sync-model.test.mjs`

**Interfaces:**
- Produces: `normalizeSyncRecord(record, vocabulary)`
- Produces: `mergeSameChallenge(localRecord, cloudRecord)`
- Produces: `decideProgressSync(localRecord, cloudRecord)`
- Updates: `saveChallengeProgress(storage, state, nowMs = Date.now()) -> SyncRecord`
- Produces: `replaceChallengeProgress(storage, record)` preserving `clientUpdatedAt`
- Produces: `savePendingCloudDelete(storage, userId, record)` and matching load/clear helpers
- Updates: `loadChallengeProgress(storage, vocabulary)` returns `clientUpdatedAt`
- Updates: `getChallengeProgressSelection(storage)` accepts versions 1 and 2

- [ ] **Step 1: Write failing migration and merge tests**

Add cases equivalent to:

```js
test('loads a version-one record with a stable migration timestamp', () => {
  const storage = createStorage();
  storage.setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify({
    version: 1,
    bookId: 'postgrad',
    scope: 'frequent',
    seed: 42,
    score: 70,
    correctMatches: 1,
    attempts: 2,
    completedPairIds: ['pair-1'],
  }));

  assert.equal(loadChallengeProgress(storage, VOCABULARY)?.clientUpdatedAt, 0);
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

test('different active books require an explicit conflict choice', () => {
  assert.equal(
    decideProgressSync(
      { bookId: 'cet4', scope: 'full', completedPairIds: [], clientUpdatedAt: 10 },
      { bookId: 'ielts', scope: 'frequent', completedPairIds: [], clientUpdatedAt: 20 },
    ).type,
    'conflict',
  );
});

test('a synchronized replacement preserves the source client timestamp', () => {
  const storage = createStorage();
  replaceChallengeProgress(storage, {
    bookId: 'postgrad', scope: 'full', seed: 42,
    completedPairIds: ['pair-1'], score: 100,
    correctMatches: 1, attempts: 2, clientUpdatedAt: 1234,
  });
  assert.equal(JSON.parse(storage.getItem(CHALLENGE_PROGRESS_KEY)).clientUpdatedAt, 1234);
});

test('pending cloud deletion is isolated by authenticated user id', () => {
  const storage = createStorage();
  savePendingCloudDelete(storage, 'user-a', LOCAL_RECORD);
  assert.equal(loadPendingCloudDelete(storage, 'user-b'), null);
  assert.equal(loadPendingCloudDelete(storage, 'user-a').bookId, LOCAL_RECORD.bookId);
});
```

- [ ] **Step 2: Run the focused tests and confirm the new behavior is absent**

Run:

```powershell
node --test challenge-progress.test.mjs sync-model.test.mjs
```

Expected: failures for missing `clientUpdatedAt`, missing `sync-model.js`, and missing exports.

- [ ] **Step 3: Implement version-two local records**

Use version `2` for new writes while accepting version `1` records. New records include:

```js
{
  version: 2,
  bookId,
  scope,
  seed,
  score,
  correctMatches,
  attempts,
  completedPairIds,
  clientUpdatedAt: nowMs,
}
```

For a version-one record, normalize `clientUpdatedAt` to `0`. Keep the existing storage key so deployed users retain current progress.

`saveChallengeProgress` must return the exact `SyncRecord` it wrote so `ui.js` can pass it to the controller without reparsing storage. `replaceChallengeProgress` writes a supplied synchronized record without changing its timestamp. Pending deletion helpers use `synonym-match-cloud-pending-delete-v1:<userId>` and never store email, access tokens, refresh tokens, or session objects.

- [ ] **Step 4: Implement pure synchronization decisions**

`decideProgressSync` must return exactly one of:

```js
{ type: 'empty', record: null }
{ type: 'use-local', record: localRecord }
{ type: 'use-cloud', record: cloudRecord }
{ type: 'merge', record: mergedRecord }
{ type: 'conflict', localRecord, cloudRecord }
```

`mergeSameChallenge` must deduplicate pair IDs, keep deterministic pair ID ordering, and take seed/statistics from the record with the greater `clientUpdatedAt`. Equal timestamps prefer the cloud record so repeated merges are stable.

- [ ] **Step 5: Run focused and full tests**

Run:

```powershell
node --test challenge-progress.test.mjs sync-model.test.mjs
npm test
```

Expected: focused tests and the existing 29 tests pass with no warnings from application code.

- [ ] **Step 6: Review gate**

Review the local migration for deployed version-one records and verify the merge is idempotent by merging the result with the same cloud record twice. Record changed files for the final website upload; do not create a local Git commit.

---

### Task 2: Create the Supabase Schema, RLS, and Atomic Merge Contract

**Files:**
- Create: `supabase/schema.sql`
- Create: `supabase/SETUP.md`

**Interfaces:**
- Produces table: `public.challenge_progress`
- Produces RPC: `public.merge_challenge_progress(p_book_id text, p_scope text, p_seed bigint, p_completed_pair_ids jsonb, p_score integer, p_correct_matches integer, p_attempts integer, p_client_updated_at timestamptz) -> jsonb`
- Consumes: authenticated `auth.uid()`; no caller-provided user ID

- [ ] **Step 1: Write the table and constraints**

`schema.sql` must create a table with this contract:

```sql
create table if not exists public.challenge_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  book_id text not null check (book_id in ('ielts', 'cet6', 'postgrad', 'cet4')),
  scope text not null check (scope in ('frequent', 'full')),
  seed bigint not null check (seed >= 0),
  completed_pair_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(completed_pair_ids) = 'array'),
  score integer not null default 0 check (score >= 0),
  correct_matches integer not null default 0 check (correct_matches >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default now()
);
```

Also reject `seed > 9007199254740991`, `correct_matches > attempts`, and any `completed_pair_ids` element that is not a JSON string. Add a trigger that always sets `updated_at = now()` on update.

- [ ] **Step 2: Add RLS policies**

Enable RLS and create separate `select`, `insert`, `update`, and `delete` policies. Every policy must use `auth.uid() = user_id`; insert/update also use `with check (auth.uid() = user_id)`. Revoke table access from `anon` and explicitly grant `select`, `insert`, `update`, and `delete` to `authenticated`.

- [ ] **Step 3: Add the atomic merge RPC**

Create `merge_challenge_progress` as `security invoker` with a fixed `search_path = public`. It uses the exact typed parameters in the Interfaces block and obtains `auth.uid()` internally. A null authenticated user raises SQLSTATE `42501`.

The function returns:

```json
{"status":"merged","record":{}}
```

for a successful same-book merge, or:

```json
{"status":"conflict","record":{}}
```

when an existing row has a different book or scope. Use one atomic upsert statement with PostgreSQL's `on conflict (user_id) do update` clause so the missing-row case is also race-safe. The conflict update runs only when existing and incoming `book_id`/`scope` match; its pair IDs use a sorted distinct JSON string union, and seed/statistics use the greater client timestamp with incoming data winning equal timestamps. If the guarded update returns no row, return the untouched existing row with `status = conflict`.

Revoke function execution from `public` and `anon`, then grant it only to `authenticated`. Both the success and conflict `record` values are `to_jsonb(challenge_progress)` so the frontend always receives one database row shape.

- [ ] **Step 4: Document exact dashboard setup**

`supabase/SETUP.md` must cover:

1. Create a Supabase project.
2. Run `schema.sql` in SQL Editor.
3. Enable Email provider.
4. Change the email template to show `{{ .Token }}` as a six-digit code.
5. Set Site URL to `https://wuditiaotiao.github.io/KaoyanVocabularyMatch-3/`.
6. Add `http://127.0.0.1:*` for local testing.
7. Configure a public SMTP provider before opening registration broadly.
8. Copy only Project URL and the public anon/publishable key.
9. Never copy the service role/secret key into the project.

- [ ] **Step 5: Validate in a Supabase project**

After the user creates or authorizes a project, run the SQL in the dashboard. Verify:

- an anonymous request cannot select rows;
- user A cannot read user B's row;
- two merge calls with different pair IDs produce their union;
- a different book returns `status = conflict` without modifying the row;
- a negative score is rejected.

- [ ] **Step 6: Review gate**

Review SQL for `security definer`, caller-provided user IDs, or broad policies. The expected result is no `security definer`, no user ID parameter, and no policy containing `true`. Record files for final website upload; do not create a local Git commit.

---

### Task 3: Implement Email OTP Authentication with Guest Fallback

**Files:**
- Create: `supabase-config.js`
- Create: `auth.js`
- Create: `auth.test.mjs`

**Interfaces:**
- Produces: `createAuthService({ config, importSupabase })`
- Produces methods: `initialize()`, `sendOtp(email)`, `verifyOtp(email, token)`, `signOut()`, `getSession()`, `getUser()`, `getClient()`, `subscribe(listener)`
- Produces: `maskEmail(email)`

- [ ] **Step 1: Add failing authentication tests**

Cover these observable behaviors:

```js
test('unconfigured auth initializes as guest without loading the remote module', async () => {
  let imports = 0;
  const auth = createAuthService({
    config: null,
    importSupabase: async () => { imports += 1; },
  });

  assert.deepEqual(await auth.initialize(), { status: 'guest', user: null, configured: false });
  assert.equal(imports, 0);
});

test('sendOtp normalizes the email and asks Supabase to create the user', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.sendOtp('  Learner@Example.COM ');
  assert.deepEqual(calls.signInWithOtp[0], {
    email: 'learner@example.com',
    options: { shouldCreateUser: true },
  });
});

test('verifyOtp uses the email token flow', async () => {
  const { auth, calls } = createAuthFixture();
  await auth.verifyOtp('learner@example.com', '123456');
  assert.deepEqual(calls.verifyOtp[0], {
    email: 'learner@example.com', token: '123456', type: 'email',
  });
});
```

The fake client must include `getSession`, `onAuthStateChange`, `signInWithOtp`, `verifyOtp`, and `signOut` so tests mirror the real boundary.

Add named cases `restores an authenticated persisted session`, `getClient stays null after import failure`, `auth state updates getUser before notifying listeners`, `sign out clears only the Supabase session`, `rejects a non-six-digit token locally`, and one case for each normalized `AuthError.code`.

- [ ] **Step 2: Run the tests and confirm missing modules fail**

Run:

```powershell
node --test auth.test.mjs
```

Expected: module-not-found or missing export failure.

- [ ] **Step 3: Add safe runtime configuration**

`supabase-config.js` initially exports a functional guest fallback:

```js
export const SUPABASE_CONFIG = null;
export const SUPABASE_MODULE_URL = 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const isSupabaseConfigured = (config) => Boolean(
  config?.url?.startsWith('https://') && config?.anonKey,
);
```

During live provisioning, `SUPABASE_CONFIG` is replaced with the exact Project URL and public key shown by the dashboard.

- [ ] **Step 4: Implement the auth service**

Dynamic import occurs only inside `initialize()` when configuration is valid. Catch module load or client initialization errors and return `{ status: 'guest', user: null, configured: true, error }`; do not throw into `ui.js` startup.

Create one Supabase client with `persistSession: true`, `autoRefreshToken: true`, and `detectSessionInUrl: true`; `getClient()` returns that instance only after successful initialization, and `getUser()` returns the latest auth-state user. Validate email with a conservative `local@domain` shape and token with `/^\d{6}$/`. Normalize failures to `AuthError.code` values `invalid_email`, `invalid_code`, `otp_expired`, `rate_limited`, `offline`, or `unknown`; retain the original error as `cause` without logging session tokens.

`subscribe(listener)` wraps `onAuthStateChange`, emits `{ event, user }`, and returns the Supabase unsubscribe function. `initialize()` calls `getSession()` before returning so a persisted session is available during page startup.

- [ ] **Step 5: Run authentication and full tests**

Run:

```powershell
node --test auth.test.mjs
npm test
```

Expected: authentication tests pass; existing game remains green with `SUPABASE_CONFIG = null`.

- [ ] **Step 6: Review gate**

Verify no network import occurs when configuration is null, no token is logged, and sign-out leaves `localStorage` challenge progress untouched. Record files for final website upload; do not create a local Git commit.

---

### Task 4: Implement Cloud Progress Read, Merge, Replace, and Delete

**Files:**
- Create: `cloud-progress.js`
- Create: `cloud-progress.test.mjs`

**Interfaces:**
- Consumes: initialized Supabase client and authenticated user
- Produces: `createCloudProgressService({ client, getUser })`
- Produces methods: `fetchProgress()`, `mergeProgress(record)`, `replaceProgress(record)`, `clearProgress(expectedRecord) -> 'cleared'|'empty'|'changed'`

- [ ] **Step 1: Write failing cloud boundary tests**

Test the complete RPC and table payload rather than mock call existence alone:

```js
test('mergeProgress sends the normalized record to the atomic RPC', async () => {
  const fixture = createCloudFixture({ rpcResult: { status: 'merged', record: CLOUD_ROW } });
  const result = await fixture.service.mergeProgress(LOCAL_RECORD);

  assert.deepEqual(fixture.calls.rpc[0], {
    name: 'merge_challenge_progress',
    params: {
      p_book_id: 'postgrad',
      p_scope: 'frequent',
      p_seed: 42,
      p_completed_pair_ids: ['pair-1'],
      p_score: 100,
      p_correct_matches: 1,
      p_attempts: 2,
      p_client_updated_at: new Date(1000).toISOString(),
    },
  });
  assert.equal(result.status, 'merged');
});

test('replaceProgress always uses the authenticated user id', async () => {
  const fixture = createCloudFixture({ user: { id: 'user-a' } });
  await fixture.service.replaceProgress(LOCAL_RECORD);
  assert.equal(fixture.calls.upsert[0].user_id, 'user-a');
});

test('clearProgress is restricted to the expected challenge', async () => {
  const fixture = createCloudFixture({ user: { id: 'user-a' } });
  await fixture.service.clearProgress({ bookId: 'postgrad', scope: 'frequent' });
  assert.deepEqual(fixture.calls.deleteFilters, {
    user_id: 'user-a', book_id: 'postgrad', scope: 'frequent',
  });
});
```

Add named cases `rejects operations without an authenticated user`, `returns null for an empty fetch`, `normalizes an RPC conflict row`, `rejects malformed cloud rows`, `preserves a delete error`, and `classifies a fetch network failure`.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
node --test cloud-progress.test.mjs
```

Expected: missing module/export failure.

- [ ] **Step 3: Implement explicit row conversion**

Map snake_case database fields to the sync model:

```js
const fromCloudRow = (row) => ({
  bookId: row.book_id,
  scope: row.scope,
  seed: Number(row.seed),
  completedPairIds: row.completed_pair_ids,
  score: row.score,
  correctMatches: row.correct_matches,
  attempts: row.attempts,
  clientUpdatedAt: Date.parse(row.client_updated_at),
  serverUpdatedAt: Date.parse(row.updated_at),
});
```

Reject malformed rows before they reach `ui.js`.

- [ ] **Step 4: Implement the four cloud operations**

- `fetchProgress`: `.from('challenge_progress').select('book_id, scope, seed, completed_pair_ids, score, correct_matches, attempts, client_updated_at, updated_at').maybeSingle()`.
- `mergeProgress`: `.rpc('merge_challenge_progress', params)`.
- `replaceProgress`: `.from('challenge_progress').upsert(row, { onConflict: 'user_id' }).select('book_id, scope, seed, completed_pair_ids, score, correct_matches, attempts, client_updated_at, updated_at').single()` after explicit conflict choice; return the normalized written row.
- `clearProgress`: `.from('challenge_progress').delete().eq('user_id', user.id).eq('book_id', expectedRecord.bookId).eq('scope', expectedRecord.scope).select('user_id')`. Return `cleared` when one row was deleted. When none was deleted, call `fetchProgress()` and return `empty` for no row or `changed` for a different active challenge.

Every method throws a normalized `CloudProgressError` on Supabase errors and never clears local storage itself.

- [ ] **Step 5: Run focused and full tests**

Run:

```powershell
node --test cloud-progress.test.mjs
npm test
```

Expected: all cloud boundary cases and existing tests pass.

- [ ] **Step 6: Review gate**

Verify replace/delete use only the authenticated user ID and that conflict RPC results do not mutate local state. Record files for final website upload; do not create a local Git commit.

---

### Task 5: Build the Synchronization Controller

**Files:**
- Create: `sync-controller.js`
- Create: `sync-controller.test.mjs`

**Interfaces:**
- Consumes: the exact auth, cloud, local, pending-delete, vocabulary-loader, clock, scheduler, and online adapters from Shared Contracts
- Produces: `createSyncController(dependencies)`
- Produces methods: `initialize()`, `notifyLocalProgress(record)`, `notifyChallengeComplete(record)`, `resolveConflict(choice)`, `clearActiveChallenge(record)`, `signOut()`, `retry()`, `getSnapshot()`, `subscribe(listener)`
- Produces state: `guest`, `initializing`, `syncing`, `synced`, `offline`, `error`, `conflict`

- [ ] **Step 1: Write failing state-machine tests**

Cover at least:

```js
test('guest initialization returns local progress without cloud calls', async () => {
  const fixture = createControllerFixture({ authUser: null, localRecord: LOCAL_RECORD });
  const result = await fixture.controller.initialize();
  assert.equal(result.record, LOCAL_RECORD);
  assert.equal(fixture.calls.fetchProgress, 0);
  assert.equal(result.syncState, 'guest');
});

test('same-book login merges and writes the merged record locally', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' },
    localRecord: LOCAL_RECORD,
    cloudRecord: CLOUD_RECORD_SAME_BOOK,
  });
  const result = await fixture.controller.initialize();
  assert.deepEqual(result.record.completedPairIds, ['pair-1', 'pair-2']);
  assert.deepEqual(fixture.calls.saveLocal[0], result.record);
  assert.equal(result.syncState, 'synced');
});

test('different books pause synchronization until the user chooses', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' },
    localRecord: LOCAL_RECORD,
    cloudRecord: CLOUD_RECORD_DIFFERENT_BOOK,
  });
  const result = await fixture.controller.initialize();
  assert.equal(result.syncState, 'conflict');
  assert.equal(fixture.calls.replaceProgress.length, 0);
});

test('a pending completion delete runs before a newer local upload', async () => {
  const fixture = createControllerFixture({
    authUser: { id: 'user-a' }, pendingDelete: COMPLETED_RECORD,
    localRecord: NEW_LOCAL_RECORD,
  });
  await fixture.controller.initialize();
  assert.deepEqual(fixture.calls.order.slice(0, 2), ['clearProgress', 'mergeProgress']);
  assert.equal(fixture.calls.clearPendingDelete, 1);
});

test('retry delays are finite and stop after the third scheduled failure', async () => {
  const fixture = createControllerFixture({ mergeErrors: [NETWORK_ERROR, NETWORK_ERROR, NETWORK_ERROR, NETWORK_ERROR] });
  fixture.controller.notifyLocalProgress(LOCAL_RECORD);
  await fixture.flushUploads();
  assert.deepEqual(fixture.calls.timerDelays, [5_000, 30_000, 120_000]);
});
```

Add named cases `coalesces rapid writes to the newest record`, `marks offline without scheduling while navigator is offline`, `online retry uploads immediately`, `cloud clear precedes local clear`, `cloud clear failure preserves local state`, `challenge completion persists a delete marker before local clear`, and `sign out preserves local progress`.

Add `scheduled upload cannot cross an account change`: schedule a write as user A, sign out before the 600 ms timer fires, sign in as user B, then assert no user-B cloud call contains user A's record.

- [ ] **Step 2: Run and observe failure**

Run:

```powershell
node --test sync-controller.test.mjs
```

Expected: missing module/export failure.

- [ ] **Step 3: Implement initialization and conflict resolution**

Initialization reads auth, the local selection, and cloud state. It loads the vocabulary for each distinct `bookId`/`scope`, applies `normalizeSyncRecord` to filter unknown pair IDs, then calls `decideProgressSync`. If an account-scoped pending delete exists, it attempts that delete before reading/merging the current records: `cleared` or `empty` removes the marker; `changed` exposes a conflict and leaves both records untouched. `resolveConflict('cloud')` saves cloud locally. `resolveConflict('local')` calls `replaceProgress` and only updates state after success.

- [ ] **Step 4: Implement coalesced background saving**

`notifyLocalProgress(record)` keeps only the newest unsent record and schedules one upload after 600 ms. While one upload is running, later records replace the pending record. When an RPC succeeds, write its normalized returned row locally only after merging it with any newer pending record; this preserves pair IDs completed during the request. An RPC `conflict` result enters the conflict state without replacing local data. Online failures retry after exactly `[5_000, 30_000, 120_000]` milliseconds; only one retry timer may exist, success resets the retry index, and the fourth failure waits for `retry()` or a later page/auth initialization. When `isOnline()` is false, keep the record pending and wait without scheduling.

- [ ] **Step 5: Implement safe clear and sign-out**

For logged-in users, `clearActiveChallenge(record)` calls the challenge-scoped cloud delete first and local clear second. `empty` is also a successful reset; `changed` is reconciled instead of reported as success. For guests it deletes local directly. `signOut()` cancels upload/retry timers, discards controller-only pending memory, calls the auth service, and retains the persisted local progress. Each controller captures its authenticated user ID and refuses to upload after that ID changes.

`notifyChallengeComplete(record)` is the one intentional local-first deletion path: synchronously save the user-scoped pending-delete marker, clear the active local record, emit the result-page snapshot, and schedule `cloud.clearProgress(record)`. Clear the marker only after cloud deletion succeeds. This lets completion work offline without allowing a stale cloud row to reappear on the next authenticated startup.

- [ ] **Step 6: Run focused and full tests**

Run:

```powershell
node --test sync-controller.test.mjs
npm test
```

Expected: controller tests and all previous tests pass.

- [ ] **Step 7: Review gate**

Review every branch where local data could be deleted. Reset requires cloud `cleared`/`empty` before local deletion; the only exception is documented challenge completion, which must persist its user-scoped delete marker first. Record files for final website upload; do not create a local Git commit.

---

### Task 6: Add Account, OTP, Sync Status, and Conflict UI

**Files:**
- Modify: `index.html:16-239`
- Modify: `styles.css:135-504`
- Modify: `auth.js`
- Modify: `auth.test.mjs`

**Interfaces:**
- Produces DOM IDs: `account-button`, `sync-status`, `auth-modal`, `auth-email`, `auth-code`, `auth-send`, `auth-verify`, `auth-resend`, `auth-sign-out`, `conflict-modal`, `conflict-close`, `use-cloud-progress`, `use-local-progress`
- Produces tested helper: `getAuthErrorCopy(errorCode)`
- Uses a 60-second resend countdown driven by a pure remaining-seconds helper; sending is disabled until it reaches zero

- [ ] **Step 1: Add failing copy and masking tests**

Test exact user-visible outcomes for invalid email, invalid code, expired code, rate limit, offline, and unknown server error. Test masking:

```js
assert.equal(maskEmail('learner@example.com'), 'l***r@example.com');
assert.equal(maskEmail('a@example.com'), 'a***@example.com');
assert.equal(getAuthErrorCopy('otp_expired'), '验证码已过期，请重新发送。');
```

- [ ] **Step 2: Implement auth and conflict markup**

Add a compact account button beside the existing vocabulary/reset controls. Add two top-level modal backdrops after `reset-modal`:

- Auth dialog with email step, six-digit code step, resend countdown, error region, close button, and sign-out action.
- Conflict dialog with local/cloud book labels, counts, timestamps, a close button, and two explicit choice buttons.

All inputs require visible labels. Error/status elements use `role="alert"` or `aria-live="polite"` as appropriate.

- [ ] **Step 3: Add responsive styles**

Desktop keeps the account cluster at the right edge. At `max-width: 680px`, show an icon/short label and keep sync status on one line. At `max-width: 430px`, allow the vocabulary text to wrap while account and reset controls retain stable heights.

Auth and conflict dialogs use at most 430px width, safe-area padding, scrollable content, and no nested decorative cards. The six code inputs may be a single numeric field with `inputmode="numeric"` and `autocomplete="one-time-code"`.

`getAuthErrorCopy` maps exactly: `invalid_email -> 请输入有效邮箱地址。`, `invalid_code -> 验证码不正确，请重新输入。`, `otp_expired -> 验证码已过期，请重新发送。`, `rate_limited -> 操作太频繁，请稍后再试。`, `offline -> 当前网络不可用，游客进度仍会保存在本机。`, and `unknown -> 登录服务暂时不可用，请稍后重试。` The modal keeps the entered email/code on failure, while “修改邮箱” clears only the code and countdown state.

- [ ] **Step 4: Run tests and syntax checks**

Run:

```powershell
node --test auth.test.mjs
node --check auth.js
node --check ui.js
npm test
```

Expected: all tests pass and no syntax errors.

- [ ] **Step 5: Browser layout check with inert data**

Serve the site locally with Supabase config null. Verify:

- the game remains playable;
- account button says cloud sync is not configured rather than breaking startup;
- auth dialog is keyboard focusable;
- 390x844, 768x1024, and 1280x800 have no horizontal overflow;
- auth and conflict dialog text fits without overlapping controls.

- [ ] **Step 6: Review gate**

Review focus return, modal `inert` handling, timer pause/resume, and reduced-motion behavior. Record files for final website upload; do not create a local Git commit.

---

### Task 7: Integrate Auth and Cloud Sync into the Game Lifecycle

**Files:**
- Modify: `ui.js:1-583`
- Modify: `index.html:239`
- Modify: `styles.css`
- Modify: `challenge-progress.js`
- Test: all `*.test.mjs`

**Interfaces:**
- Consumes all services from Tasks 1-6
- Preserves existing `persistActiveChallenge`, `restoreActiveChallenge`, `handleStartGame`, and `handleConfirmReset` behavior for guests

- [ ] **Step 1: Add integration-oriented controller cases before UI wiring**

Add tests for the exact UI-facing sequence:

1. local progress exists, user logs in, cloud empty -> local uploaded and restored;
2. cloud exists, local empty -> cloud saved locally and game restores it;
3. same-book records merge -> merged pair count shown;
4. different books -> game waits for conflict choice without overwriting;
5. reset cloud failure -> local progress remains;
6. completed challenge online -> pending marker is written, local record clears, cloud clears, then marker clears;
7. completed challenge offline -> result page opens, local record clears, and marker survives reload until retry;
8. sign-out -> local challenge remains playable.

- [ ] **Step 2: Initialize authentication without blocking the core app**

Start catalog loading and auth initialization in parallel. If auth is unconfigured or fails, call the existing local restore path. If a session exists, obtain the initialized client through `auth.getClient()`, create the cloud service and controller, call `controller.initialize()`, then create the game state from its selected record.

Do not render the setup modal over a valid cloud record. Do not hide the setup modal when both records are empty.

- [ ] **Step 3: Wire login and OTP interactions**

Opening the auth modal pauses the timer without resetting `timeLeft`. Closing or successful login returns focus to `account-button` and resumes only if the game was playing. A failed send or verification keeps the modal open, preserves input, focuses the invalid field, and leaves the game timer paused. Sending a code starts a 60-second resend countdown; “修改邮箱” cancels it, and resend invokes `sendOtp` with the already-normalized email only after the countdown reaches zero.

After login, render masked email and controller sync state. A successful merge updates the book pair/challenge counters immediately.

- [ ] **Step 4: Route every progress write through the controller**

Keep `saveChallengeProgress` synchronous and use its returned `SyncRecord`. After it succeeds, call `syncController.notifyLocalProgress(record)`. Use this path after match resolution, hint score changes, restart, next challenge, and new challenge creation.

Avoid network calls on every one-second timer tick.

When the final pair changes the game status to `complete`, do not call the ordinary `clearActiveChallenge` helper. Pass the last record to `syncController.notifyChallengeComplete(record)` so its pending-delete marker is written before the local active record is removed; guests retain the existing immediate local clear behavior.

- [ ] **Step 5: Wire conflict choices and reset**

- “继续云端进度” calls `resolveConflict('cloud')`, recreates the game state, and closes the dialog.
- “使用本机进度” displays a second confirmation, then calls `resolveConflict('local')`.
- Closing the conflict dialog performs no controller write, keeps `syncState = 'conflict'`, and lets the current local game continue unsynced until the user reopens and resolves it.
- Logged-in reset awaits `clearActiveChallenge(currentRecord)` before hiding the reset dialog.
- Guest reset keeps the current synchronous local path.

- [ ] **Step 6: Handle online, offline, and sign-out events**

On `window.online`, call `retry()`. On `window.offline`, show `离线保存` without clearing pending progress. Sign-out updates account UI and preserves the current game and local record.

- [ ] **Step 7: Bump static resource versions once**

After all code settles, change all `?v=13` application resources to one new shared version, for example `?v=14`, including `index.html` and module imports in `ui.js`. Do this only once to avoid unnecessary cache churn.

- [ ] **Step 8: Run complete verification**

Run:

```powershell
npm test
node --check ui.js
node --check game.js
node --check challenge-progress.js
node --check sync-model.js
node --check auth.js
node --check cloud-progress.js
node --check sync-controller.js
```

Expected: all tests pass, all syntax checks exit zero, and the original 29 tests remain present.

- [ ] **Step 9: Review gate**

Request an independent read-only code review focused on data loss, auth token exposure, RLS assumptions, offline races, duplicate pair counting, and timer/modal interactions. Fix every Critical or Important finding before provisioning.

---

### Task 8: Provision Supabase, Verify Cross-Device Behavior, and Publish

**Files:**
- Modify: `supabase-config.js` with the project's exact public URL/key
- Modify: `supabase/SETUP.md` with verified project-specific checklist state only if needed
- Upload: all changed/new source, tests, SQL, setup, spec, and plan files

**Interfaces:**
- Consumes the Supabase project created by the user
- Produces the live GitHub Pages feature

- [ ] **Step 1: Create or select the Supabase project**

Use the Supabase dashboard with the user's account. Creating a project and changing authentication settings are external account actions; request confirmation at the action-time steps required by the UI policy. Do not ask for or expose a service role key.

- [ ] **Step 2: Apply and validate the database schema**

Run `supabase/schema.sql` in SQL Editor. Inspect the table, RLS enabled state, policies, and RPC. Perform the Task 2 isolation and merge checks using two test users.

- [ ] **Step 3: Configure email OTP and URLs**

Set the Site URL and allowed redirect URLs from `supabase/SETUP.md`. Confirm the email template renders a six-digit token. Use the default mailer only for controlled testing; configure public SMTP before inviting arbitrary users.

- [ ] **Step 4: Insert the public frontend configuration**

Replace `SUPABASE_CONFIG = null` with an object containing the exact Project URL and public anon/publishable key. Verify `isSupabaseConfigured` returns true. Confirm no secret/service role value appears in any local file with:

```powershell
rg -n "service_role|sb_secret|SUPABASE_SERVICE" .
```

Expected: matches only in documentation warnings, never in executable configuration.

- [ ] **Step 5: Run two-device browser acceptance**

Use two isolated browser profiles:

1. Device A plays as guest, completes one pair, logs in, and reaches `已同步`.
2. Device B logs in with the same email and shows the same pair count without word-book selection.
3. Device A and B each complete a different pair; after refresh both show the union.
4. One device switches to a different local book while offline; reconnecting shows the conflict dialog.
5. Test both conflict choices.
6. Sign out and confirm the current device retains local progress.
7. Trigger reset, confirm cloud and local records are absent, and verify the next visit shows setup.

- [ ] **Step 6: Run responsive and regression QA**

Capture 390x844, 768x1024, and 1280x800 screenshots for setup, active game, auth modal, and conflict modal. Verify zero horizontal overflow, 15 stable tiles, readable progress, and no overlapping controls. Run `npm test` once more immediately before upload.

- [ ] **Step 7: Prepare the GitHub website upload**

Open the repository upload page for `main`, upload every changed/new file, and use commit summary:

```text
增加邮箱登录和跨设备进度同步
```

Use description:

```text
通过 Supabase 保存当前词书挑战，支持游客模式、邮箱验证码、离线本机保存、跨设备合并和冲突选择。
```

Stop immediately before the final GitHub `Commit changes` button and obtain action-time user confirmation.

- [ ] **Step 8: Publish and verify production**

After confirmation, commit through GitHub, wait for the Pages workflow to complete successfully, and open:

```text
https://wuditiaotiao.github.io/KaoyanVocabularyMatch-3/
```

Repeat login, one-pair sync, refresh auto-resume, sign-out, and mobile viewport smoke checks on the production origin. Report the commit URL, live site URL, test count, and any remaining operational SMTP limitation.
