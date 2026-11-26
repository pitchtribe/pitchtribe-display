'use strict';
/* The remote-access routes on the startup commissioning listener, driven over
   real HTTP against a stubbed broker.

   Two claims need evidence rather than assertion. One: the token must not come
   back — not in a response body, not echoed into the page, not in an error. On
   a Pi that evidence set also covers journald, `systemctl show`, `ps` and
   /proc; those need hardware, but the HTTP half can be proved here, and this
   is the half a reviewer would otherwise have to take on trust. Two: the
   remote-access form has to be reachable on a route that is not gated by
   wifi_connected(), because a connector needs the internet and '/' stops being
   served the moment Wi-Fi comes up.

   The broker is stubbed: everything privileged is a Unix socket away, which is
   exactly what makes the web boundary testable without root. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SETUP = path.join(__dirname, '..', '..', 'deploy', 'setup');

const HARNESS = `
import base64, json, importlib.util, os, socket, socketserver, tempfile, threading, urllib.error, urllib.request
from http.server import HTTPServer

spec = importlib.util.spec_from_file_location('wifi_startup', ${JSON.stringify(SETUP)} + '/wifi-startup.py')
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)

TOKEN = base64.b64encode(json.dumps({
    'a': 'a' * 32,
    't': '8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
    's': base64.b64encode(b'x' * 32).decode(),
}, separators=(',', ':')).encode()).decode()

seen = []          # every request the web process sent to the broker
tmp = tempfile.mkdtemp()
web.PRIVILEGED_SOCKET = os.path.join(tmp, 'broker.sock')


class Broker(socketserver.StreamRequestHandler):
    def handle(self):
        request = json.loads(self.rfile.readline(1025))
        seen.append(request)
        action = request.get('action')
        if action == 'status':
            reply = {'connected': False}
        elif action == 'tunnel-status':
            reply = {'enabled': False, 'message': 'Remote access is off.'}
        elif action == 'tunnel-enable':
            reply = {'enabled': True, 'message': 'Remote access is on.'}
        elif action == 'tunnel-disable':
            reply = {'enabled': False, 'message': 'Remote access is off.'}
        else:
            reply = {'error': 'Unavailable', 'status': 400}
        self.wfile.write(json.dumps(reply).encode() + b'\\n')


class UnixServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True


broker = UnixServer(web.PRIVILEGED_SOCKET, Broker)
threading.Thread(target=broker.serve_forever, daemon=True).start()
http = HTTPServer(('127.0.0.1', 0), web.Handler)
threading.Thread(target=http.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % http.server_address[1]


def call(path, body=None, length=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method='POST' if data is not None else 'GET')
    if data is not None:
        request.add_header('Content-Type', 'application/json')
    if length is not None:
        request.add_header('Content-Length', str(length))
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read().decode(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(), dict(error.headers)


result = {}
result['root'] = call('/')
result['remote'] = call('/remote')
result['remote_status'] = call('/remote-status')
result['enable'] = call('/remote-access', {'token': TOKEN})
result['enable_padded'] = call('/remote-access', {'token': '  ' + TOKEN + '\\n'})
result['reject_cert'] = call('/remote-access', {'token': '-----BEGIN PRIVATE KEY-----'})
result['reject_truncated'] = call('/remote-access', {'token': TOKEN[:-8]})
result['reject_missing'] = call('/remote-access', {})
result['reject_oversize'] = call('/remote-access', {'token': TOKEN + 'A' * 1200})
result['off'] = call('/remote-access/off', {})
result['unknown_post'] = call('/nope', {})
# /connect's own cap must be exactly where it was: a body over 512 bytes is
# still refused there, whatever the new route accepts.
result['connect_cap'] = call('/connect', {'ssid': 'x' * 32, 'password': 'y' * 400})

print(json.dumps({
    'token': TOKEN,
    'calls': result,
    'broker': seen,
    'tokens_sent': [r.get('token') for r in seen if r.get('action') == 'tunnel-enable'],
}))
`;

const run = spawnSync('python3', ['-c', HARNESS], { encoding: 'utf8', timeout: 60000 });
assert.equal(run.status, 0, `harness failed: ${run.stderr}`);
const OUT = JSON.parse(run.stdout);
const code = (name) => OUT.calls[name][0];
const text = (name) => OUT.calls[name][1];
const headers = (name) => OUT.calls[name][2];

test('the remote-access form is reachable on a route Wi-Fi state does not gate', () => {
  /* The stub broker reports connected:false, so '/' serves the picker. The
     point of /remote is the other case — after Wi-Fi comes up, '/' 303s to the
     player and the only way back to the token box is this route. It does not
     consult the broker about Wi-Fi at all. */
  assert.equal(code('remote'), 200);
  assert.match(headers('remote')['Content-Type'], /text\/html/);
  assert.match(text('remote'), /Remote access \(optional\)/);
  const asked = OUT.broker.filter((r) => r.action === 'status').length;
  assert.equal(asked, 1, 'only GET / should have asked the broker about Wi-Fi');
});

