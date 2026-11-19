/** Analyze completed execution records; recurring templates are excluded. */
import { entries, isDone } from './store.js';

const DAY = 86_400_000;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const rounded = (value) => Math.round((value + Number.EPSILON) * 1e9) / 1e9;
const dateString = (date) => date.toISOString().slice(0, 10);

function invalid(message) {
  const error = new Error(message);
  error.status = error.statusCode = 400;
  error.code = 'INVALID_STATS_OPTIONS';
  return error;
}

function civilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && dateString(date) === value ? date : null;
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function periodStart(date, period) {
  const result = new Date(date);
  if (period === 'week') result.setUTCDate(result.getUTCDate() - (result.getUTCDay() + 6) % 7);
  else result.setUTCDate(1);
  return result;
}

function shiftPeriod(date, amount, period) {
  const result = new Date(date);
  if (period === 'week') result.setUTCDate(result.getUTCDate() + amount * 7);
  else result.setUTCMonth(result.getUTCMonth() + amount);
  return result;
}

function completedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(value)) return null;
  const date = civilDate(value.slice(0, 10));
  if (!date) return null;
  if (value.length > 10) {
    const [hours, minutes, seconds = '0'] = value.slice(11).split(':');
    if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  }
  return date;
}

function accumulator(base = {}) {
  return { ...base, estHours: 0, actualHours: 0, deltaHours: 0, count: 0, missingEstHours: 0 };
}

function addHours(row, item, factor = 1) {
  row.estHours += (number(item.estHours) ? item.estHours : 0) * factor;
  row.actualHours += item.actualHours * factor;
  row.count++;
  if (!number(item.estHours)) row.missingEstHours++;
}

function finish(row) {
  return {
    ...row,
    estHours: rounded(row.estHours),
    actualHours: rounded(row.actualHours),
    deltaHours: rounded(row.actualHours - row.estHours),
  };
}

/**
 * Weeks start on Monday and months follow the calendar; civil date arithmetic avoids timezone shifts.
 * share is a 0..1 proportion. Records split hours equally across tags; count tracks records per tag.
 */
export function computeStats(data, { period = 'week', anchor = localToday() } = {}) {
  if (!['week', 'month'].includes(period)) throw invalid('Statistics period must be week or month');
  const selected = civilDate(anchor);
  if (!selected) throw invalid('Statistics anchor must be a valid YYYY-MM-DD');
  const startDate = periodStart(selected, period);
  const nextDate = shiftPeriod(startDate, 1, period);
  const bucketCount = period === 'week' ? 8 : 6;
  const trendStart = shiftPeriod(startDate, 1 - bucketCount, period);
  const buckets = Array.from({ length: bucketCount }, (_, index) => dateString(shiftPeriod(trendStart, index, period)));
  const all = entries(data).filter(({ collection }) => collection !== 'recurring');
  const idCounts = new Map();
  for (const { item } of all) idCounts.set(item.id, (idCounts.get(item.id) || 0) + 1);
  const templates = new Map((data.recurring || []).map((item) => [item.id, item]));
  const taskRows = new Map(), tagRows = new Map(), trendRows = new Map();
  const total = accumulator();
  const excluded = { missingActualHours: 0, missingCompletedAt: 0, outsidePeriod: 0, notCompleted: 0, missingEstHours: 0 };

  for (const { item, collection, ref } of all) {
    if (!isDone(item, collection)) { excluded.notCompleted++; continue; }
    if (!number(item.actualHours)) { excluded.missingActualHours++; continue; }
    const completed = completedDate(item.completedAt);
    if (!completed) { excluded.missingCompletedAt++; continue; }
    const recurringId = item.sourceRecurringId;
    if (typeof recurringId === 'string' && recurringId && completed >= trendStart && completed < nextDate) {
      const bucket = dateString(periodStart(completed, period));
      const key = JSON.stringify([recurringId, bucket]);
      if (!trendRows.has(key)) trendRows.set(key, accumulator({ recurringId, text: templates.get(recurringId)?.text || item.text, periodStart: bucket }));
      addHours(trendRows.get(key), item);
    }
    if (completed < startDate || completed >= nextDate) { excluded.outsidePeriod++; continue; }

    addHours(total, item);
    if (!number(item.estHours)) excluded.missingEstHours++;
    const taskKey = recurringId ? `recurring:${recurringId}` : idCounts.get(item.id) > 1 ? `ref:${ref}` : `item:${item.id}`;
    if (!taskRows.has(taskKey)) taskRows.set(taskKey, accumulator({ key: taskKey, text: templates.get(recurringId)?.text || item.text }));
    addHours(taskRows.get(taskKey), item);
    const tags = [...new Set((item.tags || []).filter((tag) => typeof tag === 'string' && tag.trim()))];
    if (!tags.length) tags.push('Untagged');
    for (const tag of tags) {
      if (!tagRows.has(tag)) tagRows.set(tag, accumulator({ tag }));
      addHours(tagRows.get(tag), item, 1 / tags.length);
    }
  }

  const byHours = (left, right) => right.actualHours - left.actualHours;
  return {
    period, anchor, start: dateString(startDate), end: dateString(new Date(nextDate.getTime() - DAY)),
    total: finish(total),
    taskRows: [...taskRows.values()].map(finish).sort(byHours),
    tagRows: [...tagRows.values()].map((row) => ({ ...finish(row), share: total.actualHours ? row.actualHours / total.actualHours : 0 })).sort(byHours),
    trendRows: [...trendRows.values()].map(finish).sort((left, right) => left.periodStart.localeCompare(right.periodStart) || left.recurringId.localeCompare(right.recurringId)),
    excluded,
    trendRange: { start: dateString(trendStart), end: dateString(new Date(nextDate.getTime() - DAY)), buckets },
  };
}

