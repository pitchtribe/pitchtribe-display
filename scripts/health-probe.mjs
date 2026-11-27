#!/usr/bin/env node
/* Checks a club's Pi from somewhere that is not the Pi.
 *
 * Run it on a timer from a machine that stays on. Deliberately *not* installed
 * on the card: a watcher that shares a power supply with the thing it watches
 * reports nothing at all in the one case anybody cares about.
 *
 *   node scripts/health-probe.mjs --host pitchtribe --fingerprint AA:BB:…
 *   node scripts/health-probe.mjs --host pitchtribe --fingerprint "$FP" --expect-version 0.4.3 --json
 *   node scripts/health-probe.mjs --host pitchtribe --address 192.168.1.194 --fingerprint "$FP"
 *
 * Exit codes, so a timer can tell "wake someone" from "look at it tomorrow":
 *   0  up and nothing to report
 *   1  up, but something needs attention (a warning, version drift, cert expiry)
 *   2  down: unreachable, not a 200, or the wrong certificate
 *   3  unobservable: this watcher never reached the card, so its state is
 *      unknown. Not the same as down, and reporting it as down is a lie that
 *      costs someone a drive to the clubhouse — see UNOBSERVABLE below.
 *
 * Four things here look like fussiness and are each a false alarm, or a missed
 * alarm, already found the hard way against a real card:
 *
 * - IPv4 is forced. The Pi's name resolves to both an A and an AAAA record, and
 *   the order is not stable between lookups. A watcher on an IPv4-only network
 *   gets a working probe most of the time and "network unreachable" the rest,
 *   against a card that is perfectly healthy. That is how a monitor loses the
 *   trust of the people it pages.
 *
 * - The certificate is pinned by fingerprint, not trusted by CA. The card makes
 *   its own self-signed certificate at first boot (app/lib/tls.js), so there is
 *   no authority to verify it against and `-k` is the usual next move — which
 *   authenticates nothing. Pinning the fingerprint is stronger than CA
 *   verification here, and it also detects a reimaged or swapped card, because
 *   a new card makes a new key.
 *
 * - The name matters. That certificate's SANs cover the short hostname and
 *   `.local`, but not the `.lan` form or the IP address. So `--host 192.168.1.194`
 *   is the wrong move: there is no name to put in SNI or the Host header, and
 *   the card's own vhost and logs then see an address. `--host` is the name on
 *   the certificate; `--address` is separately where to send the packets.
 *
 * - `--address` exists because the name is the probe's single point of failure.
 *   A card can be stopped dead on 443 while this probe never gets far enough to
 *   notice, because the watcher's resolver answers first and the probe exits
 *   `3` "unobservable" — which happened for nine consecutive firings against a
 *   card whose service had stopped (PIT-76). Given the address, the probe
 *   connects to the card, sends `--host` as SNI and in the Host header, and
 *   verifies the fingerprint exactly as before. Pinning does not consult the
 *   SANs, so nothing is weakened by not resolving the name: a wrong or reimaged
 *   card still fails closed at exit 2.
 *
 * No fingerprint is baked in: every card has its own, and a default here would
 * be a default nobody checks. Read the current one from Settings → Secure
 * connection, or:
 *   echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null \
 *     | openssl x509 -noout -fingerprint -sha256
 */
import https from 'node:https';
import http from 'node:http';
import process from 'node:process';

const DEFAULTS = {
  host: 'pitchtribe',
  port: null,
  path: '/healthz',
  timeout: 8000,
  /** A certificate this close to the end is a dashboard about to start warning. */
  certWarnDays: 30,
};

/* Failures of the watcher's own network, not of the card.
 *
 * A probe that cannot resolve the name or has no route to the subnet has
 * observed nothing: no TCP connection, no TLS handshake, no certificate, no
 * body. Reporting that as "down" was how a watcher with no path to the club LAN
 * came to file a critical "the card is down" report about a card nobody had
 * looked at (PIT-71). These exit 3 instead, and say the state is unknown.
 *
 * ECONNREFUSED and a timeout are deliberately NOT here. On a watcher that
 * normally reaches the card, a refusal is the service having stopped and a
 * timeout is the card wedged or firewalled — the two faults this probe exists
 * to catch. They are only ambiguous on a watcher that was never on the right
 * network, and a watcher in that state says so through this list first. */
const UNOBSERVABLE = new Set([
  'ENOTFOUND',     // no such name
  'EAI_AGAIN',     // resolver did not answer
  'ENETUNREACH',   // no route to that network
  'EHOSTUNREACH',  // no route to that host
  'ENETDOWN',      // this watcher has no network at all
  'EADDRNOTAVAIL', // nothing local to send from
]);

/** The error's own code, or the one the TLS/socket layer wrapped underneath. */
const errorCode = (err) => err?.code || err?.cause?.code || '';

