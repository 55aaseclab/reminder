import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, dirname, basename } from 'node:path';
import { Store, ReminderError, COLLECTIONS, entries, timestamp, validateDocument } from './store.js';
import { computeStats } from './stats.js';
import { businessMetadata, captureBusinessResources, reconcileBusinessResources, resourcePattern } from './business-metadata.js';

const actions = { list: 'read', stats: 'read', events: 'read', integrity: 'read', add: 'create', record: 'create', update: 'update', complete: 'complete', delete: 'delete' };
const writes = new Set(['add', 'record', 'update', 'complete', 'delete']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new ReminderError(message, status, code); };
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} contains unsupported fields`);
}
function noResource() { fail('Resource not found', 404, 'NOT_FOUND'); }
function permitted(claims, resourceId) { return claims.resources.includes('*') || claims.resources.includes(resourceId); }
function empty() { return { version: 2, updated: '', recurring: [], plans: [], pool: [], history: [] }; }

export function verifyAssertion(raw, assertion, key, now = Date.now()) {
  const invalid = () => fail('A valid business assertion is required', 401, 'INVALID_ASSERTION');
  if (typeof assertion !== 'string' || assertion.length > 32768) invalid();
  const parts = assertion.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) invalid();
  const signature = Buffer.from(parts[1], 'base64url');
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) invalid();
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { invalid(); }
  const keys = ['v', 'appId', 'userId', 'clientId', 'grantId', 'spaceId', 'action', 'resources', 'expiresAt', 'requestId', 'method', 'path', 'bodyHash'];
  if (!object(claims) || Object.keys(claims).some(key => !keys.includes(key) && key !== 'sourceReadGranted') || keys.some(key => !Object.hasOwn(claims, key))) invalid();
  if (claims.sourceReadGranted !== undefined && claims.sourceReadGranted !== true) invalid();
  if (claims.v !== 1 || claims.appId !== 'reminder' || claims.method !== 'POST' || claims.path !== '/api/business' || claims.bodyHash !== hash(raw)) invalid();
  if (!['userId', 'clientId', 'grantId', 'spaceId', 'requestId'].every(key => identifier(claims[key])) || !Object.values(actions).includes(claims.action)) invalid();
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.expiresAt > now + 30000) invalid();
  if (!Array.isArray(claims.resources) || !claims.resources.length || claims.resources.length > 1000 || new Set(claims.resources).size !== claims.resources.length || claims.resources.some(resource => resource !== '*' && (typeof resource !== 'string' || !resourcePattern.test(resource))) || claims.resources.includes('*') && claims.resources.length !== 1) invalid();
  return claims;
}

function canonicalPath(file) {
  try { return realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let parent = dirname(file);
    const tail = [basename(file)];
    while (true) {
      try { return resolve(realpathSync(parent), ...tail); }
      catch (error) {
        if (error.code !== 'ENOENT' || parent === dirname(parent)) throw error;
        tail.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
  }
}

export function loadBusinessService(env = process.env) {
  if (env.REMINDER_MANAGED !== undefined && !['0', '1'].includes(env.REMINDER_MANAGED)) throw new Error('REMINDER_MANAGED must be 0 or 1');
  if (env.REMINDER_MANAGED !== '1') return null;
  if (!env.REMINDER_BUSINESS_KEY_FILE || !env.REMINDER_BUSINESS_SPACES_FILE) throw new Error('Managed mode requires REMINDER_BUSINESS_KEY_FILE and REMINDER_BUSINESS_SPACES_FILE');
  for (const file of [env.REMINDER_BUSINESS_KEY_FILE, env.REMINDER_BUSINESS_SPACES_FILE]) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Managed business configuration and key must be private regular files');
  }
  const key = readFileSync(env.REMINDER_BUSINESS_KEY_FILE);
  let config;
  try { config = JSON.parse(readFileSync(env.REMINDER_BUSINESS_SPACES_FILE, 'utf8')); }
  catch { throw new Error('Business spaces configuration must contain valid JSON'); }
  if (!object(config) || Object.keys(config).some(key => key !== 'spaces')) throw new Error('Business spaces configuration requires a spaces object');
  return new BusinessService({ key, spaces: config.spaces });
}

export class BusinessService {
  constructor({ key, spaces, now = () => Date.now() }) {
    if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('Business assertion key must contain at least 32 bytes');
    if (!object(spaces) || !Object.keys(spaces).length) throw new Error('Business spaces must be a nonempty explicit mapping');
    const paths = new Set();
    this.stores = new Map();
    for (const [spaceId, file] of Object.entries(spaces)) {
      if (!identifier(spaceId) || typeof file !== 'string' || !isAbsolute(file)) throw new Error('Each business space requires an identifier and absolute data file');
      const canonical = canonicalPath(file);
      if (paths.has(canonical)) throw new Error('Business spaces must use distinct data files');
      paths.add(canonical);
      this.stores.set(spaceId, new Store(canonical));
    }
    this.key = Buffer.from(key);
    this.now = now;
  }

  async snapshot(store) {
    try { return await store.read(); }
    catch (error) {
      if (error.code === 'NOT_FOUND') return { data: empty(), revision: 'uninitialized', missing: true };
      throw error;
    }
  }

  validateRequest(request, claims) {
    fields(request, ['operation', 'spaceId', 'resourceId', 'sourceResourceId', 'input', 'expectedRevision', 'idempotencyKey'], 'Business request');
    if (typeof request.operation !== 'string' || !Object.hasOwn(actions, request.operation) || !identifier(request.spaceId)) fail('Business operation and spaceId are required');
    if (claims.spaceId !== request.spaceId || claims.action !== actions[request.operation] || !this.stores.has(request.spaceId)) fail('Business scope is not authorized', 403, 'FORBIDDEN');
    if (request.input !== undefined && !object(request.input)) fail('Business input must be an object');
    if (request.operation !== 'record' && request.sourceResourceId !== undefined) fail('Only record accepts a sourceResourceId');
    if (['update', 'complete', 'delete', 'record'].includes(request.operation)) {
      const targetId = request.operation === 'record' ? request.sourceResourceId : request.resourceId;
      if (typeof targetId !== 'string' || !resourcePattern.test(targetId)) fail('A valid target resource ID is required');
      if (request.operation === 'record' && request.resourceId !== undefined) fail('Record requires sourceResourceId instead of resourceId');
      if (!permitted(claims, targetId)) noResource();
      if (typeof request.expectedRevision !== 'string' || !/^[1-9][0-9]{0,14}$/.test(request.expectedRevision)) fail('A record expectedRevision is required', 428, 'REVISION_REQUIRED');
    } else if (request.operation === 'add') {
      if (request.expectedRevision !== undefined) fail('Create does not accept a record revision');
      if (request.resourceId !== undefined && (typeof request.resourceId !== 'string' || !resourcePattern.test(request.resourceId))) fail('Create resource ID is invalid');
      if (request.resourceId !== undefined && !permitted(claims, request.resourceId)) fail('Create resource is not authorized', 403, 'FORBIDDEN');
      if (request.resourceId === undefined && !claims.resources.includes('*')) fail('Create requires an authorized target resource or space scope', 403, 'FORBIDDEN');
    } else if (request.resourceId !== undefined || request.expectedRevision !== undefined) fail('This operation does not accept a target resource or record revision');
    if (request.operation === 'record' && !claims.resources.includes('*')) fail('Create requires an authorized space scope', 403, 'FORBIDDEN');
    if (request.operation === 'record' && claims.sourceReadGranted !== true) fail('Record requires a trusted source-read authorization', 403, 'FORBIDDEN');
    if (request.operation === 'integrity') {
      if (!claims.resources.includes('*')) fail('Integrity requires an authorized whole-space read scope', 403, 'FORBIDDEN');
      if (request.input !== undefined) fail('Integrity does not accept input fields');
    }
    if (writes.has(request.operation)) {
      if (!identifier(request.idempotencyKey)) fail('A valid idempotencyKey is required', 428, 'IDEMPOTENCY_REQUIRED');
    } else if (request.idempotencyKey !== undefined) fail('Read operations do not accept an idempotencyKey');
    const input = request.input || {};
    if (request.operation === 'list') fields(input, ['collection'], 'List input');
    if (request.operation === 'stats') fields(input, ['period', 'anchor'], 'Statistics input');
    if (request.operation === 'events') {
      fields(input, ['after'], 'Events input');
      if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) fail('Event cursor must be a non-negative integer');
    }
    if (request.operation === 'add') {
      fields(input, ['item', 'collection'], 'Create input');
      if (!object(input.item)) fail('Create input requires an item');
      if (Object.hasOwn(input.item, 'id') || Object.hasOwn(input.item, 'done') || Object.hasOwn(input.item, 'completedAt')) fail('Create cannot set identity or completion fields');
      if (input.collection === 'history') fail('Create active tasks before completing them');
    }
    if (request.operation === 'update') {
      fields(input, ['text', 'date', 'tags', 'notes', 'location', 'estHours', 'actualHours', 'flagged'], 'Update input');
      if (!Object.keys(input).length) fail('Update requires at least one field');
    }
    if (request.operation === 'complete') {
      fields(input, ['done', 'actualHours', 'completedAt'], 'Completion input');
      if (input.done !== undefined && typeof input.done !== 'boolean') fail('Completion done must be a boolean');
    }
    if (request.operation === 'record') fields(input, ['actualHours', 'completedAt'], 'Recurring execution input');
    if (request.operation === 'delete') fields(input, [], 'Delete input');
    if (input.collection !== undefined && !COLLECTIONS.includes(input.collection)) fail('Unknown item collection');
  }

  resourceEntries(data, state) {
    return entries(data).map(entry => ({ ...entry, resource: state.resources[entry.collection][entry.index] }));
  }

  async handle(raw, assertion) {
    const claims = verifyAssertion(raw, assertion, this.key, this.now());
    let request;
    try { request = JSON.parse(raw.toString('utf8')); } catch { fail('Business request contains invalid JSON'); }
    this.validateRequest(request, claims);
    const store = this.stores.get(request.spaceId);
    if (writes.has(request.operation)) return this.write(store, request, claims);
    const snapshot = await this.snapshot(store);
    const state = businessMetadata(snapshot.data, request.spaceId, this.key);
    const allowed = this.resourceEntries(snapshot.data, state).filter(entry => permitted(claims, entry.resource.id));
    const revision = snapshot.missing ? 'uninitialized' : createHmac('sha256', this.key).update(JSON.stringify([request.spaceId, snapshot.revision])).digest('hex');
    const base = { spaceId: request.spaceId, revision, cursor: state.cursor };
    if (request.operation === 'integrity') {
      const counts = Object.fromEntries(COLLECTIONS.map(collection => [collection, snapshot.data[collection].length]));
      return { ...base, counts, resourceCount: Object.values(counts).reduce((sum, count) => sum + count, 0) };
    }
    if (request.operation === 'list') {
      const items = allowed.filter(entry => !request.input?.collection || entry.collection === request.input.collection).map(({ resource, collection, item }) => ({ resourceId: resource.id, revision: String(resource.revision), collection, item }));
      return { ...base, items };
    }
    if (request.operation === 'stats') {
      const data = empty();
      for (const entry of allowed) data[entry.collection].push(entry.item);
      return { ...base, stats: computeStats(data, request.input) };
    }
    const after = request.input?.after ?? 0;
    const minCursor = state.events[0]?.cursor ?? state.cursor + 1;
    const resetRequired = after < minCursor - 1 || after > state.cursor;
    return { ...base, minCursor, resetRequired, events: resetRequired ? [] : state.events.filter(event => event.cursor > after && permitted(claims, event.resourceId)) };
  }

  async write(store, request, claims) {
    return store.lock(async () => {
      if (claims.expiresAt <= this.now()) fail('Business assertion expired before commit', 401, 'INVALID_ASSERTION');
      const snapshot = await this.snapshot(store);
      if (snapshot.missing && request.operation !== 'add') noResource();
      const data = snapshot.data;
      const state = businessMetadata(data, request.spaceId, this.key);
      const scopeKey = hash(canonical([claims.userId, claims.clientId, request.spaceId, request.idempotencyKey]));
      const requestHash = hash(canonical(request));
      const prior = state.receipts.find(receipt => receipt.scopeKey === scopeKey);
      if (prior) {
        if (prior.requestHash !== requestHash) fail('Idempotency key was already used for a different request', 409, 'IDEMPOTENCY_CONFLICT');
        if (!permitted(claims, prior.result.resourceId)) noResource();
        return { ...prior.result, replayed: true };
      }
      if (request.operation === 'add' && request.resourceId !== undefined && (this.resourceEntries(data, state).some(entry => entry.resource.id === request.resourceId) || state.receipts.some(receipt => receipt.result.resourceId === request.resourceId))) fail('Create resource ID already exists', 409, 'RESOURCE_EXISTS');
      data._business = state;
      const before = captureBusinessResources(data);
      const targetId = request.operation === 'record' ? request.sourceResourceId : request.resourceId;
      const target = targetId && this.resourceEntries(data, state).find(entry => entry.resource.id === targetId);
      if (request.operation !== 'add') {
        if (!target) noResource();
        if (String(target.resource.revision) !== request.expectedRevision) fail('Record has changed; read it again before retrying', 409, 'CONFLICT');
      }
      const transaction = Object.create(store);
      transaction.mutate = async fn => fn(data);
      let result;
      if (request.operation === 'add') result = await transaction.add(request.input.item, { collection: request.input.collection });
      else if (request.operation === 'record') result = await transaction.record(target.ref, request.input?.actualHours, { ...(request.input?.completedAt !== undefined && { completedAt: request.input.completedAt }) });
      else if (request.operation === 'update') result = await transaction.update(target.ref, request.input || {});
      else if (request.operation === 'complete') result = await transaction.update(target.ref, { ...request.input, done: request.input?.done ?? true });
      else result = await transaction.remove(target.ref);
      reconcileBusinessResources(data, before);
      const entry = request.operation === 'delete' ? null : this.resourceEntries(data, state).find(entry => entry.item === result.item);
      if (request.operation === 'add' && request.resourceId !== undefined) entry.resource.id = request.resourceId;
      const resourceId = entry?.resource.id ?? target.resource.id;
      const revision = String(entry?.resource.revision ?? target.resource.revision + 1);
      const event = { id: randomUUID(), cursor: state.cursor + 1, resourceId, revision, operation: request.operation, requestId: claims.requestId, committedAt: new Date(this.now()).toISOString() };
      state.cursor = event.cursor;
      state.events.push(event);
      state.events = state.events.slice(-2048);
      const response = { spaceId: request.spaceId, resourceId, revision, cursor: state.cursor, event, replayed: false, ...(request.operation === 'record' ? { sourceResourceId: request.sourceResourceId } : {}), ...(entry ? { collection: entry.collection, item: structuredClone(entry.item) } : { deleted: true }) };
      state.receipts.push({ scopeKey, requestHash, result: response });
      data.updated = timestamp(new Date(this.now())).slice(0, 10);
      validateDocument(data);
      if (claims.expiresAt <= this.now()) fail('Business assertion expired before commit', 401, 'INVALID_ASSERTION');
      await store.atomicWrite(`${JSON.stringify(data, null, 2)}\n`);
      return response;
    });
  }
}
