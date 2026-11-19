#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Store, ReminderError } from './store.js';
import { computeStats } from './stats.js';
import { loadBusinessService } from './business.js';

const publicDir = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/views.js', ['views.js', 'text/javascript; charset=utf-8']],
]);
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req, raw = false) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ReminderError('Request must use application/json', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1048576) throw new ReminderError('Request body exceeds 1MB', 413);
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (raw) return content;
  try { return JSON.parse(content.toString('utf8')); } catch { throw new ReminderError('Request contains invalid JSON'); }
}
function parseAllowedOrigins(value) {
  if (value === undefined) return null;
  const invalid = () => new Error('REMINDER_ALLOWED_ORIGINS must be a nonempty comma-separated list of HTTP(S) origins without userinfo, paths, queries, or fragments');
  if (typeof value !== 'string') throw invalid();
  const origins = new Set();
  for (const item of value.split(',')) {
    const origin = item.trim();
    if (!/^https?:\/\/[^/?#@\\]+$/i.test(origin) || /\s/.test(origin)) throw invalid();
    let parsed;
    try { parsed = new URL(origin); } catch { throw invalid(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.includes('*') || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw invalid();
    origins.add(parsed.origin);
  }
  return origins;
}
function parseBusinessUiUrl(value) {
  if (value === undefined) return null;
  const invalid = () => new Error('REMINDER_BUSINESS_UI_URL requires an HTTPS or loopback HTTP URL without credentials, query, or fragment');
  if (typeof value !== 'string' || !/^https?:\/\/[^/]/i.test(value) || /[\\\s\x00-\x1f\x7f?#]/.test(value)) throw invalid();
  if (value.split('/')[2].includes('@')) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.hostname.includes('*') || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw invalid();
  return url.href;
}
export function createServer({ store = new Store(), allowedOrigins = process.env.REMINDER_ALLOWED_ORIGINS, businessService, businessUiUrl = process.env.REMINDER_BUSINESS_UI_URL } = {}) {
  const origins = parseAllowedOrigins(allowedOrigins);
  const business = businessService === undefined ? loadBusinessService() : businessService;
  if (business && typeof business.handle !== 'function') throw new Error('Business service must expose a request handler');
  const uiUrl = business ? parseBusinessUiUrl(businessUiUrl) : null;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // Embedding policy is independent of external clients.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://reminder.local');
      if (url.pathname === '/health' && req.method === 'GET' && !url.search) return json(res, 200, { status: 'ok', appId: 'reminder', managed: Boolean(business) });
      if (uiUrl && url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(303, { Location: uiUrl });
        return res.end();
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/business' && business) {
          if (req.method !== 'POST' || url.search) throw new ReminderError('Business requests require POST /api/business', 405, 'METHOD_NOT_ALLOWED');
          const result = await business.handle(await body(req, true), req.headers['x-praxis-assertion']);
          return json(res, 200, result);
        }
        if (business) throw new ReminderError('Use the controlled business gateway', 403, 'CONTROLLED_API_REQUIRED');
        if (req.method === 'GET' && url.pathname === '/api/data') return json(res, 200, await store.read());
        if (req.method === 'GET' && url.pathname === '/api/stats') {
          const { data } = await store.read();
          return json(res, 200, computeStats(data, { period: url.searchParams.get('period') || 'week', ...(url.searchParams.has('anchor') && { anchor: url.searchParams.get('anchor') }) }));
        }
        if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) throw new ReminderError('API endpoint or request method not found', 404, 'NOT_FOUND');
        // Configured origins are explicit; Host and proxy headers never expand that list.
        const origin = req.headers.origin;
        if (origins ? !origins.has(origin) : origin && origin !== `http://${req.headers.host}`) throw new ReminderError('Cross-origin writes are rejected', 403, 'ORIGIN_REJECTED');
        const revision = req.headers['if-match']?.replace(/^"|"$/g, '');
        if (!revision) throw new ReminderError('Writes require an If-Match data revision; reload first', 428, 'REVISION_REQUIRED');
        let result;
        if (url.pathname === '/api/items' && req.method === 'POST') {
          const input = await body(req);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReminderError('Request must be an object');
          result = await store.add(input.item, { collection: input.collection, revision });
        } else {
          const match = /^\/api\/items\/([^/]+)(\/record)?$/.exec(url.pathname);
          if (!match) throw new ReminderError('API endpoint not found', 404, 'NOT_FOUND');
          const selector = decodeURIComponent(match[1]);
          if (match[2] && req.method === 'POST') {
            const input = await body(req);
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReminderError('Request must be an object');
            result = await store.record(selector, input.actualHours, { revision, ...(input.completedAt !== undefined && { completedAt: input.completedAt }) });
          } else if (!match[2] && req.method === 'PATCH') result = await store.update(selector, await body(req), { revision });
          else if (!match[2] && req.method === 'DELETE') result = await store.remove(selector, { revision });
          else throw new ReminderError('Request method is not supported', 405, 'METHOD_NOT_ALLOWED');
        }
        return json(res, req.method === 'POST' ? 201 : 200, result);
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new ReminderError('Request method is not supported', 405);
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const asset = assets.get(url.pathname);
      if (!asset) throw new ReminderError('Page not found', 404, 'NOT_FOUND');
      const content = await readFile(new URL(asset[0], publicDir));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error.status) json(res, error.status, { error: error.message, code: error.code });
      else if (error instanceof URIError) json(res, 400, { error: 'Invalid path encoding', code: 'INVALID_PATH' });
      else {
        console.error('reminder:', error.message);
        json(res, 500, { error: 'Read or write failed; check data file and directory permissions', code: 'IO_ERROR' });
      }
    }
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = { host: process.env.HOST || '127.0.0.1', port: process.env.PORT || '4322', data: process.env.REMINDER_DATA };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    if (!['host', 'port', 'data'].includes(key) || !process.argv[i + 1]) throw new Error('Usage: npm start -- [--host 0.0.0.0] [--port 4322] [--data FILE]');
    options[key] = process.argv[++i];
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const store = new Store(options.data);
  const businessService = loadBusinessService();
  if (!businessService) await store.read();
  const server = createServer({ store, businessService });
  server.on('error', error => { console.error(`reminder failed to start: ${error.message}`); process.exitCode = 1; });
  server.listen(port, options.host, () => console.log(businessService ? `Reminder managed service started: http://${options.host}:${port}/` : `reminder started: http://${options.host}:${port}/ | data: ${store.file}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}
