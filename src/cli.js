#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Store, entries, isDone, COLLECTIONS } from './store.js';
import { computeStats, formatStats } from './stats.js';

const HELP = `reminder: personal reminders and task management (one JSON shared with Web)

Usage: reminder [--data FILE] <COMMAND> [ARGS] [--json]    # available after linking the npm bin

  add TEXT [--date DATE] [--tag TAG ...]      Add a task
      [--recurring --hours HOURS]            Add a recurring template
  ls [--view all|routine|today|scheduled|flagged|completed]
     [--collection recurring|plans|pool|history] [--all]
  done REF [--actual-hours HOURS]            Complete a task
  undo REF                                  Restore a task
  edit REF [--text TEXT] [--date DATE] [--tag TAG ...]
      [--notes NOTES] [--location LOCATION] [--hours HOURS]
      [--actual-hours HOURS|unknown]         Edit fields; unknown clears actual hours
  flag REF [--off]                           Set or clear a flag
  rm REF                                    Delete one record
  tags                                      List tags and record counts
  record RECURRING_REF --actual-hours HOURS [--completed-at "YYYY-MM-DD HH:mm:ss"]
                                            Record an execution, keeping the template
  stats [--period week|month] [--anchor YYYY-MM-DD]
                                            Analyze hours, tag distribution and trends
  import SOURCE [--replace]                  Import v2; back up to .bak before replacing
  help                                      Show help

A reference is a unique id or collection:index from ls (zero-based index).
Indexes may change after deletion; pass the last --revision to reject stale updates.
Dates support YYYY / YYYY-MM / YYYY-MM-DD / "YYYY-MM-DD HH:mm".
Repeat --tag for multiple tags; edit --tags "" clears tags; --notes/--location/--date "" clears fields.
--est-hours is an alias for --hours; REMINDER_DATA selects the shared data file for both entry points.
`;

const OPTIONS = {
  data: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  date: { type: 'string' }, tag: { type: 'string', multiple: true }, tags: { type: 'string' },
  notes: { type: 'string' }, location: { type: 'string' }, text: { type: 'string' },
  hours: { type: 'string' }, 'est-hours': { type: 'string' }, 'actual-hours': { type: 'string' },
  recurring: { type: 'boolean' }, collection: { type: 'string' }, view: { type: 'string' },
  all: { type: 'boolean' }, off: { type: 'boolean' }, replace: { type: 'boolean' },
  'completed-at': { type: 'string' }, period: { type: 'string' }, anchor: { type: 'string' },
  revision: { type: 'string' },
};

function fail(message) { throw new Error(message); }
function numeric(value, label, { positive = false } = {}) {
  const result = Number(value);
  if (value.trim() === '' || !Number.isFinite(result) || (positive ? result <= 0 : result < 0)) fail(`${label} must be a finite number ${positive ? 'greater than' : 'greater than or equal to'} 0`);
  return result;
}

function fields(values) {
  const item = {};
  for (const key of ['text', 'date', 'notes', 'location']) if (values[key] !== undefined) item[key] = values[key];
  if (values.tag !== undefined || values.tags !== undefined) {
    item.tags = [...(values.tag || []), ...(values.tags === undefined || values.tags === '' ? [] : values.tags.split(',').map((tag) => tag.trim()))];
  }
  const est = values['est-hours'] ?? values.hours;
  if (est !== undefined) item.estHours = numeric(est, 'Estimated hours', { positive: true });
  if (values['actual-hours'] !== undefined) item.actualHours = ['清除', 'unknown'].includes(values['actual-hours']) ? null : numeric(values['actual-hours'], 'Actual hours');
  return item;
}