function usage(message) {
  if (message) process.stderr.write(`health-probe: ${message}\n\n`);
  process.stderr.write(`Usage: node scripts/health-probe.mjs --host <name> --fingerprint <sha256> [options]

  --host <name>          name on the certificate (default: ${DEFAULTS.host})
  --address <ip>         connect here instead of resolving --host; --host is
                         still sent as SNI and Host, and still pinned. Use this
                         where the card's name does not resolve, so a stopped
                         service is reported as down rather than unobservable.
  --fingerprint <hex>    expected SHA-256, with or without colons
  --expect-version <v>   treat any other reported version as drift
  --cert-warn-days <n>   warn this long before the certificate expires (default: ${DEFAULTS.certWarnDays})
  --timeout <ms>         default: ${DEFAULTS.timeout}
  --http                 plain HTTP, for a card with HTTPS switched off
  --insecure             skip the fingerprint check (says so in the output)
  --json                 machine-readable result on stdout

Exit codes:
  0  up and nothing to report
  1  up, but something needs attention
  2  down: unreachable, not a 200, or the wrong certificate
  3  unobservable: this watcher could not resolve or reach the host, so the
     card's state is unknown. Fix the watcher's network, not the card.

Environment:
  PITCHTRIBE_FINGERPRINT   used when --fingerprint is not given, and enough on
                           its own to satisfy the requirement above. A stale
                           value left in a shell will be used, so prefer the
                           flag in anything scripted. A wrong value still fails
                           closed, with exit 2.
`);
  process.exit(message ? 64 : 0);
}

