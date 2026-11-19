import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { BusinessService, loadBusinessService } from '../src/business.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const actions = { list: 'read', stats: 'read', events: 'read', integrity: 'read', add: 'create', record: 'create', update: 'update', complete: 'complete', delete: 'delete' };
const empty = () => ({ version: 2, updated: '', recurring: [], plans: [], pool: [], history: [] });
const digest = raw => createHash('sha256').update(raw).digest('hex');

async function fixture(t, { data = empty(), missing = false, now } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reminder-business-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'personal.json');
  const familyFile = join(directory, 'family', 'checklist.json');
  if (!missing) await writeFile(file, JSON.stringify(data));
  const key = Buffer.concat([randomBytes(32), Buffer.from('\n')]);
  const spaces = { personal: file, family: familyFile };
  let service = new BusinessService({ key, spaces, ...(now ? { now } : {}) });
  const sign = (request, overrides = {}, raw = Buffer.from(JSON.stringify(request))) => {
    const claims = { v: 1, appId: 'reminder', userId: 'user-a', clientId: 'client-a', grantId: 'grant-a', spaceId: request.spaceId, action: actions[request.operation], resources: ['*'], expiresAt: (now?.() ?? Date.now()) + 25000, requestId: 'request-a', method: 'POST', path: '/api/business', bodyHash: digest(raw), ...overrides };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`;
  };
  const invoke = (request, overrides) => {
    const body = { spaceId: 'personal', ...request };
    const raw = Buffer.from(JSON.stringify(body));
    return service.handle(raw, sign(body, overrides, raw));
  };
  const restart = () => { service = new BusinessService({ key, spaces, ...(now ? { now } : {}) }); return service; };
  return { directory, file, familyFile, key, spaces, sign, invoke, restart, get service() { return service; } };
}

test('business CRUD keeps durable idempotency, record versions and events across restarts', async t => {
  const f = await fixture(t);
  const add = { operation: 'add', input: { item: { text: '准备家庭出行', tags: ['家庭'] } }, idempotencyKey: 'add-one' };
  const created = await f.invoke(add);
  assert.equal(created.revision, '1');
  assert.equal(created.cursor, 1);
  assert.equal(created.item.text, '准备家庭出行');
  assert.equal(created.replayed, false);
  const raw = await readFile(f.file, 'utf8');
  f.restart();
  const replay = await f.invoke(add);
  assert.equal(replay.replayed, true);
  assert.equal(replay.resourceId, created.resourceId);
  assert.equal(await readFile(f.file, 'utf8'), raw);
  await assert.rejects(f.invoke({ ...add, input: { item: { text: '另一项事务' } } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(await readFile(f.file, 'utf8'), raw);
  const listing = await f.invoke({ operation: 'list' });
  assert.equal(listing.items.length, 1);
  assert.equal(listing.cursor, 1);
  assert.equal(listing.items[0].resourceId, created.resourceId);
  assert.notEqual(listing.revision, (await new Store(f.file).read()).revision);
  const update = await f.invoke({ operation: 'update', resourceId: created.resourceId, expectedRevision: '1', input: { flagged: true }, idempotencyKey: 'update-one' });
  assert.equal(update.revision, '2');
  const beforeConflict = await readFile(f.file, 'utf8');
  await assert.rejects(f.invoke({ operation: 'complete', resourceId: created.resourceId, expectedRevision: '1', idempotencyKey: 'stale-complete' }), error => error.code === 'CONFLICT');
  assert.equal(await readFile(f.file, 'utf8'), beforeConflict);
  const completed = await f.invoke({ operation: 'complete', resourceId: created.resourceId, expectedRevision: '2', input: { actualHours: 1.5, completedAt: '2026-11-12 12:34:56' }, idempotencyKey: 'complete-one' });
  assert.equal(completed.revision, '3');
  assert.equal(completed.item.done, true);
  assert.equal(completed.item.actualHours, 1.5);
  const deletion = { operation: 'delete', resourceId: created.resourceId, expectedRevision: '3', idempotencyKey: 'delete-one' };
  const deleted = await f.invoke(deletion);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.revision, '4');
  assert.equal(deleted.item, undefined);
  f.restart();
  assert.equal((await f.invoke(deletion)).replayed, true);
  assert.equal((await f.invoke({ operation: 'list' })).items.length, 0);
  const events = await f.invoke({ operation: 'events', input: { after: 0 } });
  assert.deepEqual(events.events.map(event => event.operation), ['add', 'update', 'complete', 'delete']);
  assert.equal(events.cursor, 4);
  assert.equal(events.resetRequired, false);
  assert.equal(JSON.stringify(events.events).includes('准备家庭出行'), false);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).version, 2);
});

test('legacy duplicate IDs retain distinct stable resources without read-side writes or shifted grants', async t => {
  const data = empty();
  data.history = [
    { id: 'same-id', text: '第一项旧记录', tags: [], completedAt: '2026-11-11' },
    { id: 'same-id', text: '第二项旧记录', tags: [], completedAt: '2026-11' },
  ];
  const f = await fixture(t, { data });
  const before = await readFile(f.file, 'utf8');
  const old = await f.invoke({ operation: 'list' });
  assert.notEqual(old.items[0].resourceId, old.items[1].resourceId);
  assert.equal(await readFile(f.file, 'utf8'), before);
  f.restart();
  assert.deepEqual((await f.invoke({ operation: 'list' })).items, old.items);
  await f.invoke({ operation: 'update', resourceId: old.items[1].resourceId, expectedRevision: '1', input: { flagged: true }, idempotencyKey: 'flag-second' });
  const updated = await f.invoke({ operation: 'list' });
  assert.equal(updated.items[0].item.flagged, undefined);
  assert.equal(updated.items[1].item.flagged, true);
  assert.equal(updated.items[1].item.completedAt, '2026-11');
  await f.invoke({ operation: 'delete', resourceId: old.items[0].resourceId, expectedRevision: '1', idempotencyKey: 'delete-first' });
  const after = await f.invoke({ operation: 'list' });
  assert.equal(after.items[0].resourceId, old.items[1].resourceId);
  assert.equal(after.items[0].revision, '2');
  await assert.rejects(f.invoke({ operation: 'update', resourceId: old.items[0].resourceId, expectedRevision: '1', input: { text: '不得覆盖后一项' }, idempotencyKey: 'stale-id' }), error => error.status === 404);
  await new Store(f.file).update('history:0', { flagged: false });
  const local = await f.invoke({ operation: 'list' });
  assert.equal(local.items[0].resourceId, old.items[1].resourceId);
  assert.equal(local.items[0].revision, '3');
});

test('finite create grants bind one future resource without changing generated item identity', async t => {
  const f = await fixture(t);
  const unrelated = await f.invoke({ operation: 'add', input: { item: { text: '另一条私人事项' } }, idempotencyKey: 'unrelated' });
  const resourceId = 'r_11111111-1111-4111-8111-111111111111';
  const scope = { resources: [resourceId] };
  const request = { operation: 'add', resourceId, input: { item: { text: '获授权的新事项' } }, idempotencyKey: 'finite-create' };
  const created = await f.invoke(request, scope);
  assert.equal(created.resourceId, resourceId);
  assert.equal(created.revision, '1');
  assert.equal(created.collection, 'pool');
  assert.equal(created.item.done, false);
  assert.notEqual(created.item.id, resourceId);
  assert.match(created.item.id, /^[a-f\d-]{36}$/);
  const raw = await readFile(f.file, 'utf8');
  f.restart();
  const replay = await f.invoke(request, scope);
  assert.equal(replay.replayed, true);
  assert.equal(replay.resourceId, resourceId);
  assert.equal(replay.item.id, created.item.id);
  assert.equal(await readFile(f.file, 'utf8'), raw);
  const listing = await f.invoke({ operation: 'list' }, scope);
  assert.deepEqual(listing.items.map(item => item.resourceId), [resourceId]);
  assert.equal(listing.items[0].item.text, '获授权的新事项');
  const events = await f.invoke({ operation: 'events' }, scope);
  assert.deepEqual(events.events.map(event => event.resourceId), [resourceId]);
  assert.equal((await f.invoke({ operation: 'list' }, { resources: [unrelated.resourceId] })).items[0].item.text, unrelated.item.text);
  await assert.rejects(f.invoke({ ...request, idempotencyKey: 'second-create' }, scope), error => error.status === 409 && error.code === 'RESOURCE_EXISTS');
  assert.equal(await readFile(f.file, 'utf8'), raw);
});

test('finite create rejects absent, foreign, malformed and identity-setting targets without writes', async t => {
  const f = await fixture(t), raw = await readFile(f.file, 'utf8');
  const resourceId = 'r_22222222-2222-4222-8222-222222222222';
  const scope = { resources: [resourceId] };
  const request = { operation: 'add', input: { item: { text: '受限事项' } }, idempotencyKey: 'restricted-create' };
  await assert.rejects(f.invoke(request, scope), error => error.status === 403);
  await assert.rejects(f.invoke({ ...request, resourceId: 'r_33333333-3333-4333-8333-333333333333' }, scope), error => error.status === 403);
  for (const invalid of [null, '', 'invalid', 7]) await assert.rejects(f.invoke({ ...request, resourceId: invalid }, scope), error => error.status === 400);
  await assert.rejects(f.invoke({ ...request, resourceId, expectedRevision: '1' }, scope), error => error.status === 400);
  await assert.rejects(f.invoke({ ...request, resourceId, input: { item: { text: '受限事项', id: 'injected-item-id' } } }, scope), error => error.status === 400);
  await assert.rejects(f.invoke({ ...request, resourceId, input: { item: { text: '受限事项', done: true } } }, scope), error => error.status === 400);
  assert.equal(await readFile(f.file, 'utf8'), raw);
  assert.equal((await f.invoke({ operation: 'list' })).items.length, 0);
});

test('explicit resource collisions preserve existing records and deleted resource identities', async t => {
  const f = await fixture(t);
  const legacy = await f.invoke({ operation: 'add', input: { item: { text: '原有整空间创建' } }, idempotencyKey: 'legacy-create' });
  assert.match(legacy.resourceId, /^r_[A-Za-z0-9_-]{16,64}$/);
  const request = { operation: 'add', resourceId: legacy.resourceId, input: { item: { text: '禁止覆盖' } }, idempotencyKey: 'collision' };
  let raw = await readFile(f.file, 'utf8');
  await assert.rejects(f.invoke(request), error => error.code === 'RESOURCE_EXISTS');
  assert.equal(await readFile(f.file, 'utf8'), raw);
  await f.invoke({ operation: 'delete', resourceId: legacy.resourceId, expectedRevision: '1', idempotencyKey: 'delete-legacy' });
  raw = await readFile(f.file, 'utf8');
  await assert.rejects(f.invoke({ ...request, idempotencyKey: 'reuse-deleted' }), error => error.code === 'RESOURCE_EXISTS');
  assert.equal(await readFile(f.file, 'utf8'), raw);
});

test('explicit uninitialized spaces remain read-only until their first authorized create', async t => {
  const f = await fixture(t, { missing: true });
  assert.equal((await f.invoke({ operation: 'list' })).revision, 'uninitialized');
  await f.invoke({ operation: 'stats', input: { period: 'week', anchor: '2026-11-12' } });
  await f.invoke({ operation: 'events' });
  await assert.rejects(access(f.file), error => error.code === 'ENOENT');
  const resourceId = 'r_00000000000000000000000000000000';
  await assert.rejects(f.invoke({ operation: 'update', resourceId, expectedRevision: '1', input: { flagged: true }, idempotencyKey: 'missing' }), error => error.status === 404);
  await assert.rejects(access(f.file), error => error.code === 'ENOENT');
  await assert.rejects(f.invoke({ operation: 'add', input: { item: { text: '' } }, idempotencyKey: 'invalid-create' }));
  await assert.rejects(access(f.file), error => error.code === 'ENOENT');
  await f.invoke({ operation: 'add', input: { item: { text: '家庭清单' } }, idempotencyKey: 'family-create', spaceId: 'family' });
  assert.equal((await f.invoke({ operation: 'list', spaceId: 'family' })).items.length, 1);
  await assert.rejects(access(f.file), error => error.code === 'ENOENT');
});

test('assertions bind app, method, path, exact body, action, space, resource, identity and expiry', async t => {
  const f = await fixture(t);
  const created = await f.invoke({ operation: 'add', input: { item: { text: '仅本人可读的事项' } }, idempotencyKey: 'scope-create' });
  const before = await readFile(f.file, 'utf8');
  const request = { operation: 'list', spaceId: 'personal' };
  const raw = Buffer.from(JSON.stringify(request));
  for (const overrides of [
    { appId: 'other' }, { method: 'GET' }, { path: '/other' }, { bodyHash: 'bad' },
    { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 60000 },
    { userId: '' }, { clientId: '' }, { requestId: '' }, { grantId: '' },
    { resources: [] }, { resources: ['*', created.resourceId] }, { v: 2 },
  ]) await assert.rejects(f.service.handle(raw, f.sign(request, overrides, raw)), error => error.status === 401);
  const signed = f.sign(request, {}, raw);
  await assert.rejects(f.service.handle(Buffer.from(JSON.stringify({ ...request, spaceId: 'family' })), signed), error => error.status === 401);
  await assert.rejects(f.service.handle(raw, signed.slice(0, -4) + 'AAAA'), error => error.status === 401);
  await assert.rejects(f.service.handle(raw, undefined), error => error.status === 401);
  await assert.rejects(f.invoke(request, { action: 'create' }), error => error.status === 403);
  await assert.rejects(f.invoke(request, { spaceId: 'family' }), error => error.status === 403);
  const denied = { operation: 'update', resourceId: created.resourceId, expectedRevision: '1', input: { flagged: true }, idempotencyKey: 'denied' };
  await assert.rejects(f.invoke(denied, { resources: ['r_00000000000000000000000000000000'] }), error => error.status === 404);
  assert.deepEqual((await f.invoke(request, { resources: ['r_00000000000000000000000000000000'] })).items, []);
  await assert.rejects(f.invoke({ operation: 'update', resourceId: created.resourceId, expectedRevision: '1', input: { done: true }, idempotencyKey: 'bypass-complete' }));
  await assert.rejects(f.invoke({ operation: 'add', input: { item: { text: '不得伪造身份', id: 'chosen' } }, idempotencyKey: 'invalid-id' }));
  await assert.rejects(f.invoke({ operation: 'add', input: { item: { text: '不得伪造完成', done: true } }, idempotencyKey: 'invalid-done' }));
  await assert.rejects(f.invoke({ operation: 'list', userId: 'user-b' }));
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('authorized resource lists, statistics and events exclude other records and spaces', async t => {
  const f = await fixture(t);
  const first = await f.invoke({ operation: 'add', input: { item: { text: '第一项', estHours: 1, tags: ['共享'] } }, idempotencyKey: 'first' });
  const second = await f.invoke({ operation: 'add', input: { item: { text: '第二项', estHours: 2, tags: ['个人'] } }, idempotencyKey: 'second' });
  const family = await f.invoke({ operation: 'add', spaceId: 'family', input: { item: { text: '其他空间' } }, idempotencyKey: 'family' });
  for (const [item, hours] of [[first, 1.5], [second, 9]]) await f.invoke({ operation: 'complete', resourceId: item.resourceId, expectedRevision: '1', input: { actualHours: hours, completedAt: '2026-11-12 12:00:00' }, idempotencyKey: `done-${hours}` });
  const scope = { resources: [first.resourceId] };
  const listing = await f.invoke({ operation: 'list' }, scope);
  assert.deepEqual(listing.items.map(item => item.resourceId), [first.resourceId]);
  const stats = await f.invoke({ operation: 'stats', input: { period: 'week', anchor: '2026-11-12' } }, scope);
  assert.equal(stats.stats.total.actualHours, 1.5);
  assert.equal(JSON.stringify(stats).includes('个人'), false);
  const events = await f.invoke({ operation: 'events', input: { after: 0 } }, scope);
  assert.deepEqual(events.events.map(event => event.resourceId), [first.resourceId, first.resourceId]);
  assert.equal(events.cursor, 4);
  await assert.rejects(f.invoke({ operation: 'update', resourceId: family.resourceId, expectedRevision: '1', input: { flagged: true }, idempotencyKey: 'cross-space' }), error => error.status === 404);
});

test('event retention requires a snapshot reset and never skips retained events', async t => {
  const f = await fixture(t);
  const created = await f.invoke({ operation: 'add', input: { item: { text: '游标测试' } }, idempotencyKey: 'cursor-create' });
  const data = JSON.parse(await readFile(f.file, 'utf8'));
  data._business.cursor = 2050;
  data._business.events = Array.from({ length: 2048 }, (_, index) => ({ ...created.event, id: `event-${index}`, cursor: index + 3 }));
  await writeFile(f.file, JSON.stringify(data));
  const expired = await f.invoke({ operation: 'events', input: { after: 0 } });
  assert.equal(expired.resetRequired, true);
  assert.equal(expired.minCursor, 3);
  assert.equal(expired.cursor, 2050);
  assert.deepEqual(expired.events, []);
  const retained = await f.invoke({ operation: 'events', input: { after: 2 } });
  assert.equal(retained.resetRequired, false);
  assert.equal(retained.events.length, 2048);
  assert.equal(retained.events.at(-1).cursor, retained.cursor);
  assert.equal((await f.invoke({ operation: 'events', input: { after: 2051 } })).resetRequired, true);
});

test('distinct store bindings, raw key loading and managed configuration fail closed', async t => {
  const f = await fixture(t);
  assert.throws(() => new BusinessService({ key: Buffer.from('short'), spaces: f.spaces }), /at least 32 bytes/);
  assert.throws(() => new BusinessService({ key: f.key, spaces: { first: f.file, second: f.file } }), /distinct/);
  assert.throws(() => new BusinessService({ key: f.key, spaces: { first: './relative.json' } }), /absolute/);
  await symlink(f.file, join(f.directory, 'alias.json'));
  assert.throws(() => new BusinessService({ key: f.key, spaces: { first: f.file, second: join(f.directory, 'alias.json') } }), /distinct/);
  assert.equal(loadBusinessService({}), null);
  assert.throws(() => loadBusinessService({ REMINDER_MANAGED: 'true' }), /0 or 1/);
  assert.throws(() => loadBusinessService({ REMINDER_MANAGED: '1' }), /requires/);
  const keyFile = join(f.directory, 'key');
  const spacesFile = join(f.directory, 'spaces.json');
  await writeFile(keyFile, f.key, { mode: 0o600 });
  await writeFile(spacesFile, JSON.stringify({ spaces: f.spaces }), { mode: 0o600 });
  const configured = loadBusinessService({ REMINDER_MANAGED: '1', REMINDER_BUSINESS_KEY_FILE: keyFile, REMINDER_BUSINESS_SPACES_FILE: spacesFile });
  const request = { operation: 'list', spaceId: 'personal' };
  const raw = Buffer.from(JSON.stringify(request));
  assert.equal((await configured.handle(raw, f.sign(request, {}, raw))).items.length, 0);
  await chmod(keyFile, 0o644);
  assert.throws(() => loadBusinessService({ REMINDER_MANAGED: '1', REMINDER_BUSINESS_KEY_FILE: keyFile, REMINDER_BUSINESS_SPACES_FILE: spacesFile }), /private regular files/);
  await chmod(keyFile, 0o600);
  const linkedKey = join(f.directory, 'linked-key');
  await symlink(keyFile, linkedKey);
  assert.throws(() => loadBusinessService({ REMINDER_MANAGED: '1', REMINDER_BUSINESS_KEY_FILE: linkedKey, REMINDER_BUSINESS_SPACES_FILE: spacesFile }), /private regular files/);
  await writeFile(spacesFile, '{}');
  assert.throws(() => loadBusinessService({ REMINDER_MANAGED: '1', REMINDER_BUSINESS_KEY_FILE: keyFile, REMINDER_BUSINESS_SPACES_FILE: spacesFile }), /spaces/);
});

test('managed HTTP rejects all raw API paths while signed business requests and public health work', async t => {
  const f = await fixture(t);
  const server = createServer({ businessService: f.service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/data', '/api/stats', '/api/items', '/api/items/pool:0', '/api/items/recurring:0/record']) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) assert.equal((await fetch(base + path, { method })).status, 403);
  }
  assert.equal((await fetch(base + '/')).status, 200);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok', appId: 'reminder', managed: true });
  const request = { operation: 'add', spaceId: 'personal', input: { item: { text: '签名业务请求' } }, idempotencyKey: 'http-create' };
  const raw = Buffer.from(JSON.stringify(request));
  assert.equal((await fetch(base + '/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })).status, 401);
  const response = await fetch(base + '/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-praxis-assertion': f.sign(request, {}, raw) }, body: raw });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).item.text, '签名业务请求');
  assert.equal((await fetch(base + '/api/business?bypass=1', { method: 'POST' })).status, 405);
  const cli = spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, '--data', f.file, 'ls', '--json'], { encoding: 'utf8', env: { ...process.env, REMINDER_MANAGED: '1' } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /controlled business API/);
});

test('an assertion expiring while a writer waits cannot mutate the document', async t => {
  let clock = 2000000000000;
  const f = await fixture(t, { now: () => clock });
  const before = await readFile(f.file, 'utf8');
  const store = f.service.stores.get('personal');
  let release;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const held = store.lock(async () => { ready(); await new Promise(resolve => { release = resolve; }); });
  await started;
  const pending = f.invoke({ operation: 'add', input: { item: { text: '过期后不得提交' } }, idempotencyKey: 'expire' });
  clock += 26000;
  release();
  await held;
  await assert.rejects(pending, error => error.status === 401);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('concurrent retries commit one item and one event, with a canonical request fingerprint', async t => {
  const f = await fixture(t);
  const request = { operation: 'add', input: { item: { text: '并发重试', tags: ['家庭'] } }, idempotencyKey: 'same-create' };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.invoke(request)));
  assert.equal(new Set(results.map(result => result.resourceId)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal((await f.invoke({ operation: 'list' })).items.length, 1);
  assert.equal((await f.invoke({ operation: 'events' })).events.length, 1);
  const reordered = { idempotencyKey: 'same-create', input: { item: { tags: ['家庭'], text: '并发重试' } }, operation: 'add' };
  assert.equal((await f.invoke(reordered)).replayed, true);
});

test('invalid input, metadata mismatch and failed atomic commits leave the business file unchanged', async t => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');
  for (const request of [
    { operation: 'add', input: { item: { text: '日期错误', date: '2027-02-29' } }, idempotencyKey: 'bad-date' },
    { operation: 'add', input: { item: { text: '字段错误', actualHours: -1 } }, idempotencyKey: 'bad-hours' },
    { operation: 'add', input: { item: { text: '元数据错误', _business: {} } }, idempotencyKey: 'bad-metadata' },
    { operation: 'add', input: { item: { text: '缺少幂等键' } } },
    { operation: 'list', input: { file: '/tmp/unauthorized' } },
  ]) await assert.rejects(f.invoke(request));
  assert.equal(await readFile(f.file, 'utf8'), before);
  const store = f.service.stores.get('personal');
  const original = store.atomicWrite;
  store.atomicWrite = async () => { throw new Error('Synthetic disk failure'); };
  const add = { operation: 'add', input: { item: { text: '磁盘失败后重试' } }, idempotencyKey: 'disk-retry' };
  await assert.rejects(f.invoke(add), /Synthetic disk failure/);
  assert.equal(await readFile(f.file, 'utf8'), before);
  store.atomicWrite = original;
  assert.equal((await f.invoke(add)).replayed, false);
  assert.equal((await f.invoke({ operation: 'events' })).events.length, 1);
  const data = JSON.parse(await readFile(f.file, 'utf8'));
  data.pool[0].text = '未通过共享层写入';
  await writeFile(f.file, JSON.stringify(data));
  const damaged = await readFile(f.file, 'utf8');
  await assert.rejects(f.invoke({ operation: 'list' }), error => error.code === 'INVALID_BUSINESS_STATE');
  await assert.rejects(f.invoke({ ...add, idempotencyKey: 'must-not-overwrite' }), error => error.code === 'INVALID_BUSINESS_STATE');
  assert.equal(await readFile(f.file, 'utf8'), damaged);
});

test('managed recurring execution reuses Store.record and feeds weekly, monthly and trend analysis', async t => {
  const f = await fixture(t);
  const template = await f.invoke({ operation: 'add', input: { collection: 'recurring', item: { text: '家庭周回顾', estHours: 2, tags: ['每周', '家庭'] } }, idempotencyKey: 'routine-template' });
  const run = async (key, actualHours, completedAt) => f.invoke({ operation: 'record', sourceResourceId: template.resourceId, expectedRevision: template.revision, idempotencyKey: key, input: { actualHours, completedAt } }, { sourceReadGranted: true });
  const first = await run('routine-first', 1.5, '2026-11-12 12:34:56');
  const previous = await run('routine-previous', 3, '2026-11-05 12:34:56');
  const zero = await run('routine-zero', 0, '2026-11-12 16:00:00');
  assert.equal(first.collection, 'history');
  assert.equal(first.sourceResourceId, template.resourceId);
  assert.notEqual(first.resourceId, template.resourceId);
  assert.equal(first.item.sourceRecurringId, template.item.id);
  assert.equal(first.item.estHours, 2);
  assert.deepEqual(first.item.tags, ['每周', '家庭']);
  assert.equal(first.item.done, true);
  assert.equal(first.item.completedAt, '2026-11-12 12:34:56');
  assert.equal(first.item.date, '2026-11-12');
  assert.equal(first.revision, '1');
  assert.equal(first.event.operation, 'record');
  assert.equal(first.event.resourceId, first.resourceId);
  assert.equal(zero.item.actualHours, 0);
  assert.notEqual(previous.resourceId, first.resourceId);
  const listing = await f.invoke({ operation: 'list' });
  const unchanged = listing.items.find(item => item.resourceId === template.resourceId);
  assert.deepEqual(unchanged.item, template.item);
  assert.equal(unchanged.revision, template.revision);
  const weekly = (await f.invoke({ operation: 'stats', input: { period: 'week', anchor: '2026-11-12' } })).stats;
  assert.equal(weekly.total.count, 2);
  assert.equal(weekly.total.actualHours, 1.5);
  assert.equal(weekly.total.estHours, 4);
  assert.equal(weekly.taskRows[0].key, `recurring:${template.item.id}`);
  assert.deepEqual(weekly.trendRows.map(row => [row.periodStart, row.actualHours, row.count]), [['2026-11-02', 3, 1], ['2026-11-09', 1.5, 2]]);
  const monthly = (await f.invoke({ operation: 'stats', input: { period: 'month', anchor: '2026-11-12' } })).stats;
  assert.equal(monthly.total.actualHours, 4.5);
  assert.equal(monthly.total.count, 3);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).version, 2);
});

test('record requires both space creation and a trusted source-read claim bound to the exact source', async t => {
  const f = await fixture(t);
  const template = await f.invoke({ operation: 'add', input: { collection: 'recurring', item: { text: '私人模板内容', estHours: 1 } }, idempotencyKey: 'private-template' });
  const another = await f.invoke({ operation: 'add', input: { collection: 'recurring', item: { text: '另一个模板', estHours: 1 } }, idempotencyKey: 'another-template' });
  const record = { operation: 'record', sourceResourceId: template.resourceId, expectedRevision: '1', idempotencyKey: 'must-be-authorized', input: { actualHours: 1 } };
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(f.invoke(record), error => error.status === 403);
  await assert.rejects(f.invoke(record, { sourceReadGranted: false }), error => error.status === 401);
  await assert.rejects(f.invoke(record, { sourceReadGranted: 'true' }), error => error.status === 401);
  await assert.rejects(f.invoke(record, { sourceReadGranted: true, action: 'read' }), error => error.status === 403);
  await assert.rejects(f.invoke(record, { sourceReadGranted: true, resources: [template.resourceId] }), error => error.status === 403);
  await assert.rejects(f.invoke({ ...record, sourceReadGranted: true }), error => error.status === 400);
  await assert.rejects(f.invoke({ ...record, input: { actualHours: 1, sourceReadGranted: true } }, { sourceReadGranted: true }), error => error.status === 400);
  const body = { spaceId: 'personal', ...record };
  const raw = Buffer.from(JSON.stringify(body));
  const assertion = f.sign(body, { sourceReadGranted: true }, raw);
  await assert.rejects(f.service.handle(Buffer.from(JSON.stringify({ ...body, sourceResourceId: another.resourceId })), assertion), error => error.status === 401);
  await assert.rejects(f.invoke({ ...record, spaceId: 'family' }, { sourceReadGranted: true }), error => error.status === 404);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('record rejects stale, non-template, malformed source and input without business side effects', async t => {
  const f = await fixture(t);
  const template = await f.invoke({ operation: 'add', input: { collection: 'recurring', item: { text: '例行任务', estHours: 1 } }, idempotencyKey: 'valid-source' });
  const task = await f.invoke({ operation: 'add', input: { item: { text: '普通任务' } }, idempotencyKey: 'ordinary-task' });
  const record = { operation: 'record', sourceResourceId: template.resourceId, expectedRevision: '1', idempotencyKey: 'invalid-run', input: { actualHours: 1 } };
  const before = await readFile(f.file, 'utf8');
  for (const request of [
    { ...record, sourceResourceId: task.resourceId },
    { ...record, sourceResourceId: template.item.id },
    { ...record, sourceResourceId: 'r_00000000000000000000000000000000' },
    { ...record, resourceId: template.resourceId },
    { ...record, expectedRevision: '999' },
    { ...record, expectedRevision: undefined },
    { ...record, idempotencyKey: undefined },
    { ...record, input: {} },
    { ...record, input: { actualHours: -1 } },
    { ...record, input: { actualHours: 100001 } },
    { ...record, input: { actualHours: 1, completedAt: '2027-02-29 12:00:00' } },
    { ...record, input: { actualHours: 1, sourceRecurringId: 'forged' } },
  ]) await assert.rejects(f.invoke(request, { sourceReadGranted: true }));
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('record concurrent retries and restarts preserve exactly one execution, receipt and event', async t => {
  const f = await fixture(t);
  const template = await f.invoke({ operation: 'add', input: { collection: 'recurring', item: { text: '重试例行', estHours: 2 } }, idempotencyKey: 'retry-template' });
  const record = { operation: 'record', sourceResourceId: template.resourceId, expectedRevision: '1', idempotencyKey: 'one-execution', input: { actualHours: 2.5, completedAt: '2026-11-12 13:00:00' } };
  const runs = await Promise.all(Array.from({ length: 5 }, () => f.invoke(record, { sourceReadGranted: true })));
  assert.equal(new Set(runs.map(run => run.resourceId)).size, 1);
  assert.equal(runs.filter(run => !run.replayed).length, 1);
  const before = await readFile(f.file, 'utf8');
  f.restart();
  assert.equal((await f.invoke(record, { sourceReadGranted: true })).replayed, true);
  await assert.rejects(f.invoke(record), error => error.status === 403);
  await assert.rejects(f.invoke({ ...record, input: { actualHours: 3 } }, { sourceReadGranted: true }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal((await f.invoke({ operation: 'list', input: { collection: 'history' } })).items.length, 1);
  assert.deepEqual((await f.invoke({ operation: 'events' })).events.map(event => event.operation), ['add', 'record']);
});

test('adapter-only integrity requires a signed whole-space read and reveals only counts and opaque versions', async t => {
  const data = empty();
  data.recurring.push({ id: 'private-legacy-template', text: '私人例行正文', tags: ['每周'], estHours: 1 });
  data.pool.push({ id: 'private-legacy-task', text: '私人任务正文', notes: '私人备注', tags: ['家庭'] });
  const f = await fixture(t, { data });
  const rawBefore = await readFile(f.file, 'utf8');
  const request = { operation: 'integrity', spaceId: 'personal' };
  const raw = Buffer.from(JSON.stringify(request));
  await assert.rejects(f.service.handle(raw, undefined), error => error.status === 401);
  await assert.rejects(f.invoke(request, { action: 'create' }), error => error.status === 403);
  await assert.rejects(f.invoke(request, { resources: ['r_00000000000000000000000000000000'] }), error => error.status === 403);
  await assert.rejects(f.invoke({ ...request, input: {} }), error => error.status === 400);
  await assert.rejects(f.invoke({ ...request, resourceId: 'r_00000000000000000000000000000000' }), error => error.status === 400);
  const result = await f.invoke(request);
  assert.deepEqual(Object.keys(result).sort(), ['counts', 'cursor', 'resourceCount', 'revision', 'spaceId']);
  assert.deepEqual(result.counts, { recurring: 1, plans: 0, pool: 1, history: 0 });
  assert.equal(result.resourceCount, 2);
  assert.equal(result.cursor, 0);
  assert.notEqual(result.revision, digest(Buffer.from(rawBefore)));
  for (const secret of ['private-legacy-template', 'private-legacy-task', '私人例行正文', '私人任务正文', '私人备注', f.file]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await readFile(f.file, 'utf8'), rawBefore);
  const missing = await f.invoke({ operation: 'integrity', spaceId: 'family' });
  assert.deepEqual(missing.counts, { recurring: 0, plans: 0, pool: 0, history: 0 });
  assert.equal(missing.revision, 'uninitialized');
  assert.equal(missing.resourceCount, 0);
  await assert.rejects(access(f.familyFile), error => error.code === 'ENOENT');
});