function plain(value) { return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function dateKey(date) {
  return date.length === 4 ? `${date}-01-01 00:00` : date.length === 7 ? `${date}-01 00:00` : date.length === 10 ? `${date} 00:00` : date;
}

function selectedItems(data, values) {
  let items = entries(data);
  if (values.collection) {
    if (!COLLECTIONS.includes(values.collection)) fail('collection must be recurring, plans, pool or history');
    items = items.filter((entry) => entry.collection === values.collection);
  }
  if (values.all || (values.collection && !values.view)) return items;
  const view = values.view || 'all';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const active = (entry) => entry.collection !== 'recurring' && !isDone(entry.item, entry.collection);
  const rules = {
    all: active,
    routine: (entry) => entry.collection === 'recurring',
    today: (entry) => active(entry) && entry.item.date?.slice(0, 10) === today,
    scheduled: (entry) => active(entry) && Boolean(entry.item.date),
    flagged: (entry) => Boolean(entry.item.flagged),
    completed: (entry) => entry.collection !== 'recurring' && isDone(entry.item, entry.collection),
  };
  if (!rules[view]) fail('view must be all, routine, today, scheduled, flagged or completed');
  items = items.filter(rules[view]);
  if (view === 'completed') items.sort((left, right) => (right.item.completedAt || '').localeCompare(left.item.completedAt || ''));
  if (view === 'scheduled') items.sort((left, right) => dateKey(left.item.date).localeCompare(dateKey(right.item.date)));
  return items;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let json = argv.includes('--json');
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    json = Boolean(values.json);
    const [command = 'help', ...args] = positionals;
    if (values.help || command === 'help') { stdout.write(HELP); return 0; }
    if (process.env.REMINDER_MANAGED === '1') fail('Managed Reminder requires the controlled business API; direct data-file CLI operations are disabled');
    const store = new Store(values.data || process.env.REMINDER_DATA);
    const options = values.revision === undefined ? {} : { revision: values.revision };
    let result, message;
    const selector = () => args.length === 1 ? args[0] : fail('This command requires exactly one record reference');
    switch (command) {
      case 'add': {
        const text = args.join(' ') || values.text;
        if (!text) fail('add requires task text');
        const collection = values.recurring ? 'recurring' : values.collection;
        result = await store.add({ ...fields(values), text }, { ...options, ...(collection ? { collection } : {}) });
        message = 'Added'; break;
      }
      case 'ls': {
        if (args.length) fail('ls does not accept positional arguments; use --view or --collection');
        const snapshot = await store.read();
        result = { revision: snapshot.revision, items: selectedItems(snapshot.data, values) };
        if (!json) {
          for (const { ref, collection, item } of result.items) {
            const state = collection === 'recurring' ? 'Template' : isDone(item, collection) ? 'Done' : 'Pending';
            stdout.write(`${ref}\t${item.id}\t[${state}${item.flagged ? ' 🚩' : ''}] ${plain(item.text)}${item.date ? ` · ${item.date}` : ''}${item.tags?.length ? ` · ${item.tags.map((tag) => `#${tag}`).join(' ')}` : ''}\n`);
          }
          if (!result.items.length) stdout.write('No records\n');
          return 0;
        }
        break;
      }
      case 'done':
        result = await store.update(selector(), { ...(values['actual-hours'] !== undefined ? { actualHours: numeric(values['actual-hours'], 'Actual hours') } : {}), done: true }, options);
        message = 'Completed'; break;
      case 'undo': result = await store.update(selector(), { done: false }, options); message = 'Restored'; break;
      case 'edit': {
        const patch = fields(values);
        if (!Object.keys(patch).length) fail('edit requires at least one field to update');
        result = await store.update(selector(), patch, options); message = 'Updated'; break;
      }
      case 'flag': result = await store.update(selector(), { flagged: !values.off }, options); message = values.off ? 'Flag cleared' : 'Flag set'; break;
      case 'rm': result = await store.remove(selector(), options); message = 'Deleted'; break;
      case 'record': {
        if (values['actual-hours'] === undefined) fail('record requires --actual-hours');
        result = await store.record(selector(), numeric(values['actual-hours'], 'Actual hours'), { ...options, ...(values['completed-at'] !== undefined ? { completedAt: values['completed-at'] } : {}) });
        message = 'Recurring execution recorded'; break;
      }
      case 'tags': {
        if (args.length) fail('tags does not accept positional arguments; use edit REF --tag TAG to update tags');
        const snapshot = await store.read(), counts = new Map();
        for (const { item } of entries(snapshot.data)) for (const tag of new Set(item.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1);
        result = { revision: snapshot.revision, tags: [...counts].map(([tag, count]) => ({ tag, count })) };
        if (!json) {
          for (const { tag, count } of result.tags) stdout.write(`${tag}\t${count}\n`);
          if (!result.tags.length) stdout.write('No tags\n');
          return 0;
        }
        break;
      }
      case 'stats': {
        if (args.length) fail('stats does not accept positional arguments; use --period and --anchor');
        const { data } = await store.read();
        result = computeStats(data, { ...(values.period ? { period: values.period } : {}), ...(values.anchor ? { anchor: values.anchor } : {}) });
        if (!json) { stdout.write(`${formatStats(result)}\n`); return 0; }
        break;
      }
      case 'import':
        if (args.length !== 1) fail('import requires one source file path');
        result = await store.importFile(args[0], { replace: Boolean(values.replace) }); message = 'Imported'; break;
      default: fail(`Unknown command: ${command}. Run help for usage.`);
    }
    stdout.write(json ? `${JSON.stringify(result)}\n` : `${message}${result.ref ? ` ${result.ref}` : ''}${result.item ? `: ${plain(result.item.text)}` : ''}\n`);
    return 0;
  } catch (error) {
    stderr.write(json ? `${JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.refs ? { refs: error.refs } : {}) })}\n` : `Error: ${error.message}${error.refs ? ` (available references: ${error.refs.join(', ')})` : ''}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) process.exitCode = await main();