function parseArgs(argv) {
  const o = { ...DEFAULTS, address: '', fingerprint: process.env.PITCHTRIBE_FINGERPRINT || '', expectVersion: '', http: false, insecure: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--host') o.host = next();
    else if (a === '--address') o.address = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--path') o.path = next();
    else if (a === '--fingerprint') o.fingerprint = next();
    else if (a === '--expect-version') o.expectVersion = next();
    else if (a === '--cert-warn-days') o.certWarnDays = Number(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--http') o.http = true;
    else if (a === '--insecure') o.insecure = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown option ${a}`);
  }
  // Fail closed: without a fingerprint and without being told to skip it, this
  // would quietly become a probe that trusts any certificate at all. Note that
  // PITCHTRIBE_FINGERPRINT satisfies this too (see --help) — which is a
  // convenience, not a hole: a wrong value is rejected below at exit 2, so
  // nothing unverified is ever trusted.
  if (!o.http && !o.insecure && !o.fingerprint) {
    usage('--fingerprint is required for HTTPS (or pass --insecure, or --http)');
  }
  return o;
}

const normalise = (fp) => String(fp).replace(/:/g, '').trim().toLowerCase();
const days = (ms) => Math.floor(ms / 86400000);

/** GETs the route over IPv4, checking the certificate before trusting the body. */
function probe(o) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const defaultPort = o.http ? 80 : 443;
    const port = o.port ?? defaultPort;
    const opts = {
      /* Where the packets go. With --address that is the address, and the name
         in --host is carried by the Host header and SNI below — so the card
         answers as the vhost it thinks it is, and the pin still decides. */
      host: o.address || o.host,
      port,
      path: o.path,
      method: 'GET',
      family: 4, // see the note at the top of this file
      timeout: o.timeout,
      headers: {
        accept: 'application/json',
        'user-agent': 'pitchtribe-health-probe',
        /* Set by hand rather than left to Node, which would derive it from the
           address above. Same value as before when --address is not in use. */
        host: port === defaultPort ? o.host : `${o.host}:${port}`,
      },
    };
    if (!o.http) {
      /* The fingerprint check below is the verification, so the built-in chain
         check is turned off rather than failed. Safe here only because this
         sends no credentials — it is a GET of an open route — so the body is
         never trusted before the certificate has been matched. */
      /* SNI is the name from --host, never the address: RFC 6066 forbids an IP
         there, and Node warns. This is what lets --address verify — the card
         picks its certificate by this name, and the pin below checks it. */
      if (!/^[\d.]+$/.test(o.host)) opts.servername = o.host;
      opts.rejectUnauthorized = false;
    }

    const req = (o.http ? http : https).request(opts, (res) => {
      /* Read the socket now, not in `end`: by the time the body is complete the
         connection has been returned or closed and `res.socket` is null. */
      const socket = res.socket;
      const address = socket.remoteAddress;
      let cert = null;
      if (!o.http) {
        cert = socket.getPeerCertificate();
        if (!o.insecure) {
          const got = normalise(cert.fingerprint256 || '');
          if (!got || got !== normalise(o.fingerprint)) {
            res.destroy();
            return reject(new Error(
              `certificate fingerprint does not match (got ${cert.fingerprint256 || 'none'}) — a reimaged card, or the wrong host`
            ));
          }
        }
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body,
        cert,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        address,
      }));
      return undefined;
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${o.timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Turns one response into a verdict: what is wrong, and how loudly to say it. */
function assess(res, o) {
  const notes = [];
  const problems = [];

  /* Not a warning — a pinned probe by address is as verified as one by name.
     Said out loud anyway, because the resolver this bypasses is a fault of its
     own and a probe that hides it is how it stays unfixed. */
  if (o.address) notes.push(`reached ${o.address} by address; ${o.host} was never resolved`);

  if (res.status !== 200) problems.push(`HTTP ${res.status} (expected 200)`);

  let health = null;
  try {
    health = JSON.parse(res.body);
  } catch {
    problems.push('the response was not JSON — something other than the dashboard is on this port');
  }

  if (health && health.ok !== true) problems.push('the dashboard reports ok:false');

  const version = health?.version || null;
  if (o.expectVersion && version && version !== o.expectVersion) {
    notes.push(`running ${version}, expected ${o.expectVersion}`);
  }

  /* Older cards answer with just { ok, version } — no metrics. Say so once
     rather than reporting zeros, which would read as a healthy empty card. */
  const hasMetrics = Boolean(health && health.uptime);
  if (health && !hasMetrics) notes.push(`${version || 'this version'} predates /healthz metrics: liveness only`);

  if (hasMetrics) {
    for (const w of health.warnings || []) notes.push(`the card reports ${w}`);
    if (health.disk) notes.push(`disk ${health.disk.usedPercent}% used, ${(health.disk.freeBytes / 1024 ** 3).toFixed(1)} GiB free`);
    if (health.memory) notes.push(`memory ${health.memory.usedPercent}% used`);
    if (health.screens) notes.push(`screens ${health.screens.online}/${health.screens.total} online`);
    /* A service restarted minutes ago under a host that has been up for weeks
       is the crash-loop that a port check cannot see. */
    if (health.uptime.appSeconds < 600 && health.uptime.hostSeconds > 86400) {
      notes.push(`the service has only been up ${Math.round(health.uptime.appSeconds / 60)} min on a host up ${days(health.uptime.hostSeconds * 1000)} days — restarting?`);
    }
  }

  if (res.cert && res.cert.valid_to && !o.insecure) {
    const left = days(Date.parse(res.cert.valid_to) - Date.now());
    if (left < 0) notes.push(`the certificate expired ${-left} days ago`);
    else if (left <= o.certWarnDays) notes.push(`the certificate expires in ${left} days`);
  }

  const cardWarns = hasMetrics && (health.warnings || []).length > 0;
  const drift = Boolean(o.expectVersion && version && version !== o.expectVersion);
  const certSoon = Boolean(res.cert && res.cert.valid_to && !o.insecure
    && days(Date.parse(res.cert.valid_to) - Date.now()) <= o.certWarnDays);

  const code = problems.length ? 2 : (cardWarns || drift || certSoon) ? 1 : 0;
  return { code, problems, notes, health, version, hasMetrics };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const at = new Date().toISOString();
  let res;
  try {
    res = await probe(o);
  } catch (err) {
    /* `up: null`, not `false`: an unobservable probe did not find the card
       down, it failed to look. Anything reading this has to be able to tell
       those apart, because only one of them is about the card. */
    const blind = UNOBSERVABLE.has(errorCode(err));
    /* `address` is where the probe tried, so a failure says that much even
       though there is no peer to report. Omitted entirely without --address,
       where the name is the whole story. */
    const tried = o.address ? { address: o.address } : {};
    const out = blind
      ? { at, host: o.host, ...tried, up: null, code: 3, reason: 'unobservable', error: err.message }
      : { at, host: o.host, ...tried, up: false, code: 2, error: err.message };
    const where = o.address ? `${o.host} (${o.address})` : o.host;
    if (o.json) process.stdout.write(`${JSON.stringify(out)}\n`);
    else if (blind) {
      process.stderr.write(`BLIND ${where}: ${err.message}\n`);
      process.stderr.write('      this watcher cannot reach the host, so the card\'s state is unknown — not down\n');
    } else process.stderr.write(`DOWN  ${where}: ${err.message}\n`);
    process.exit(blind ? 3 : 2);
  }

  const v = assess(res, o);
  const out = {
    at,
    host: o.host,
    address: res.address,
    up: true,
    code: v.code,
    ms: Math.round(res.ms),
    version: v.version,
    metrics: v.hasMetrics,
    verified: !o.http && !o.insecure,
    problems: v.problems,
    notes: v.notes,
    health: v.health,
  };

  if (o.json) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    const label = v.code === 2 ? 'DOWN' : v.code === 1 ? 'WARN' : 'UP  ';
    const how = o.http ? 'http' : o.insecure ? 'https, UNVERIFIED' : 'https, pinned';
    process.stdout.write(`${label}  ${o.host} (${res.address}, ${how}) ${v.version || '?'} in ${Math.round(res.ms)}ms\n`);
    for (const p of v.problems) process.stdout.write(`      ! ${p}\n`);
    for (const n of v.notes) process.stdout.write(`      - ${n}\n`);
  }
  process.exit(v.code);
}

main().catch((err) => {
  process.stderr.write(`health-probe: ${err.stack || err.message}\n`);
  process.exit(2);
});
