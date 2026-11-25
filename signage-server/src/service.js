// Library entry point (`import ... from 'pitchtribe-signage-server'`).
// Wires the store, webhook push, MCP handler and HTTP routes together so the
// sports engine can run standalone (src/index.js) or inside the PitchTribe app,
// which mounts `handler` at /feeds.
import { Store, sortEvents } from './store.js';
import { pushToTargets } from './push.js';
import { createMcpHandler } from './mcp.js';
import { createRequestHandler, createHttpServer } from './http.js';
import { loadConfig, resolveConfig, exampleConfig } from './config.js';
import { renderDisplay } from './render.js';
import { buildClubhouse } from './clubhouse.js';
import { renderClubhouse } from './clubhouse-render.js';
import { listPhotos } from './photos.js';
import * as sources from './sources.js';
import { createWidgets, WIDGET_KINDS, TOPICS, HISTORY_TOPICS, TOPIC_LABELS, describeWeather, flagEmoji } from './widgets.js';

/**
 * @param {object} opts
 * @param {object} opts.config     result of loadConfig() / resolveConfig()
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.log]
 */
export function createSportsService({ config, fetchImpl = fetch, log = console.error }) {
  const store = new Store(config, { fetchImpl, log });
  const widgets = createWidgets({ config, fetchImpl, log });
  const push = () => pushToTargets(config.pushTargets, store.snapshot(), config, { fetchImpl, log });
  const mcp = createMcpHandler({ store, config, push, widgets });
  const handler = createRequestHandler({ store, config, push, mcp, widgets, log });

  store.on('update', async () => {
    log(`[store] data changed (${store.snapshot().leagues.reduce((n, l) => n + l.events.length, 0)} events)`);
    if (config.pushTargets.length) {
      const results = await push();
      log(`[push] ${results.filter((r) => r.ok).length}/${results.length} targets ok`);
    }
  });

  return {
    config,
    store,
    widgets,
    push,
    mcp,
    handler,
    start: () => store.start(),
    stop: () => {
      store.stop();
      handler.close();
    },
  };
}

export {
  Store,
  sortEvents,
  pushToTargets,
  createMcpHandler,
  createRequestHandler,
  createHttpServer,
  loadConfig,
  resolveConfig,
  exampleConfig,
  renderDisplay,
  buildClubhouse,
  renderClubhouse,
  listPhotos,
  createWidgets,
  WIDGET_KINDS,
  TOPICS,
  HISTORY_TOPICS,
  TOPIC_LABELS,
  describeWeather,
  flagEmoji,
  sources,
};

/** Clearer name now the service does more than sports. */
export const createSignageService = createSportsService;
