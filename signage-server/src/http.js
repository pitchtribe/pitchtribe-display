import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { renderDisplay } from './render.js';

const MAX_BODY = 1_000_000;
const MAX_STREAM_CLIENTS = 50;

/**
 * Widget options a request may never set. `url` decides what address the Pi
 * fetches, and a Pi can see things the caller cannot — the club router's admin
 * page, a till, a camera recorder. Feed addresses come from the dashboard
 * (sanitizeWidget), so dropping it here costs nothing and closes the hole.
 * Every other widget option is already validated against a list or a pattern
 * inside sources.js.
 */
const RESERVED_PARAMS = new Set(['url']);

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function authorized(req, token) {
  if (!token) return true;
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Routes (relative to wherever the handler is mounted — `/` standalone, `/sports` inside the app):
 *   GET  /display            full-screen auto-rotating pamphlet (?leagues=eng.1,ucl&theme=light&rotate=10)
 *   GET  /api/health         status
 *   GET  /api/leagues        league list + status
 *   GET  /api/events         ?league=&status=live,final,scheduled,postponed&team=&limit=
 *   GET  /api/snapshot       everything, grouped by league
 *   GET  /api/stream         Server-Sent Events: "update" whenever data changes
 *   POST /api/refresh        re-fetch now            (Bearer token if apiToken set)
 *   POST /api/push           push to signage targets (Bearer token if apiToken set)
 *   GET  /api/widgets        widget list; GET /api/widgets/:kind?scope=&general=&days= for data
 *                            (Bearer token if apiToken set; `url` is never taken from the query)
 *   GET  /api/geocode?q=     place search for the weather location (Bearer token if apiToken set)
 *   POST /mcp                MCP over Streamable HTTP (Bearer token if apiToken set)
 */
export function createRequestHandler({ store, config, push, mcp, widgets, log = console.error }) {
  const clients = new Set();
  store.on('update', () => {
    for (const res of clients) res.write(`event: update\ndata: ${JSON.stringify({ updatedAt: store.updatedAt })}\n\n`);
  });
  const keepAlive = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
  keepAlive.unref();

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    // Opt-in, and off by default: with `access-control-allow-origin: *` any web
    // page open on the club's network can read this API through the browser of
    // whoever visited it. Screens load the display page from this origin and so
    // never need it.
    if (config.cors) res.setHeader('access-control-allow-origin', '*');
    try {
      if (req.method === 'OPTIONS') {
        return send(res, 204, '', 'text/plain', {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
        });
      }
      if (req.method === 'POST' && !authorized(req, config.apiToken)) {
        return send(res, 401, { error: 'Unauthorized' }, undefined, { 'www-authenticate': 'Bearer' });
      }

      if (widgets && req.method === 'GET') {
        const widget = /^\/api\/widgets\/([a-z]+)\/?$/.exec(url.pathname);
        const geocoding = url.pathname === '/api/geocode';
        // Widget data and the place search make the Pi fetch from the internet
        // on the caller's behalf, so they are treated like the POST routes
        // rather than like the display page a screen opens.
        if ((widget || geocoding) && !authorized(req, config.apiToken)) {
          return send(res, 401, { error: 'Unauthorized' }, undefined, { 'www-authenticate': 'Bearer' });
        }
        if (url.pathname === '/api/widgets') return send(res, 200, widgets.kinds);
        if (widget) {
          const opts = Object.fromEntries([...url.searchParams].filter(([k]) => !RESERVED_PARAMS.has(k.toLowerCase())));
          return send(res, 200, await widgets.get(widget[1], opts));
        }
        if (geocoding) return send(res, 200, await widgets.geocode(url.searchParams.get('q')));
      }

      switch (route) {
        case 'GET /':
          res.writeHead(302, { location: '/display' }).end();
          return;
        case 'GET /display': {
          const leagues = url.searchParams.get('leagues')?.split(',').filter(Boolean);
          const html = renderDisplay(store.snapshot(), {
            ...config,
            only: leagues,
            theme: url.searchParams.get('theme') ?? config.theme,
            rotateSeconds: url.searchParams.get('rotate') ?? config.rotateSeconds,
            rowsPerPage: url.searchParams.get('rows') ?? config.rowsPerPage,
            title: url.searchParams.get('title') ?? config.title,
          });
          return send(res, 200, html, 'text/html; charset=utf-8');
        }
        case 'GET /api/health':
          return send(res, 200, {
            ok: true, updatedAt: store.updatedAt, live: store.hasLive(), streamClients: clients.size,
          });
        case 'GET /api/leagues':
          return send(res, 200, store.snapshot().leagues.map(({ events, ...l }) => ({ ...l, events: events.length })));
        case 'GET /api/events':
          return send(res, 200, store.query(Object.fromEntries(url.searchParams)));
        case 'GET /api/snapshot':
          return send(res, 200, store.snapshot());
        case 'GET /api/stream':
          // Capped: an open stream costs a socket, and a club has a handful of
          // screens, not fifty. Without this one script can hold them all open.
          if (clients.size >= MAX_STREAM_CLIENTS) {
            return send(res, 503, { error: 'Too many open streams' }, undefined, { 'retry-after': '30' });
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream', 'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ updatedAt: store.updatedAt })}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        case 'POST /api/refresh': {
          const body = await readJson(req);
          const { changed, snapshot } = await store.refresh(body.league || url.searchParams.get('league') || undefined);
          return send(res, 200, { changed, updatedAt: snapshot.updatedAt });
        }
        case 'POST /api/push':
          return send(res, 200, { results: await push() });
        case 'POST /mcp': {
          const reply = await mcp(await readJson(req));
          if (!reply) return send(res, 202, '', 'text/plain');
          return send(res, 200, reply);
        }
        case 'GET /mcp':
        case 'DELETE /mcp':
          return send(res, 405, { error: 'Stateless MCP endpoint: POST JSON-RPC messages' }, undefined, { allow: 'POST' });
        default:
          return send(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      log(`[http] ${route}: ${err.message}`);
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
    }
  };

  handler.clients = clients;
  /** Stop keep-alives and end open streams (call when shutting down). */
  handler.close = () => {
    clearInterval(keepAlive);
    for (const res of clients) res.end();
    clients.clear();
  };
  return handler;
}

/** Standalone HTTP server around createRequestHandler(). */
export function createHttpServer(ctx) {
  const handler = createRequestHandler(ctx);
  const server = createServer(handler);
  server.on('close', handler.close);
  return server;
}
