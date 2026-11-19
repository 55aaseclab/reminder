import { t } from './i18n.js';
import { CARDS, localDate, packWeek, scheduleGroups, selectView, viewCounts } from './views.js';

const $ = (selector) => document.querySelector(selector);
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};
let snapshot, busy = false, refreshing = false, epoch = 0, statsEpoch = 0;
let page = 'tasks', view = 'routine';
try {
  const saved = localStorage.getItem('reminder-view-v1');
  if (CARDS.some((card) => card.id === saved)) view = saved;
} catch { /* 浏览器禁止存储时仍可使用。 */ }

// 原始内容保留在 JSON；展示只允许现有数据使用的少量富文本。
const viewNames = { routine: 'Routines', today: 'Today', scheduled: 'Scheduled', all: 'All', flagged: 'Flagged', completed: 'Completed' };
function viewName(card) { return t(viewNames[card.id], card.name); }

function richText(text) {
  const template = document.createElement('template');
  template.innerHTML = String(text || '');
  const result = document.createDocumentFragment();
  const allowed = new Set(['A', 'U', 'STRONG', 'B', 'EM', 'BR']);
  const blocked = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH']);
  function copy(node, target) {
    if (node.nodeType === Node.TEXT_NODE) { target.append(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || blocked.has(node.tagName)) return;
    const next = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : target;
    if (node.tagName === 'A') {
      try {
        const url = new URL(node.getAttribute('href') || '', location.href);
        if (['http:', 'https:'].includes(url.protocol)) {
          next.href = url.href;
          next.target = '_blank';
          next.rel = 'noopener noreferrer';
        }
      } catch { /* 非法链接仅显示内容。 */ }
    }
    for (const child of node.childNodes) copy(child, next);
    if (next !== target) target.append(next);
  }
  for (const child of template.content.childNodes) copy(child, result);
  return result;
}

function plainText(text) {
  const holder = make('div');
  holder.append(richText(text));
  return holder.textContent;
}

async function api(path, { method = 'GET', payload, revision } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {};
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (revision) headers['If-Match'] = revision;
    const response = await fetch(`./api/${path}`, {
      method, headers, cache: 'no-store', signal: controller.signal,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || t(`Request failed (${response.status})`, `操作失败（${response.status}）`));
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(t("The request timed out. Try again later.", '请求超时，请稍后重试'));
    throw error;
  } finally { clearTimeout(timeout); }
}

function notice(text, error = false) {
  $('#notice').textContent = text;
  $('#notice').classList.toggle('error', error);
}

function controls() {
  document.querySelectorAll('[data-mutation]').forEach((element) => { element.disabled = busy || !snapshot; });
}

function row(item) {
  const element = make('article', `item${item.done ? ' done' : ''}`);
  element.dataset.ref = item.ref;
  const text = make('div', 'item-text');
  const content = make('div', 'content');
  content.append(richText(item.text));
  if (item.notes) content.append(make('div', 'note', item.notes));
  text.append(content);
  if (item.done) text.append(make('div', 'completed-time', t(`Completed: ${item.completedAt || '—'}`, `完成时间：${item.completedAt || '—'}`)));
  const meta = make('div', 'meta');
  if (item.date) meta.append(make('span', 'badge', item.date));
  if (item.location) meta.append(make('span', 'badge location', `📍${item.location}`));
  if (item.estHours != null) meta.append(make('span', 'badge', t(`Estimate ${item.estHours}h`, `预期 ${item.estHours}h`)));
  if (!item.recur && item.actualHours != null) meta.append(make('span', 'badge', t(`Actual ${item.actualHours}h`, `实际 ${item.actualHours}h`)));
  for (const tag of item.tags || []) meta.append(make('span', 'badge', `#${tag}`));
  text.append(meta);
  element.append(text);
  const actions = make('div', 'row-actions');
  const flag = make('button', 'flag', '⚑');
  flag.type = 'button'; flag.dataset.mutation = '';
  flag.title = item.flagged ? t("Remove flag", '取消旗标') : t("Flag task", '添加旗标');
  flag.setAttribute('aria-label', `${flag.title}：${plainText(item.text)}`);
  flag.setAttribute('aria-pressed', String(!!item.flagged));
  flag.addEventListener('click', () => mutate(`items/${encodeURIComponent(item.ref)}`, { flagged: !item.flagged }));
  actions.append(flag);
  element.append(actions);
  return element;
}

function calendar(items) {
  const { days, overflowHours } = packWeek(items);
  const wrapper = make('div', 'week');
  const grid = make('div', 'week-grid');
  for (const [index, blocks] of days.entries()) {
    const day = make('div', 'day');
    day.append(make('div', 'day-heading', t(`Day ${index + 1}`, `日${index + 1}`)));
    const body = make('div', 'day-body');
    for (const { item, hours, heightRem } of blocks) {
      const tags = item.tags || [];
      const category = ['协调', '培养', '项目', '规划'].findIndex((part) => tags.some((tag) => tag.includes(part)));
      const block = make('div', `week-item c${category < 0 ? 5 : category + 1}`, plainText(item.text));
      block.style.height = `${heightRem}rem`;
      block.title = `${plainText(item.text)} · ${Number(hours.toFixed(4))}h`;
      body.append(block);
    }
    day.append(body); grid.append(day);
  }
  wrapper.append(grid);
  if (overflowHours > 1e-9) wrapper.append(make('p', 'overflow-note', t(`Weekly capacity exceeded by ${Number(overflowHours.toFixed(4))}h. All routines appear in the list below.`, `超出周日历容量 ${Number(overflowHours.toFixed(4))}h；下方列表保留全部例行条目。`)));
  return wrapper;
}

function renderTasks() {
  if (!snapshot) return;
  const y = window.scrollY;
  const counts = viewCounts(snapshot.data);
  const focusedView = $('#cards').contains(document.activeElement) && document.activeElement.dataset.view;
  $('#cards').replaceChildren(...CARDS.map((card) => {
    const button = make('button', `card${view === card.id && page === 'tasks' ? ' on' : ''}`);
    button.type = 'button'; button.dataset.view = card.id;
    if (view === card.id && page === 'tasks') button.setAttribute('aria-current', 'page');
    const dot = make('span', 'dot', card.id === 'today' ? t('D', card.icon) : card.id === 'scheduled' ? t('M', card.icon) : card.icon); dot.style.background = card.color;
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot, document.createTextNode(viewName(card)), make('span', 'n', counts[card.id]));
    button.addEventListener('click', () => {
      view = card.id;
      try { localStorage.setItem('reminder-view-v1', view); } catch { /* 偏好保存非必要。 */ }
      showPage('tasks');
    });
    return button;
  }));
  if (focusedView) $('#cards').querySelector(`[data-view="${CSS.escape(focusedView)}"]`)?.focus({ preventScroll: true });
  const items = selectView(snapshot.data, view);
  $('#view-title').textContent = viewName(CARDS.find((card) => card.id === view));
  const content = $('#task-content');
  content.replaceChildren();
  if (view === 'routine') content.append(calendar(items));
  if (!items.length) content.append(make('div', 'empty', ({ routine: t("No routines yet", '还没有例行模板'), today: t("Nothing scheduled today", '今天没有安排'), scheduled: t("No dated tasks", '没有带日期的待办'), all: t("No open tasks", '没有未完成任务'), flagged: t("No flagged items", '没有旗标条目'), completed: t("No completed items yet", '还没有已完成记录') })[view]));
  else if (view === 'scheduled') {
    for (const group of scheduleGroups(items)) {
      content.append(make('h2', 'group-title', group.date), ...group.rows.map(row));
    }
  } else content.append(...items.map(row));
  controls();
  window.scrollTo(0, y);
}

