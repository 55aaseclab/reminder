import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, formatStats } from '../src/stats.js';

const empty = () => ({ version: 2, recurring: [], plans: [], pool: [], history: [] });
const completed = (id, completedAt, actualHours, estHours = 1, tags = []) => ({ id, text: id, completedAt, actualHours, estHours, tags });

test('week stats start Monday, include known zeros, exclude unknown/uncompleted/out-of-period', () => {
  const data = empty();
  data.history = [
    completed('mon', '2026-11-09 00:00:00', 2, 1),
    completed('sun', '2026-11-15 23:59:59', 0, 2),
    completed('next', '2026-11-16 00:00:00', 3),
    completed('previous', '2026-11-08', 3),
    completed('unknown', '2026-11-10', null),
    { id: 'legacy', text: '旧记录', actualHours: 2 },
    completed('bad-date', '2026-02-30', 2),
    { ...completed('restored', '2026-11-11', 99), done: false },
  ];
  data.plans = [{ ...completed('pending', '2026-11-11', 100), done: false }];
  data.recurring = [{ id: 'template', text: '模板不计', estHours: 400, actualHours: 500, done: true }];
  const stats = computeStats(data, { period: 'week', anchor: '2026-11-11' });
  assert.equal(stats.start, '2026-11-09');
  assert.equal(stats.end, '2026-11-15');
  assert.deepEqual(stats.total, { estHours: 3, actualHours: 2, deltaHours: -1, count: 2, missingEstHours: 0 });
  assert.deepEqual(stats.excluded, { missingActualHours: 1, missingCompletedAt: 2, outsidePeriod: 2, notCompleted: 2, missingEstHours: 0 });
  assert.equal(stats.taskRows.length, 2);
  assert.equal(stats.tagRows[0].tag, 'Untagged');
  assert.equal(stats.tagRows[0].share, 1);
});

test('calendar month and leap-day boundaries independent of UTC or machine timezone', () => {
  const data = empty();
  data.history = [completed('leap', '2024-02-29 12:00:00', 2), completed('next', '2024-03-01', 3), completed('old', '2024-01-31', 9)];
  const stats = computeStats(data, { period: 'month', anchor: '2024-02-29' });
  assert.equal(stats.start, '2024-02-01');
  assert.equal(stats.end, '2024-02-29');
  assert.equal(stats.total.actualHours, 2);
  assert.throws(() => computeStats(data, { anchor: '2026-02-29' }), /YYYY-MM-DD/);
  assert.throws(() => computeStats(data, { period: 'year' }), /week/);
});

test('multi-tag splits estimated/actual hours, dedupes tags without double counting', () => {
  const data = empty();
  data.history = [completed('a', '2026-11-11', 6, 3, ['项目', '个人', '项目']), completed('b', '2026-11-11', 2, 1, ['项目'])];
  const stats = computeStats(data, { anchor: '2026-11-11' });
  const project = stats.tagRows.find((row) => row.tag === '项目');
  const personal = stats.tagRows.find((row) => row.tag === '个人');
  assert.equal(project.actualHours, 5);
  assert.equal(project.estHours, 2.5);
  assert.equal(project.count, 2);
  assert.equal(personal.actualHours, 3);
  assert.equal(stats.tagRows.reduce((sum, row) => sum + row.actualHours, 0), stats.total.actualHours);
  assert.equal(stats.tagRows.reduce((sum, row) => sum + row.share, 0), 1);
});

test('duplicate legacy IDs stay separate; unknown estimates disclosed; zero actual counts a run', () => {
  const data = empty();
  data.history = [completed('duplicate', '2026-11-11', 0), completed('duplicate', '2026-11-11', 2)];
  delete data.history[1].estHours;
  const stats = computeStats(data, { anchor: '2026-11-11' });
  assert.equal(stats.taskRows.length, 2);
  assert.deepEqual(new Set(stats.taskRows.map((row) => row.key)), new Set(['ref:history:0', 'ref:history:1']));
  assert.equal(stats.excluded.missingEstHours, 1);
  assert.equal(stats.total.actualHours, 2);
  assert.equal(stats.total.count, 2);
  assert.match(formatStats(stats), /missing estimated hours/);
});

test('routine runs merge by template, show 8-week trend, missing weeks not treated as zero', () => {
  const data = empty();
  data.recurring = [{ id: 'weekly', text: '写周报', tags: ['每周'], estHours: 2 }];
  data.history = [
    { ...completed('r1', '2026-11-09', 1, 2), sourceRecurringId: 'weekly' },
    { ...completed('r2', '2026-11-12', 3, 2), sourceRecurringId: 'weekly' },
    { ...completed('r3', '2026-11-02', 2.5, 2), sourceRecurringId: 'weekly' },
    { ...completed('r4', '2026-09-01', 8, 2), sourceRecurringId: 'weekly' },
  ];
  const stats = computeStats(data, { anchor: '2026-11-11' });
  assert.equal(stats.taskRows.length, 1);
  assert.equal(stats.taskRows[0].text, '写周报');
  assert.equal(stats.taskRows[0].actualHours, 4);
  assert.equal(stats.taskRows[0].count, 2);
  assert.equal(stats.trendRange.buckets.length, 8);
  assert.equal(stats.trendRange.start, '2026-09-21');
  assert.equal(stats.trendRows.length, 2);
  assert.equal(stats.trendRows[0].periodStart, '2026-11-02');
  assert.equal(stats.trendRows[1].actualHours, 4);
  const monthly = computeStats(data, { anchor: '2026-11-11', period: 'month' });
  assert.equal(monthly.trendRange.buckets.length, 6);
  assert.equal(monthly.trendRange.start, '2026-06-01');
  assert.equal(monthly.trendRows.length, 2);
});

test('empty data yields explainable text and zero aggregates', () => {
  const stats = computeStats(empty(), { anchor: '2026-11-11' });
  assert.equal(stats.total.actualHours, 0);
  assert.deepEqual(stats.tagRows, []);
  assert.match(formatStats(stats), /No recorded actual hours/);
  assert.match(formatStats(stats), /missing periods are not treated as 0/);
});
