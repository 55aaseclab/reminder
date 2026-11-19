import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const initial = () => ({ version: 2, updated: '2026-11-11', recurring: [], plans: [], pool: [], history: [] });

async function setup(t, data = initial()) {
  const dir = await mkdtemp(join(tmpdir(), 'reminder-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checklist.json');
  await writeFile(file, JSON.stringify(data));
  function run(args, { success = true, json = true } = {}) {
    const result = spawnSync(process.execPath, [cli, '--data', file, ...args, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
    assert.equal(result.error, undefined, result.error?.message);
    if (success) assert.equal(result.status, 0, result.stderr || result.error?.message);
    else assert.notEqual(result.status, 0, result.stdout);
    return { ...result, value: json && result.status === 0 ? JSON.parse(result.stdout) : undefined };
  }
  return { dir, file, run };
}

test('CLI add → ls → done → rm end-to-end, JSON shared across processes persists', async (t) => {
  const { file, run } = await setup(t);
  const created = run(['add', '写验收记录', '--date', '2027-01', '--tag', '产品-工程', '--notes', '备注', '--location', '书桌']).value;
  assert.equal(created.item.text, '写验收记录');
  const id = created.item.id;
  let listing = run(['ls']).value.items;
  assert.equal(listing.length, 1);
  assert.equal(listing[0].item.id, id);
  const done = run(['done', id, '--actual-hours', '1.5']).value;
  assert.equal(done.item.done, true);
  assert.equal(done.item.actualHours, 1.5);
  assert.match(done.item.completedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(run(['ls', '--view', 'completed']).value.items[0].item.id, id);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).plans[0].done, true);
  run(['rm', id]);
  assert.equal(run(['ls', '--all']).value.items.length, 0);
});

test('Concurrent CLI additions preserve every record', async t => {
  const { file, run } = await setup(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--data', file, 'add', `并发任务${index}`, '--json'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `CLI exit code ${code}`)));
  })));
  const items = run(['ls']).value.items;
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map(({ item }) => item.text)).size, 8);
});

test('CLI edit/flag/undo/tags uses the data layer, not separate state', async (t) => {
  const { run } = await setup(t);
  const { item } = run(['add', '准备材料', '--hours', '2', '--tag', '旧标签']).value;
  const edited = run(['edit', item.id, '--text', '准备新材料', '--date', '2027', '--tag', '学校-项目', '--actual-hours', '0']).value;
  assert.equal(edited.item.actualHours, 0);
  assert.deepEqual(edited.item.tags, ['学校-项目']);
  assert.equal(run(['tags']).value.tags[0].tag, '学校-项目');
  run(['flag', item.id]);
  assert.equal(run(['ls', '--view', 'flagged']).value.items.length, 1);
  run(['flag', item.id, '--off']);
  assert.equal(run(['ls', '--view', 'flagged']).value.items.length, 0);
  run(['done', item.id]);
  run(['undo', item.id]);
  assert.equal(run(['ls']).value.items[0].item.done, false);
  assert.equal(run(['edit', item.id, '--actual-hours', 'unknown', '--tags', '']).value.item.actualHours, undefined);
});

test('CLI plan view sorts padded dates, mixed precisions keep file order', async (t) => {
  const data = initial();
  data.plans = [
    { id: 'later', text: '后一小时', date: '2027-01-01 01:00', tags: [] },
    { id: 'day', text: '日粒度', date: '2027-01-01', tags: [] },
    { id: 'year', text: '年粒度', date: '2027', tags: [] },
    { id: 'hour', text: '小时粒度', date: '2027-01-01 00:00', tags: [] },
    { id: 'month', text: '月粒度', date: '2027-01', tags: [] },
  ];
  const { run } = await setup(t, data);
  assert.deepEqual(run(['ls', '--view', 'scheduled']).value.items.map(({ item }) => item.id), ['day', 'year', 'hour', 'month', 'later']);
});

test('CLI routine templates cannot be completed; record logs runs analyzed by stats with the same rules', async (t) => {
  const { run } = await setup(t);
  const { item } = run(['add', '周回顾', '--recurring', '--hours', '2', '--tag', '每周', '--tag', '产品']).value;
  run(['done', item.id], { success: false });
  run(['record', item.id, '--actual-hours', '3', '--completed-at', '2026-11-11 19:30:00']);
  const stats = run(['stats', '--period', 'week', '--anchor', '2026-11-11']).value;
  assert.equal(stats.total.actualHours, 3);
  assert.equal(stats.total.estHours, 2);
  assert.equal(stats.taskRows[0].count, 1);
  assert.equal(stats.trendRows[0].recurringId, item.id);
  assert.equal(stats.tagRows.reduce((sum, row) => sum + row.share, 0), 1);
  assert.equal(run(['ls', '--view', 'routine']).value.items[0].item.done, undefined);
  assert.match(run(['stats', '--anchor', '2026-11-11'], { json: false }).stdout, /周回顾/);
});

test('duplicate IDs reject ambiguous ops; explicit ref touches one; stale revision fails', async (t) => {
  const data = initial();
  data.history = [{ id: 'h22', text: '第一条', tags: [] }, { id: 'h22', text: '第二条', tags: [] }];
  const { run } = await setup(t, data);
  run(['rm', 'h22'], { success: false });
  const listing = run(['ls', '--view', 'completed']).value;
  run(['flag', 'history:1', '--revision', listing.revision]);
  run(['rm', 'history:0', '--revision', listing.revision], { success: false });
  run(['rm', 'history:0']);
  const remaining = run(['ls', '--view', 'completed']).value.items;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].item.text, '第二条');
});

test('CLI import overwrites only on explicit replace and keeps backup', async (t) => {
  const { run, dir, file } = await setup(t);
  const source = join(dir, 'source.json');
  const data = initial();
  data.pool = [{ id: 'imported', text: '导入任务', tags: [], custom: '保留' }];
  await writeFile(source, JSON.stringify(data));
  run(['import', source], { success: false });
  run(['import', source, '--replace']);
  assert.equal(run(['ls']).value.items[0].item.custom, '保留');
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')), initial());
});

test('invalid CLI args return nonzero without touching data', async (t) => {
  const { run, file } = await setup(t);
  const before = await readFile(file, 'utf8');
  run(['add', '错误', '--date', '2026-02-30'], { success: false });
  run(['add', '错误', '--actual-hours', '-1'], { success: false });
  run(['stats', '--period', 'year'], { success: false });
  run(['add', '错误', '--unknown'], { success: false });
  assert.equal(await readFile(file, 'utf8'), before);
  assert.match(run(['help'], { json: false }).stdout, /record/);
});

test('npm bin style symlink reaches the CLI', async (t) => {
  const { dir } = await setup(t);
  const bin = join(dir, 'reminder');
  await symlink(cli, bin);
  const result = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /personal reminders and task management/);
});
