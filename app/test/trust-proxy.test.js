'use strict';
/* Who the server thinks is asking, when something sits in front of it.

   With the Cloudflare Tunnel (deploy/setup, cpfa.pitchtribe.co.uk) cloudflared
   runs on the Pi itself and reaches the dashboard over loopback, so without
   TRUST_PROXY every remote visitor arrives as 127.0.0.1. That is not cosmetic:
   the login limiter (lib/auth.js) and the cap of 12 event streams per address
   (lib/hub.js) are both counted per req.ip, so one shared address means one
   shared allowance of each for the whole internet.

   TRUST_PROXY reaches the app as a *string* from the unit file, which is the
   trap these tests exist to hold shut: "1" looks like a hop count and is read
   by proxy-addr as the address 0.0.0.1, so it trusts nothing and fails silently
   — the dashboard keeps working and keeps seeing the wrong address. `loopback`
   is the value that works, and it is also the value that keeps a machine on the
   club's own network from forging an address, because the club LAN is not
   loopback. See deploy/pitchtribe.service. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

/* TRUST_PROXY is read once, as the app is built (lib/app.js), so it has to be
   in the environment for exactly that call and gone again afterwards. */
function withTrustProxy(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TRUST_PROXY');
  const before = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    return fn();
  } finally {
    if (had) process.env.TRUST_PROXY = before;
    else delete process.env.TRUST_PROXY;
  }
}

async function start(t, trustProxy) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-trust-proxy-'));
  const ctx = withTrustProxy(trustProxy, () =>
    createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} })
  );
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /* The address the app decided on, read back out of the store: a screen
     polling its manifest records req.ip (lib/app.js, screenFor). It is the one
     place a plain unauthenticated GET leaves req.ip somewhere a test can see
     it, and it is the request the SSE cap is about. */
  const seenIp = async (screenId, forwardedFor) => {
    const res = await fetch(`${base}/api/player/${screenId}/manifest`, {
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    });
    assert.equal(res.status, 200);
    const screen = ctx.store.data.screens.find((s) => s.id === screenId);
    assert.ok(screen, `screen ${screenId} was not registered`);
    // Node reports a v4 peer on a dual-stack socket as ::ffff:127.0.0.1.
    return String(screen.ip).replace(/^::ffff:/, '');
  };

  return { ctx, base, seenIp };
}

test('without TRUST_PROXY the forwarded client is ignored and everyone is the proxy', async (t) => {
  const { seenIp } = await start(t, undefined);

  assert.equal(
    await seenIp('lounge-tv', '203.0.113.7'),
    '127.0.0.1',
    'this is the bug: every tunnelled visitor shares one address, and so one login and SSE allowance'
  );
});

test('TRUST_PROXY=loopback reports the real client behind the tunnel', async (t) => {
  const { seenIp } = await start(t, 'loopback');

  assert.equal(await seenIp('lounge-tv', '203.0.113.7'), '203.0.113.7');
  // Two remote visitors are now two addresses, which is the whole point.
  assert.equal(await seenIp('bar-tv', '198.51.100.9'), '198.51.100.9');
  // Nothing in front of it at all: the peer, unchanged.
  assert.equal(await seenIp('hall-tv', undefined), '127.0.0.1');
});

test('TRUST_PROXY=loopback does not let a client promote an address it supplied itself', async (t) => {
  const { ctx, seenIp } = await start(t, 'loopback');

  /* A remote client that sends its own X-Forwarded-For does not get to choose
     what the app sees: cloudflared appends the address it is really talking to,
     and only the loopback hop is peeled off, so the nearest untrusted entry
     wins. 1.2.3.4 here is the attacker's claim; 203.0.113.7 is the truth. */
  assert.equal(await seenIp('lounge-tv', '1.2.3.4, 203.0.113.7'), '203.0.113.7');

  /* And a forged header from the club's own network is refused outright,
     because the club LAN is not loopback. The app only ever listens on
     loopback in a test, so this is asserted on the trust rule express
     compiled rather than over a socket; the matching check against the real
     Pi is the bench step in deliverables/pit-228. */
  const trusts = ctx.app.get('trust proxy fn');
  assert.equal(typeof trusts, 'function');
  assert.equal(trusts('127.0.0.1', 0), true, 'cloudflared, on this Pi');
  assert.equal(trusts('::1', 0), true);
  assert.equal(trusts('192.168.1.50', 0), false, 'a laptop in the clubhouse');
  assert.equal(trusts('10.0.0.5', 0), false);
  assert.equal(trusts('203.0.113.7', 0), false, 'and anything off-site');
});

test('TRUST_PROXY=1 is the footgun: it reads as an address, trusts nothing, and says nothing', async (t) => {
  const { ctx, seenIp } = await start(t, '1');

  /* proxy-addr takes the string "1" for the address 0.0.0.1 — not one hop — so
     this looks configured and behaves exactly like leaving it unset. No
     warning, no error, and the limiter and SSE cap stay wrong. */
  assert.equal(await seenIp('lounge-tv', '203.0.113.7'), '127.0.0.1');
  assert.equal(ctx.app.get('trust proxy fn')('127.0.0.1', 0), false, 'not even the loopback hop is trusted');
});

test('TRUST_PROXY=true refuses to start rather than start wrong', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-trust-proxy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  /* The other way of writing a boolean in a unit file. express only accepts
     a real `true`, and a string is an address list, so this one is loud — it
     throws as the app is built and systemd restart-loops. Loud is fine; it is
     "1" that is dangerous. */
  assert.throws(
    () =>
      withTrustProxy('true', () =>
        createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} })
      ),
    /invalid IP address/i
  );
});
