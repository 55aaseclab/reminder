import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const publicOrigin = 'https://workbench.example.test';
const localOrigins = ['http://reminders.example.test:4322', 'http://localhost:4322', 'http://127.0.0.1:4322'];

async function serve(t, options = {}, useEnvironment = false) {
  const directory = await mkdtemp(join(tmpdir(), 'reminder-origins-'));
  const store = new Store(join(directory, 'data.json'));
  await store.importFile(new URL('./fixtures/checklist-v2.json', import.meta.url).pathname);
  const previous = process.env.REMINDER_ALLOWED_ORIGINS;
  let server;
  try {
    if (!useEnvironment) delete process.env.REMINDER_ALLOWED_ORIGINS;
    server = createServer({ store, ...options });
  } finally {
    if (previous === undefined) delete process.env.REMINDER_ALLOWED_ORIGINS;
    else process.env.REMINDER_ALLOWED_ORIGINS = previous;
  }
  t.after(async () => {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const write = (path, method, value, revision, headers = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'If-Match': revision, ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { store, base, write };
}

// URL credential fields are generated only for the rejection cases in this test.
function syntheticUserinfo(withPassword) {
  const target = new URL('https://example.test/');
  target.username = 'fixture';
  if (withPassword) target.password = 'fixture';
  return target.href;
}

test('origin configuration rejects empty lists, unsafe protocols, userinfo, and non-origin URLs', () => {
  for (const value of ['', ' ', ',', `${publicOrigin},`, `,${publicOrigin}`, 'ftp://example.test', 'file:///etc/passwd', 'javascript:alert(1)', '*', 'https://*.example.test', 'https://@example.test', syntheticUserinfo(false), syntheticUserinfo(true), 'https://example.test/', 'https://example.test/path', 'https://example.test\\', 'https://exa\tmple.test', 'https://example.test?query=1', 'https://example.test#fragment', 'https://example.test:99999', 'not-an-origin', null, []]) {
    assert.throws(() => createServer({ store: {}, allowedOrigins: value }), /REMINDER_ALLOWED_ORIGINS/, String(value));
  }
});

test('configured HTTPS and explicitly listed local origins support POST, PATCH, and DELETE', async t => {
  const { store, write } = await serve(t, { allowedOrigins: ` ${publicOrigin}, ${localOrigins.join(', ')} ` });
  for (const origin of [publicOrigin, ...localOrigins]) {
    let snapshot = await store.read();
    const response = await write('/api/items', 'POST', { item: { text: '合成来源测试条目' } }, snapshot.revision, { Origin: origin });
    assert.equal(response.status, 201, origin);
    const added = await response.json();
    const updated = await write(`/api/items/${encodeURIComponent(added.ref)}`, 'PATCH', { flagged: true }, added.revision, { Origin: origin });
    assert.equal(updated.status, 200, origin);
    snapshot = await updated.json();
    assert.equal(snapshot.item.flagged, true);
    assert.equal((await write(`/api/items/${encodeURIComponent(added.ref)}`, 'DELETE', undefined, snapshot.revision, { Origin: origin })).status, 200, origin);
  }
});

test('configured origin checks reject foreign/replayed origins, Host spoofing, and forwarded-header bypass without writes', async t => {
  const { store, base, write } = await serve(t, { allowedOrigins: publicOrigin });
  const before = await store.read();
  const rejectedHeaders = [
    {},
    { Origin: 'null' },
    { Origin: 'https://foreign.example' },
    { Origin: publicOrigin + '.foreign.example' },
    { Origin: publicOrigin + '/' },
    { Origin: publicOrigin.replace('https:', 'http:'), Host: 'workbench.example.test:4322' },
    { Origin: publicOrigin + ':4322' },
    { Origin: localOrigins[0], Host: 'reminders.example.test:4322' },
    { Origin: localOrigins[1], Host: 'localhost:4322', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'workbench.example.test:4322' },
    { Origin: 'https://foreign.example', Host: 'workbench.example.test:4322', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'workbench.example.test:4322', Forwarded: 'proto=https;host="workbench.example.test:4322"' },
    { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'workbench.example.test:4322', Forwarded: 'proto=https;host="workbench.example.test:4322"' },
  ];
  for (const headers of rejectedHeaders) {
    for (const [path, method, value] of [
      ['/api/items', 'POST', { item: { text: '不应创建的合成条目' } }],
      ['/api/items/plans%3A0', 'PATCH', { flagged: true }],
      ['/api/items/plans%3A0', 'DELETE', undefined],
      ['/api/items/recurring%3A0/record', 'POST', { actualHours: 1 }],
    ]) {
      const response = await write(path, method, value, before.revision, headers);
      assert.equal(response.status, 403, `${method} ${JSON.stringify(headers)}`);
      assert.equal((await response.json()).code, 'ORIGIN_REJECTED');
    }
  }
  assert.deepEqual(await store.read(), before);
  assert.equal((await fetch(base + '/api/data')).status, 200);
  const stale = await write('/api/items', 'POST', { item: { text: '合成过期版本' } }, 'stale', { Origin: publicOrigin });
  assert.equal(stale.status, 409);
  assert.deepEqual(await store.read(), before);
});

test('unconfigured mode preserves missing-Origin and matching local HTTP writes', async t => {
  const { store, base, write } = await serve(t);
  for (const headers of [{}, { Origin: base }]) {
    const { revision } = await store.read();
    assert.equal((await write('/api/items', 'POST', { item: { text: '合成本地客户端' } }, revision, headers)).status, 201);
  }
  const { revision } = await store.read();
  assert.equal((await write('/api/items', 'POST', { item: { text: '不应放行' } }, revision, { Origin: base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' })).status, 403);
});

test('environment configuration is honored and an explicit constructor list takes precedence', async t => {
  const previous = process.env.REMINDER_ALLOWED_ORIGINS;
  process.env.REMINDER_ALLOWED_ORIGINS = publicOrigin;
  try {
    const configured = await serve(t, {}, true);
    let snapshot = await configured.store.read();
    assert.equal((await configured.write('/api/items', 'POST', { item: { text: '合成环境来源' } }, snapshot.revision, { Origin: publicOrigin })).status, 201);
    snapshot = await configured.store.read();
    assert.equal((await configured.write('/api/items', 'POST', { item: { text: '未配置来源' } }, snapshot.revision)).status, 403);
    const explicit = await serve(t, { allowedOrigins: localOrigins[1] }, true);
    snapshot = await explicit.store.read();
    assert.equal((await explicit.write('/api/items', 'POST', { item: { text: '合成覆盖配置' } }, snapshot.revision, { Origin: localOrigins[1] })).status, 201);
    snapshot = await explicit.store.read();
    assert.equal((await explicit.write('/api/items', 'POST', { item: { text: '不应接受环境旧值' } }, snapshot.revision, { Origin: publicOrigin })).status, 403);
  } finally {
    if (previous === undefined) delete process.env.REMINDER_ALLOWED_ORIGINS;
    else process.env.REMINDER_ALLOWED_ORIGINS = previous;
  }
});
