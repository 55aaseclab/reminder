import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

test('Web/API and CLI share the data layer with conflict protection, run stats and iframe response headers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reminder-http-'));
  const store = new Store(join(dir, 'data.json'));
  await store.importFile(new URL('./fixtures/checklist-v2.json', import.meta.url).pathname);
  const server = createServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  const write = (path, method, value, revision, extra = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(revision && { 'If-Match': revision }), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.equal(page.headers.has('x-frame-options'), false);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /frame-ancestors/);
  assert.match(await page.text(), /Reminder/);
  for (const asset of ['/app.js', '/styles.css', '/views.js']) assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(base + '/data/checklist.json')).status, 404);
  let snapshot = await get('/api/data');
  assert.equal(snapshot.data.history.length, 3);
  assert.equal((await write('/api/items', 'POST', { item: { text: '无版本' } })).status, 428);
  assert.equal((await write('/api/items', 'POST', { item: { text: '跨域' } }, snapshot.revision, { Origin: 'http://unrelated.example' })).status, 403);
  const added = await write('/api/items', 'POST', { item: { text: 'HTTP条目', date: '2026-11-11 09:00', tags: ['个人'] } }, snapshot.revision);
  assert.equal(added.status, 201);
  const fresh = await added.json();
  assert.equal((await write(`/api/items/${fresh.ref}`, 'PATCH', { done: true }, snapshot.revision)).status, 409);
  const completed = await write(`/api/items/${fresh.ref}`, 'PATCH', { done: true, actualHours: 1.5 }, fresh.revision);
  assert.equal(completed.status, 200);
  assert.equal((await store.read()).data.plans.at(-1).actualHours, 1.5);
  // Simulate an independent CLI client: another Store writes the same file, then HTTP reads it.
  await new Store(store.file).update(fresh.item.id, { flagged: true });
  snapshot = await get('/api/data');
  assert.equal(snapshot.data.plans.at(-1).flagged, true);
  const execution = await write('/api/items/recurring%3A0/record', 'POST', { actualHours: 2, completedAt: '2026-11-11 10:20:30' }, snapshot.revision);
  assert.equal(execution.status, 201);
  snapshot = await execution.json();
  const stats = await get('/api/stats?period=week&anchor=2026-11-11');
  assert.equal(stats.taskRows.find(row => row.key === 'recurring:sample-routine').actualHours, 2);
  assert.equal(stats.trendRows[0].count, 1);
  assert.equal((await fetch(base + '/api/stats?period=bad')).status, 400);
  assert.equal((await write(`/api/items/${fresh.item.id}`, 'DELETE', undefined, snapshot.revision)).status, 200);
  // Network chunks can split UTF-8 characters; do not decode each Buffer separately.
  const current = await get('/api/data');
  const raw = Buffer.from(JSON.stringify({ item: { text: '分块汉字测试' } }));
  const split = raw.indexOf(Buffer.from('汉')) + 1;
  const received = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': current.revision } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.write(raw.subarray(0, split));
    delay(10).then(() => req.end(raw.subarray(split)));
  });
  assert.equal(received.status, 201);
  assert.equal(received.body.item.text, '分块汉字测试');
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).version, 2);
});