test('the token field is a password field and is never pre-filled', () => {
  for (const page of ['root', 'remote']) {
    const html = text(page);
    assert.match(html, /id="token" type="password" autocomplete="off"/);
    assert.ok(!/id="token"[^>]*value=/.test(html), `${page} pre-fills the token field`);
  }
});

test('the optional section is on the commissioning page without gating it', () => {
  const html = text('root');
  assert.match(html, /Remote access \(optional\)/);
  assert.match(html, /Continue without Wi-Fi/);
  /* Separate form, separate submit handler: nothing in the remote section can
     stop Connect or the skip link from working. */
  assert.match(html, /<form id="remote-form">/);
  assert.ok(!/id="connect"[^>]*disabled/.test(html));
});

test('a valid token reaches the broker unchanged, and a padded paste arrives stripped', () => {
  assert.equal(code('enable'), 200);
  assert.match(text('enable'), /Remote access is on\./);
  assert.deepEqual(OUT.tokens_sent, [OUT.token, OUT.token], 'both the clean and the padded paste should arrive stripped');
});

test('the token never comes back in any response body or header', () => {
  for (const name of Object.keys(OUT.calls)) {
    assert.ok(!text(name).includes(OUT.token), `${name} echoed the token in its body`);
    assert.ok(!text(name).includes(OUT.token.slice(0, 24)), `${name} echoed part of the token`);
    assert.ok(!JSON.stringify(headers(name)).includes(OUT.token.slice(0, 24)), `${name} echoed the token in a header`);
  }
});

test('malformed input is refused before the broker is touched', () => {
  for (const name of ['reject_cert', 'reject_truncated', 'reject_missing', 'reject_oversize']) {
    assert.equal(code(name), 400, `${name} should be a 400`);
    assert.match(text(name), /remote access/i, `${name} should say something a volunteer can act on`);
  }
  /* Three enables were valid (two tokens) — none of the four rejections may
     have reached the privileged side. */
  assert.equal(OUT.broker.filter((r) => r.action === 'tunnel-enable').length, 2);
});

test('turning remote access off is its own route, and reaches the broker', () => {
  assert.equal(code('off'), 200);
  assert.equal(OUT.broker.filter((r) => r.action === 'tunnel-disable').length, 1);
  assert.match(text('off'), /Remote access is off\./);
});

test('/connect keeps its own 512-byte cap, and unknown routes stay 404', () => {
  assert.equal(code('connect_cap'), 400);
  assert.equal(OUT.broker.filter((r) => r.action === 'connect').length, 0);
  assert.equal(code('unknown_post'), 404);
});

test('the new routes carry the same no-store headers as the rest', () => {
  for (const name of ['remote', 'remote_status', 'enable', 'off']) {
    const h = headers(name);
    assert.equal(h['Cache-Control'], 'no-store', `${name} is missing Cache-Control`);
    assert.equal(h['X-Content-Type-Options'], 'nosniff', `${name} is missing nosniff`);
    assert.equal(h['Referrer-Policy'], 'no-referrer', `${name} is missing Referrer-Policy`);
  }
});
