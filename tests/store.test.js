import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, entries, isDone, validDate, validateDocument } from '../src/store.js';

const seed = new URL('./fixtures/checklist-v2.json', import.meta.url);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'reminder-store-'));
  const store = new Store(join(dir, 'checklist.json'));
  await store.importFile(seed.pathname);
  return { store, dir };
}
test('import preserves all fields, file order, legacy times and duplicate IDs', async () => {
  const { store } = await fixture();
  assert.equal(await readFile(store.file, 'utf8'), await readFile(seed, 'utf8'));
  const { data } = await store.read();
  assert.deepEqual([data.recurring.length, data.plans.length, data.pool.length, data.history.length], [2, 1, 0, 3]);
  assert.equal(data.history.filter(i => i.id === 'sample-dupe').length, 2);
  await assert.rejects(store.update('sample-dupe', { flagged: true }), /ID is not unique/);
  await store.update('history:1', { flagged: true });
  const fresh = (await store.read()).data;
  assert.equal(fresh.history[1].flagged, true);
  assert.equal(fresh.history[2].flagged, undefined);
  assert.equal(fresh.plans[0].completedAt, data.plans[0].completedAt);
});
test('CRUD, complete/restore and flag persistence across Store instances', async () => {
  const { store } = await fixture();
  const { item } = await store.add({ text: '测试任务', date: '2027-01', tags: ['个人'], actualHours: 0 });
  assert.match(item.addedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const done = await store.update(item.id, { done: true, flagged: true });
  assert.equal(done.item.done, true);
  assert.match(done.item.completedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(entries((await new Store(store.file).read()).data).find(e => e.item.id === item.id).item.flagged, true);
  await store.update(item.id, { done: false, date: '', actualHours: null });
  const updated = entries((await store.read()).data).find(e => e.item.id === item.id).item;
  assert.equal(updated.completedAt, undefined);
  assert.equal(updated.actualHours, undefined);
  await store.remove(item.id);
  assert.equal(entries((await store.read()).data).some(e => e.item.id === item.id), false);
  await store.update('sample-finished', { done: false });
  assert.equal(isDone((await store.read()).data.history[0], 'history'), false);
});
test('rejects invalid date/estimate/type without writing, keeps unknown legacy fields', async () => {
  const { store } = await fixture();
  const before = await readFile(store.file, 'utf8');
  for (const input of [
    { text: '' }, { text: 'x', date: '2027-02-29' }, { text: 'x', date: '2026-13' },
    { text: 'x', date: '2026-11-11 24:00' }, { text: 'x', tags: '个人' },
    { text: 'x', actualHours: -1 }, { text: 'x', estHours: 0 }, { text: 'x', done: 'yes' },
    { text: 'x', id: 'pool:0' }, { text: 'x', id: '' },
  ]) await assert.rejects(store.add(input));
  await assert.rejects(store.update('sample-template', { done: true }), /templates/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  await store.update('sample-template', { text: 'Review sample record' });
  assert.equal((await store.read()).data.recurring.find(i => i.id === 'sample-template').state, 'legacy');
  for (const date of ['2027', '2027-01', '2027-01-16', '2026-11-02 19:00', '2028-02-29']) assert.equal(validDate(date), true);
  assert.equal(validDate('2027-01-01 00:00:00'), false);
  const invalid = (await store.read()).data;
  invalid.history[0].completedAt = {};
  assert.throws(() => validateDocument(invalid), /completedAt must be a string/);
});
test('serial lock prevents lost concurrent writes, revision rejects stale index ops', async () => {
  const { store, dir } = await fixture();
  const old = await store.read();
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Store(store.file).add({ text: `并发${i}` })));
  assert.equal((await store.read()).data.pool.length, 12);
  await assert.rejects(store.remove('history:1', { revision: old.revision }), error => error.status === 409);
  assert.equal((await store.read()).data.history.length, 3);
  assert.equal((await readdir(dir)).some(name => /\.(tmp|lock)$/.test(name)), false);
});
test('routine run appends history, zero hours valid, template unchanged, not active after restore', async () => {
  const { store } = await fixture();
  const before = (await store.read()).data.recurring[0];
  const result = await store.record('sample-routine', 0, { completedAt: '2026-11-11 08:09:10' });
  assert.equal(result.item.actualHours, 0);
  assert.equal(result.item.sourceRecurringId, 'sample-routine');
  assert.equal(result.item.estHours, before.estHours);
  assert.equal(result.item.date, '2026-11-11');
  assert.notEqual(result.item.id, before.id);
  assert.deepEqual(result.data.recurring[0], before);
  await assert.rejects(store.record('sample-routine', -1));
  await assert.rejects(store.record('missing', 1));
  await assert.rejects(store.record('sample-routine', 1, { completedAt: '2027-02-29 01:02:03' }));
});
test('corrupt JSON not overwritten; replace-import requires explicit confirm and keeps backup', async () => {
  const { store } = await fixture();
  const original = await readFile(store.file, 'utf8');
  await assert.rejects(store.importFile(seed.pathname), /--replace/);
  await writeFile(store.file, 'broken');
  await assert.rejects(store.add({ text: 'x' }), /invalid JSON/);
  assert.equal(await readFile(store.file, 'utf8'), 'broken');
  const result = await store.importFile(seed.pathname, { replace: true });
  assert.equal(await readFile(result.backup, 'utf8'), 'broken');
  assert.equal(await readFile(store.file, 'utf8'), original);
});
test('stale lock not auto-reclaimed, preventing concurrent overwrite via successor locks', async () => {
  const { store } = await fixture();
  const before = await readFile(store.file, 'utf8');
  await writeFile(`${store.file}.lock`, '2147483647');
  await assert.rejects(store.add({ text: '不得写入' }), error => error.code === 'STALE_LOCK');
  assert.equal(await readFile(`${store.file}.lock`, 'utf8'), '2147483647');
  assert.equal(await readFile(store.file, 'utf8'), before);
});
