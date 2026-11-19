import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { BusinessService } from '../src/business.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reminder-ui-redirect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'checklist.json');
  const raw = JSON.stringify({ version: 2, updated: '', recurring: [], plans: [], pool: [], history: [] });
  await writeFile(file, raw);
  const businessService = new BusinessService({ key: randomBytes(32), spaces: { personal: file } });
  async function serve(options) {
    const server = createServer({ store: new Store(file), ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
  }
  return { file, raw, businessService, serve };
}

// URL credential fields are generated only for the rejection cases in this test.
function syntheticUserinfo(withPassword) {
  const target = new URL('https://business.example.test/');
  target.username = 'fixture';
  if (withPassword) target.password = 'fixture';
  return target.href;
}

test('managed root GET and HEAD redirect to the trusted UI without forwarding incoming query data', async t => {
  const f = await fixture(t);
  const ui = 'https://business.example.test/business/reminder/';
  const base = await f.serve({ businessService: f.businessService, businessUiUrl: ui });
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/?private=must-not-forward']) {
      const response = await fetch(base + path, { method, redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), ui);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
    }
  }
  assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok', appId: 'reminder', managed: true });
  for (const path of ['/app.js', '/styles.css', '/views.js', '/index.html']) assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/data/checklist.json')).status, 404);
  assert.equal((await fetch(base + '/public/data/checklist.json')).status, 404);
  for (const path of ['/api/data', '/api/stats', '/api/items']) assert.equal((await fetch(base + path)).status, 403);
  assert.equal(await readFile(f.file, 'utf8'), f.raw);
});

test('managed UI configuration accepts HTTPS and explicit loopback HTTP origins with paths', async t => {
  const f = await fixture(t);
  for (const ui of ['https://business.example.test/business/reminder/', 'https://business.example.test', 'http://localhost:4326/business/reminder/', 'http://127.0.0.1:4326/business/reminder/', 'http://[::1]:4326/business/reminder/']) {
    const base = await f.serve({ businessService: f.businessService, businessUiUrl: ui });
    const response = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), new URL(ui).href);
  }
});

test('managed UI configuration rejects unsafe protocols, remote HTTP, credentials, query and fragments', () => {
  const businessService = { handle() {} };
  for (const businessUiUrl of ['', ' ', null, [], '/business/reminder/', '//business.example.test/', 'ftp://business.example.test/', 'javascript:alert(1)', 'http://business.example.test/', 'http://localhost.example.test/', 'https://@business.example.test/', syntheticUserinfo(false), syntheticUserinfo(true), 'https://business.example.test/?secret=value', 'https://business.example.test/?', 'https://business.example.test/#section', 'https://business.example.test/#', 'https://business.example.test/path with space', 'https://business.example.test/\npath', 'https://business.example.test/\\path', 'https:///business.example.test/', 'https://*.example.test/']) {
    assert.throws(() => createServer({ businessService, businessUiUrl }), /REMINDER_BUSINESS_UI_URL/);
  }
});

test('managed mode without a UI target keeps static entry behavior and blocked raw APIs', async t => {
  const f = await fixture(t);
  const base = await f.serve({ businessService: f.businessService });
  const response = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('location'), false);
  assert.match(await response.text(), /Reminder/);
  assert.equal((await fetch(base + '/api/data')).status, 403);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('standalone mode ignores managed-only UI configuration and retains its own data API', async t => {
  const f = await fixture(t);
  for (const businessUiUrl of ['https://business.example.test/business/reminder/', 'not-a-managed-url']) {
    const base = await f.serve({ businessService: null, businessUiUrl });
    const response = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('location'), false);
    assert.equal((await fetch(base + '/api/data')).status, 200);
    assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok', appId: 'reminder', managed: false });
  }
  assert.equal(await readFile(f.file, 'utf8'), f.raw);
});

test('managed UI URL can come from environment while an explicit server option takes precedence', async t => {
  const f = await fixture(t);
  const previous = process.env.REMINDER_BUSINESS_UI_URL;
  process.env.REMINDER_BUSINESS_UI_URL = 'https://environment.example.test/business/reminder/';
  try {
    const fromEnvironment = await f.serve({ businessService: f.businessService });
    assert.equal((await fetch(fromEnvironment + '/', { redirect: 'manual' })).headers.get('location'), process.env.REMINDER_BUSINESS_UI_URL);
    const explicit = 'https://explicit.example.test/business/reminder/';
    const override = await f.serve({ businessService: f.businessService, businessUiUrl: explicit });
    assert.equal((await fetch(override + '/', { redirect: 'manual' })).headers.get('location'), explicit);
  } finally {
    if (previous === undefined) delete process.env.REMINDER_BUSINESS_UI_URL;
    else process.env.REMINDER_BUSINESS_UI_URL = previous;
  }
});