function showPage(next) {
  page = next;
  $('#tasks-page').hidden = next !== 'tasks';
  $('#stats-page').hidden = next !== 'stats';
  document.querySelectorAll('[data-page]').forEach((button) => {
    if (button.dataset.page === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  renderTasks();
  if (next === 'stats') loadStats();
}

async function refreshData({ force = false } = {}) {
  if ((refreshing || busy) && !force) return;
  refreshing = true;
  const version = epoch;
  try {
    const fresh = await api('data');
    if (version !== epoch) return;
    const changed = fresh.revision !== snapshot?.revision;
    snapshot = fresh;
    $('#network-error').hidden = true;
    $('#sync-status').textContent = t(`Last loaded ${new Date().toLocaleTimeString('en')}`, `最近读取 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    if (changed) {
      renderTasks();
      if (page === 'stats') loadStats();
    }
  } catch (error) {
    $('#network-error span').textContent = t(`Couldn’t load data: ${error.message}`, `数据读取失败：${error.message}`);
    $('#network-error').hidden = false;
    if (!snapshot) $('#task-content').textContent = t("Couldn’t load tasks. Try again.", '暂时无法读取任务，请重试。');
  } finally { refreshing = false; controls(); }
}

async function mutate(path, payload, revision = snapshot?.revision) {
  if (busy || !snapshot) return false;
  busy = true; epoch += 1; controls();
  try {
    const fresh = await api(path, { method: 'PATCH', payload, revision });
    snapshot = fresh;
    renderTasks();
    if (page === 'stats') loadStats();
    notice(t("Saved", '已保存'));
    return true;
  } catch (error) {
    const message = error.status === 409 ? t("The data changed. Review the refreshed list and try again.", '数据已变化，列表已重新读取。请核对后重试。') : error.message;
    notice(message, true);
    if (error.status === 409) {
      await refreshData({ force: true });
    }
    return false;
  } finally { busy = false; controls(); }
}

function number(value) { return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(2))) : '—'; }

function statsTable(title, rows, columns) {
  const section = make('section', 'stats-section');
  section.append(make('h2', '', title));
  if (!rows.length) { section.append(make('p', 'empty', t("No records for this period", '此范围暂无可统计记录'))); return section; }
  const table = make('table'), head = make('thead'), header = make('tr');
  for (const [label] of columns) header.append(make('th', '', label));
  head.append(header); table.append(head);
  const body = make('tbody');
  for (const item of rows) {
    const tr = make('tr');
    for (const [, field, format] of columns) {
      const cell = make('td', format ? 'num' : '', format ? format(item[field]) : plainText(item[field] ?? '—'));
      if (field === 'text' && item.missingEstHours > 0) cell.append(make('small', 'missing-est', t("Some estimates are missing", '含缺失预期')));
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);
  const scroll = make('div', 'table-scroll'); scroll.append(table); section.append(scroll);
  return section;
}

async function loadStats() {
  const version = ++statsEpoch;
  const period = $('#stats-period').value, anchor = $('#stats-anchor').value || localDate();
  $('#stats-content').textContent = t("Loading statistics…", '正在读取统计…');
  try {
    const result = await api(`stats?period=${encodeURIComponent(period)}&anchor=${encodeURIComponent(anchor)}`);
    if (version !== statsEpoch) return;
    const content = $('#stats-content'); content.replaceChildren();
    content.append(make('p', 'stats-note', t(`${result.start} to ${result.end} · Grouped by completion time. Hours are divided equally among tags.`, `${result.start} 至 ${result.end} · 按完成时间归入周期，标签工时等分。`)));
    const summary = make('div', 'stats-summary');
    const recordedHours = value => result.total.count ? `${number(value)}h` : '—';
    for (const [label, value] of [[t("Records", '记录'), t(`${result.total.count}`, `${result.total.count}条`)], [t("Estimated", '预期'), recordedHours(result.total.estHours)], [t("Actual", '实际'), recordedHours(result.total.actualHours)], [t("Difference (actual − estimate)", '差值（实际−预期）'), recordedHours(result.total.deltaHours)]]) {
      const cell = make('span', '', `${label} `); cell.append(make('strong', '', value)); summary.append(cell);
    }
    content.append(summary);
    if (!result.total.count) content.append(make('p', 'stats-note', t("No actual time has been recorded. Total effort for this period is unknown.", '尚无已记录的实际耗时，不能据此推断本期投入为零。')));
    const excluded = result.excluded || {};
    const labels = { missingActualHours: t("Actual duration unknown", '实际时长未知'), missingCompletedAt: t("Missing or invalid completion time", '完成时间缺失或无效'), outsidePeriod: t("Outside this period", '不在所选周期'), notCompleted: t("Incomplete", '尚未完成') };
    const exclusions = Object.entries(labels).filter(([key]) => excluded[key] > 0).map(([key, label]) => t(`${label}: ${excluded[key]}`, `${label} ${excluded[key]}条`));
    if (exclusions.length) content.append(make('p', 'stats-note', t(`Excluded from this summary: ${exclusions.join('; ')}.`, `未计入当前汇总：${exclusions.join('；')}。`)));
    if (excluded.missingEstHours > 0) content.append(make('p', 'overflow-note', t(`${excluded.missingEstHours} records have no estimate. The difference uses an estimate of zero for those records.`, `${excluded.missingEstHours}条记录缺少预期时长，差值按预期0小时计算。`)));
    const hours = [[t("Estimated (h)", '预期(h)'), 'estHours', number], [t("Actual (h)", '实际(h)'), 'actualHours', number], [t("Difference (h)", '差值(h)'), 'deltaHours', number], [t("Count", '次数'), 'count', number]];
    content.append(statsTable(t("Estimated and actual time by task", '按任务对比预期与实际'), result.taskRows || [], [[t("Task", '任务'), 'text'], ...hours]));
    content.append(statsTable(t("Time by tag", '标签时间分布'), result.tagRows || [], [[t("Tag", '标签'), 'tag'], ...hours, [t("Share of actual time", '实际占比'), 'share', (value) => value == null ? '—' : `${number(value * 100)}%`]]));
    const range = result.trendRange;
    if (range) content.append(make('p', 'stats-note', t(`Routine trends: ${range.start} to ${range.end} (last ${range.buckets.length} ${period === 'week' ? 'weeks' : 'months'}).`, `例行趋势范围：${range.start} 至 ${range.end}（最近${range.buckets.length}${period === 'week' ? '周' : '月'}）。`)));
    content.append(statsTable(t("Routine trends", '例行执行趋势'), result.trendRows || [], [[t("Period start", '周期起始'), 'periodStart'], [t("Routine", '例行任务'), 'text'], ...hours]));
  } catch (error) {
    if (version !== statsEpoch) return;
    $('#stats-content').replaceChildren(make('p', 'form-error', t(`Couldn’t load statistics: ${error.message}`, `统计读取失败：${error.message}`)));
    const retry = make('button', '', t("Retry", '重试')); retry.type = 'button'; retry.addEventListener('click', loadStats); $('#stats-content').append(retry);
  }
}

document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
$('#retry').addEventListener('click', () => refreshData());
$('#stats-anchor').value = localDate();
window.addEventListener('praxis-locale-change', () => { renderTasks(); if (page === 'stats') void loadStats(); });
$('#stats-controls').addEventListener('submit', (event) => { event.preventDefault(); loadStats(); });
window.addEventListener('focus', () => refreshData());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshData(); });
setInterval(() => { if (!document.hidden) refreshData(); }, 3000);
refreshData();
