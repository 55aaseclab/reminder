import test from 'node:test';
import assert from 'node:assert/strict';
import { entries, localDate, packWeek, scheduleGroups, selectView, viewCounts } from '../public/views.js';

const data = {
  recurring: [{ id: 'r1', text: '模板', tags: ['每月'], estHours: 10, flagged: true }],
  plans: [
    { id: 'hour', text: '小时', date: '2026-11-11 19:00' },
    { id: 'year', text: '年', date: '2027' },
    { id: 'done', text: '完成', date: '2026-11-11', done: true, completedAt: '2026-11-11 01:00:00' },
    { id: 'month', text: '月', date: '2026-11' },
  ],
  pool: [{ id: 'pool', text: '池中有日期', date: '2026-11-11' }],
  history: [
    { id: 'dup', text: '旧历史' },
    { id: 'dup', text: '最近完成', completedAt: '2026-11-11 02:00:00' },
    { id: 'restored', text: '恢复历史', done: false },
  ],
};

test('all view lists items in file order; history defaults done, explicit false restores', () => {
  assert.deepEqual(selectView(data, 'all').map((item) => item.id), ['hour', 'year', 'month', 'pool', 'restored']);
  assert.equal(entries(data).length, 9);
  assert.deepEqual(selectView(data, 'completed').map((item) => item.text), ['最近完成', '完成', '旧历史']);
  assert.deepEqual(selectView(data, 'completed').map((item) => item.ref), ['history:1', 'plans:2', 'history:0']);
});

test('today includes hour and day precision, covers pool, counts match display', () => {
  const today = '2026-11-11';
  assert.deepEqual(selectView(data, 'today', today).map((item) => item.id), ['hour', 'pool']);
  for (const [view, count] of Object.entries(viewCounts(data, today))) assert.equal(selectView(data, view, today).length, count);
  assert.equal(localDate(new Date(2026, 10, 11, 23, 59)), today);
});

test('plan view includes all dated uncompleted items, sorted with date-granularity groups', () => {
  const scheduled = selectView(data, 'scheduled');
  assert.deepEqual(scheduled.map((item) => item.id), ['month', 'pool', 'hour', 'year']);
  assert.deepEqual(scheduleGroups(scheduled).map((group) => [group.date, group.rows.length]), [['2026-11', 1], ['2026-11-11', 2], ['2027', 1]]);
});

test('flagged includes templates marked recur, routine stays non-checkable', () => {
  const flagged = selectView(data, 'flagged');
  assert.equal(flagged[0].recur, true);
  assert.equal(flagged[0].done, false);
  assert.equal(selectView(data, 'routine').length, 1);
});

test('week calendar packs file order across days, fixed pixel ratio, no frequency conversion', () => {
  const packed = packWeek([{ id: 'a', tags: ['每月'], estHours: 10 }, { id: 'b', tags: ['每周'], estHours: 8.5 }]);
  assert.equal(packed.days.length, 6);
  assert.deepEqual(packed.days.slice(0, 3).map((day) => day.map(({ item, hours }) => [item.id, hours])), [[['a', 9]], [['a', 1], ['b', 8]], [['b', .5]]]);
  assert.equal(packed.days[2][0].heightRem, .6);
  assert.equal(packed.totalHours, 18.5);
  assert.equal(packed.overflowHours, 0);
});

test('over 54h returns explicit overflow, default estimate 1h, input data unchanged', () => {
  const rows = [{ id: 'a', estHours: 54 }, { id: 'b' }];
  const before = structuredClone(rows);
  const packed = packWeek(rows);
  assert.equal(packed.overflowHours, 1);
  assert.equal(packed.days.flat().reduce((sum, block) => sum + block.hours, 0), 54);
  assert.deepEqual(rows, before);
});
