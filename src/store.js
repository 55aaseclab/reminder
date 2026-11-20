import { isDatabase, readDocument, writeDocument, hasDocument, transaction } from './sqlite-document.mjs';
import { open, readFile, rename, unlink, stat, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { captureBusinessResources, reconcileBusinessResources, validateBusinessMetadata } from './business-metadata.js';

export const COLLECTIONS = ['recurring', 'plans', 'pool', 'history'];
export const DEFAULT_FILE = fileURLToPath(new URL('../data/reminder.db', import.meta.url));
export class ReminderError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message); this.status = status; this.code = code;
  }
}
const fail = (message, status, code) => { throw new ReminderError(message, status, code); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isDone = (item, collection) => item.done ?? (collection === 'history');
export const entries = data => COLLECTIONS.flatMap(collection => data[collection].map((item, index) => ({ collection, index, ref: `${collection}:${index}`, item })));
export function timestamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
export function validDate(value, seconds = false) {
  if (typeof value !== 'string') return false;
  const m = value.match(seconds ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/ : /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?: (\d{2}):(\d{2}))?)?)?$/);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y), month = Number(mo || 1), day = Number(d || 1);
  if (year < 1 || month < 1 || month > 12 || day < 1 || Number(h || 0) > 23 || Number(mi || 0) > 59 || Number(s || 0) > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function validateItem(item) {
  if (!object(item)) fail('Item must be an object');
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) fail('id must be a non-empty string (maximum 200 characters)');
  if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20000) fail('Content is required (maximum 20000 characters)');
  if (!Array.isArray(item.tags) || item.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 200)) fail('tags must be an array of non-empty label strings');
  if (item.date != null && item.date !== '' && !validDate(item.date)) fail('Date must be a valid year, month, day, or YYYY-MM-DD HH:mm');
  for (const k of ['notes', 'location']) if (item[k] != null && (typeof item[k] !== 'string' || item[k].length > 20000)) fail(`${k} must be a string (maximum 20000 characters)`);
  for (const k of ['addedAt', 'completedAt', 'sourceRecurringId']) if (item[k] != null && typeof item[k] !== 'string') fail(`${k} must be a string`);
  for (const k of ['done', 'flagged']) if (item[k] !== undefined && typeof item[k] !== 'boolean') fail(`${k} must be a boolean`);
  if (item.estHours != null && (!Number.isFinite(item.estHours) || item.estHours <= 0 || item.estHours > 100000)) fail('estHours must be positive (maximum 100000 hours)');
  if (item.actualHours != null && (!Number.isFinite(item.actualHours) || item.actualHours < 0 || item.actualHours > 100000)) fail('actualHours must be non-negative (maximum 100000 hours)');
  // Preserve legacy timestamp precision when reading or editing unrelated fields; do not invent historical times.
}
export function validateDocument(data) {
  if (!object(data) || data.version !== 2) fail('Only schema version 2 is supported');
  for (const k of COLLECTIONS) {
    if (!Array.isArray(data[k])) fail(`Missing array ${k}`);
    data[k].forEach(validateItem);
  }
  validateBusinessMetadata(data);
  return data;
}
const digest = raw => createHash('sha256').update(raw).digest('hex');
const mutable = new Set(['text', 'date', 'tags', 'notes', 'location', 'estHours', 'actualHours', 'done', 'flagged', 'completedAt']);
function validateFields(item, adding = false) {
  if (!object(item)) fail('Item or patch must be an object');
  for (const key of Object.keys(item)) if (!mutable.has(key) && !(adding && key === 'id')) fail(`Cannot write field ${key}`);
  if (item.completedAt !== undefined && !validDate(item.completedAt, true)) fail('Completion time must use YYYY-MM-DD HH:mm:ss');
}
function find(data, selector) {
  const all = entries(data);
  const match = /^(recurring|plans|pool|history):(\d+)$/.exec(selector);
  const found = match ? all.filter(e => e.collection === match[1] && e.index === Number(match[2])) : all.filter(e => e.item.id === selector);
  if (!found.length) fail(`Item not found: ${selector}`, 404, 'NOT_FOUND');
  if (found.length > 1) fail(`ID is not unique; use a ref: ${found.map(e => e.ref).join(', ')}`, 409, 'AMBIGUOUS_ID');
  return found[0];
}
export class Store {
  constructor(file = process.env.REMINDER_DATA || DEFAULT_FILE, { spaceId = process.env.REMINDER_SPACE_ID || 'local' } = {}) { this.file = resolve(file); this.spaceId = spaceId; }
  async read() {
    if (isDatabase(this.file)) { if (!hasDocument(this.file, this.spaceId)) fail('Database record not found; use explicit import first', 404, 'NOT_FOUND'); const row = readDocument(this.file, this.spaceId); return { data: validateDocument(row.value), revision: row.revision }; }
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') fail('Data file not found; use import first', 404, 'NOT_FOUND'); throw error; }
    let data;
    try { data = JSON.parse(raw); } catch { fail('Data file contains invalid JSON; nothing was overwritten', 422, 'CORRUPT_DATA'); }
    validateDocument(data);
    return { data, revision: digest(raw) };
  }
  async lock(fn) {
    if (isDatabase(this.file)) return transaction(this.file, fn);
    await mkdir(dirname(this.file), { recursive: true });
    const lockFile = `${this.file}.lock`, deadline = Date.now() + 5000;
    let handle;
    while (!handle) {
      try {
        handle = await open(lockFile, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
      } catch (error) {
        if (error.code !== 'EEXIST') { if (handle) { await handle.close(); await unlink(lockFile).catch(() => {}); } throw error; }
        try {
          const pid = Number(await readFile(lockFile, 'utf8'));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (e) {
              if (e.code === 'ESRCH') fail('Stale lock found; stop all reminder writer processes before removing the configured data lock file', 503, 'STALE_LOCK');
            }
          }
          // Do not reclaim stale locks automatically; concurrent recovery could remove a successor process lock.
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (Date.now() > deadline) fail('Data is being written; try again shortly', 503, 'LOCKED');
        await delay(20);
      }
    }
    try { return await fn(); }
    finally { await handle.close(); await unlink(lockFile).catch(() => {}); }
  }
  async atomicWrite(raw) {
    if (isDatabase(this.file)) { await writeDocument(this.file, this.spaceId, 'state', validateDocument(JSON.parse(raw)), digest(raw), raw); return; }
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
      await rename(tmp, this.file);
    } finally { await handle?.close(); await unlink(tmp).catch(() => {}); }
  }
  async mutate(fn, { revision } = {}) {
    return this.lock(async () => {
      const snapshot = await this.read();
      if (revision !== undefined && revision !== snapshot.revision) fail('Data has changed; refresh and verify the item before retrying', 409, 'CONFLICT');
      const resources = captureBusinessResources(snapshot.data);
      const result = fn(snapshot.data);
      reconcileBusinessResources(snapshot.data, resources);
      snapshot.data.updated = timestamp().slice(0, 10);
      validateDocument(snapshot.data);
      const raw = `${JSON.stringify(snapshot.data, null, 2)}\n`;
      await this.atomicWrite(raw);
      return { data: snapshot.data, revision: digest(raw), ...result };
    });
  }
  async add(input, { collection, revision } = {}) {
    validateFields(input, true);
    collection ??= input.date ? 'plans' : 'pool';
    if (!COLLECTIONS.includes(collection)) fail('Unknown item collection');
    return this.mutate(data => {
      if (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim() || /^(recurring|plans|pool|history):\d+$/.test(input.id))) fail('New id must not be empty or use the collection:index reference format');
      const item = { ...input, id: input.id || randomUUID(), tags: input.tags || [], addedAt: timestamp() };
      if (entries(data).some(e => e.item.id === item.id)) fail('id already exists', 409, 'DUPLICATE_ID');
      if (collection === 'recurring') {
        if (input.done !== undefined || input.completedAt !== undefined || input.actualHours != null) fail('Recurring items are templates; use record to log a run');
        item.estHours ??= 1;
      } else {
        item.done = input.done ?? (collection === 'history');
        item.flagged ??= false;
        if (item.done) item.completedAt ??= timestamp();
        else if (item.completedAt) fail('Cannot set a completion time on an incomplete item');
      }
      validateItem(item);
      const index = data[collection].push(item) - 1;
      return { item, ref: `${collection}:${index}` };
    }, { revision });
  }
  async update(selector, patch, options) {
    validateFields(patch);
    return this.mutate(data => {
      const entry = find(data, selector), item = entry.item;
      if (entry.collection === 'recurring' && (patch.done !== undefined || patch.completedAt !== undefined || patch.actualHours !== undefined)) fail('Recurring items are templates; use record to log a run');
      const wasDone = isDone(item, entry.collection);
      Object.assign(item, patch);
      if (patch.actualHours === null) delete item.actualHours;
      if (patch.done === false) delete item.completedAt;
      else if (patch.done === true && !wasDone) item.completedAt = patch.completedAt || timestamp();
      if (patch.completedAt && !isDone(item, entry.collection)) fail('Cannot set a completion time on an incomplete item');
      validateItem(item);
      return { item, ref: entry.ref };
    }, options);
  }
  async remove(selector, options) {
    return this.mutate(data => {
      const { item, ref, collection, index } = find(data, selector);
      data[collection].splice(index, 1);
      return { item, ref };
    }, options);
  }
  async record(selector, actualHours, { revision, completedAt = timestamp() } = {}) {
    if (!Number.isFinite(actualHours) || actualHours < 0 || actualHours > 100000) fail('Actual hours must be non-negative (maximum 100000 hours)');
    if (!validDate(completedAt, true)) fail('Completion time must use YYYY-MM-DD HH:mm:ss');
    return this.mutate(data => {
      const entry = find(data, selector);
      if (entry.collection !== 'recurring') fail('Runs can only be recorded for recurring templates');
      const { id, done, completedAt: oldTime, addedAt, state, sortKey, ...template } = entry.item;
      const item = { ...template, id: randomUUID(), sourceRecurringId: id, actualHours, done: true, completedAt, addedAt: timestamp(), date: completedAt.slice(0, 10) };
      const index = data.history.push(item) - 1;
      return { item, ref: `history:${index}` };
    }, { revision });
  }
  async importFile(source, { replace = false } = {}) {
    const raw = await readFile(resolve(source), 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch { fail('Import file contains invalid JSON'); }
    validateDocument(data);
    return this.lock(async () => {
      let exists = true;
      try { if (isDatabase(this.file)) { if (!hasDocument(this.file, this.spaceId)) throw Object.assign(new Error('Missing record'), { code: 'ENOENT' }); } else await stat(this.file); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
      if (exists && !replace) fail('Destination already contains data; use --replace explicitly to overwrite it (a .bak backup will be kept)', 409, 'ALREADY_EXISTS');
      if (exists && isDatabase(this.file)) { const previous = await this.read(); const { writeFile } = await import('node:fs/promises'); await writeFile(`${this.file}.${this.spaceId}.bak.json`, JSON.stringify(previous.data, null, 2) + '\n', { mode: 0o600 }); } else if (exists) await copyFile(this.file, `${this.file}.bak`);
      await this.atomicWrite(raw);
      return { data, revision: digest(raw), backup: exists ? isDatabase(this.file) ? `${this.file}.${this.spaceId}.bak.json` : `${this.file}.bak` : null };
    });
  }
}
