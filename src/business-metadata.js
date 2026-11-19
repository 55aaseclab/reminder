import { createHash, createHmac, randomUUID } from 'node:crypto';

const collections = ['recurring', 'plans', 'pool', 'history'];
export const resourcePattern = /^r_[A-Za-z0-9_-]{16,64}$/;
const fingerprint = item => createHash('sha256').update(JSON.stringify(item)).digest('hex');
const invalid = () => {
  const error = new Error('Business resource metadata is invalid or no longer matches its data');
  error.status = 422;
  error.code = 'INVALID_BUSINESS_STATE';
  throw error;
};

export function validateBusinessMetadata(data) {
  const state = data._business;
  if (state === undefined) return;
  if (!state || state.version !== 1 || typeof state.spaceId !== 'string' || !state.resources || !Array.isArray(state.receipts) || !Array.isArray(state.events) || !Number.isSafeInteger(state.cursor) || state.cursor < 0) invalid();
  const ids = new Set();
  for (const collection of collections) {
    const resources = state.resources[collection];
    if (!Array.isArray(resources) || resources.length !== data[collection].length) invalid();
    resources.forEach((resource, index) => {
      if (!resource || !resourcePattern.test(resource.id) || ids.has(resource.id) || !Number.isSafeInteger(resource.revision) || resource.revision < 1 || resource.digest !== fingerprint(data[collection][index])) invalid();
      ids.add(resource.id);
    });
  }
}

export function businessMetadata(data, spaceId, key) {
  validateBusinessMetadata(data);
  if (data._business) {
    if (data._business.spaceId !== spaceId) invalid();
    return data._business;
  }
  const resources = Object.fromEntries(collections.map(collection => [collection, data[collection].map((item, index) => ({
    id: `r_${createHmac('sha256', key).update(JSON.stringify([spaceId, collection, index, item])).digest('base64url')}`,
    revision: 1,
    digest: fingerprint(item),
  }))]));
  return { version: 1, spaceId, resources, receipts: [], events: [], cursor: 0 };
}

export function captureBusinessResources(data) {
  if (!data._business) return null;
  validateBusinessMetadata(data);
  const before = new Map();
  for (const collection of collections) data[collection].forEach((item, index) => before.set(item, { ...data._business.resources[collection][index] }));
  return before;
}

export function reconcileBusinessResources(data, before) {
  if (!before) return;
  for (const collection of collections) {
    data._business.resources[collection] = data[collection].map(item => {
      const prior = before.get(item);
      const digest = fingerprint(item);
      return prior ? { ...prior, digest, revision: prior.revision + Number(prior.digest !== digest) } : { id: `r_${randomUUID()}`, revision: 1, digest };
    });
  }
}