function plain(value) { return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function hours(value) { return Number(value.toFixed(3)).toString(); }

/** Web and CLI share the same statistics; CLI only formats the results. */
export function formatStats(stats) {
  const lines = [
    `Time analysis (${stats.period === 'week' ? 'week' : 'month'}): ${stats.start} to ${stats.end}`,
    stats.total.count
      ? `${stats.total.count} executions recorded; estimated ${hours(stats.total.estHours)}h; actual ${hours(stats.total.actualHours)}h; difference ${hours(stats.total.deltaHours)}h`
      : '0 executions recorded; actual hours are unknown and do not imply zero time spent.',
    'Scope: completed records with known actual hours; hours are split equally across tags.',
  ];
  if (stats.excluded.missingEstHours) lines.push(`Note: ${stats.excluded.missingEstHours} records have missing estimated hours; differences use an estimate of 0h.`);
  lines.push('', 'By task (estimated / actual / difference, hours)');
  if (!stats.taskRows.length) lines.push('No recorded actual hours');
  for (const row of stats.taskRows) lines.push(`${plain(row.text)} [${row.key}]: ${hours(row.estHours)} / ${hours(row.actualHours)} / ${hours(row.deltaHours)} (${row.count} executions${row.missingEstHours ? ', includes missing estimated hours' : ''})`);
  lines.push('', 'By tag (estimated / actual / share)');
  if (!stats.tagRows.length) lines.push('No tag hours recorded');
  for (const row of stats.tagRows) lines.push(`${row.tag}: ${hours(row.estHours)}h / ${hours(row.actualHours)}h / ${(row.share * 100).toFixed(1)}%`);
  lines.push('', `Recurring trends (last ${stats.trendRange.buckets.length} ${stats.period === 'week' ? 'weeks' : 'months'}, ${stats.trendRange.start} to ${stats.trendRange.end})`);
  if (!stats.trendRows.length) lines.push('No recurring executions recorded; missing periods are not treated as 0 hours');
  for (const row of stats.trendRows) lines.push(`${row.periodStart} ${plain(row.text)} [${row.recurringId}]: estimated ${hours(row.estHours)}h / actual ${hours(row.actualHours)}h (${row.count} executions)`);
  lines.push('', `Excluded from current totals: not completed ${stats.excluded.notCompleted}; missing actual hours ${stats.excluded.missingActualHours}; missing valid completion time ${stats.excluded.missingCompletedAt}; outside selected period ${stats.excluded.outsidePeriod}.`);
  return lines.join('\n');
}
