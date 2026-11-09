'use strict';
/* Server-Sent Events hub: pushes "content changed", "identify" and "reload"
   to connected screens so updates appear within a second.

   The player API has no login — a screen is just a browser on the club's
   network — so the number of open streams is capped. A club has a handful of
   screens; without a cap one script on the network can hold every socket the
   Pi has open and a real screen cannot reconnect after a reboot. */

const MAX_CLIENTS = 250;
const MAX_PER_SCREEN = 4; // a reconnect can briefly overlap the stream it replaces
const MAX_PER_IP = 12;

class Hub {
  constructor({ maxClients = MAX_CLIENTS, maxPerScreen = MAX_PER_SCREEN, maxPerIp = MAX_PER_IP } = {}) {
    this.limits = { maxClients, maxPerScreen, maxPerIp };
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  /** True if another stream for this screen/address would be one too many. */
  full(screenId, ip) {
    if (this.clients.size >= this.limits.maxClients) return true;
    let perScreen = 0;
    let perIp = 0;
    for (const c of this.clients) {
      if (c.screenId === screenId) perScreen += 1;
      if (ip && c.ip === ip) perIp += 1;
    }
    return perScreen >= this.limits.maxPerScreen || perIp >= this.limits.maxPerIp;
  }

  add(req, res, screenId) {
    if (this.full(screenId, req.ip)) {
      res.set('Retry-After', '30').status(503).json({ error: 'Too many open connections' });
      return null;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, screenId, ip: req.ip };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    return client;
  }

  write(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  }

  broadcast(event, data) {
    for (const c of this.clients) this.write(c, event, data);
  }

  send(screenId, event, data) {
    let n = 0;
    for (const c of this.clients) {
      if (c.screenId === screenId) {
        this.write(c, event, data);
        n += 1;
      }
    }
    return n;
  }

  isConnected(screenId) {
    for (const c of this.clients) if (c.screenId === screenId) return true;
    return false;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}

module.exports = { Hub };
