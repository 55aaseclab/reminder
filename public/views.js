export const CARDS = [
  { id: 'routine', name: '例行', color: '#30b85a', icon: '↻' },
  { id: 'today', name: '今天', color: '#0a84ff', icon: '日' },
  { id: 'scheduled', name: '计划', color: '#ed5148', icon: '月' },
  { id: 'all', name: '全部', color: '#62626a', icon: '☷' },
  { id: 'flagged', name: '旗标', color: '#e69019', icon: '⚑' },
  { id: 'completed', name: '已完成', color: '#8e8e93', icon: '✓' },
];

export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ref 只用于当前 revision；写入时必须连同 revision 提交。
export function entries(data) {
  return ['recurring', 'plans', 'pool', 'history'].flatMap((collection) =>
    (data[collection] || []).map((item, index) => ({
      ...item,
      collection,
      ref: `${collection}:${index}`,
      recur: collection === 'recurring',
      done: collection === 'recurring' ? false : (item.done ?? collection === 'history'),
    })));
}

export function dateKey(date) {
  if (date.length === 4) return `${date}-01-01 00:00`;
  if (date.length === 7) return `${date}-01 00:00`;
  if (date.length === 10) return `${date} 00:00`;
  return date;
}

export function selectView(data, view, today = localDate()) {
  const all = entries(data);
  const active = all.filter((item) => !item.recur && !item.done);
  switch (view) {
    case 'routine': return all.filter((item) => item.recur);
    case 'today': return active.filter((item) => item.date?.slice(0, 10) === today);
    case 'scheduled': return active.filter((item) => item.date).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    case 'flagged': return all.filter((item) => item.flagged);
    case 'completed': return all.filter((item) => !item.recur && item.done)
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    default: return active;
  }
}

export function viewCounts(data, today = localDate()) {
  return Object.fromEntries(CARDS.map(({ id }) => [id, selectView(data, id, today).length]));
}

export function scheduleGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const date = item.date.slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  return [...groups].map(([date, rows]) => ({ date, rows }));
}

export function packWeek(items) {
  const days = Array.from({ length: 6 }, () => []);
  let day = 0, used = 0, overflowHours = 0, totalHours = 0;
  for (const item of items) {
    let remaining = item.estHours == null ? 1 : item.estHours;
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    totalHours += remaining;
    while (remaining > 1e-9 && day < 6) {
      const hours = Math.min(remaining, 9 - used);
      days[day].push({ item, hours, heightRem: hours * 1.2 });
      remaining -= hours;
      used += hours;
      if (used >= 9 - 1e-9) { day += 1; used = 0; }
    }
    overflowHours += remaining;
  }
  return { days, totalHours, overflowHours };
}
