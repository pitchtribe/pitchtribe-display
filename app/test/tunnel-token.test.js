'use strict';
/* The connector-token validator, which is the only thing standing between a
   club pasting the wrong string and a credential on disk. There was no
   automated coverage for deploy/setup/*.py before this file; the validator is
   a pure function, so it gets some.

   Three things are tested here. First the decisions themselves, against tokens
   built to the real shape (base64 of {"a":account,"t":tunnel id,"s":secret} —
   cloudflared connection/connection.go:81-86). Second, that the copy in
   wifi-privileged.py agrees with the copy in wifi-startup.py on every case.
   Third, that the JS copy in bin/remote-access.js (validateTunnelToken) agrees
   with both Python copies — the broker deliberately repeats the check instead
   of trusting the web process, and a duplicated check that silently drifts is
   worse than no second check at all. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateTunnelToken } = require('../bin/remote-access');

const SETUP = path.join(__dirname, '..', '..', 'deploy', 'setup');

/** Run both copies of validate_token over the cases and return their verdicts.
    Python does the work because the validator is Python; this keeps the test
    honest about what actually ships rather than re-implementing the rules in
    JavaScript and testing the re-implementation. */
function verdicts(cases) {
  const script = `
import base64, json, importlib.util, sys

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ${JSON.stringify(SETUP)} + '/' + name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

web = load('wifi-startup.py')
broker = load('wifi-privileged.py')

def token(account='a' * 32, tunnel='8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8', secret_bytes=32, extra=None):
    claims = {'a': account, 't': tunnel, 's': base64.b64encode(b'x' * secret_bytes).decode()}
    if extra:
        claims.update(extra)
    return base64.b64encode(json.dumps(claims, separators=(',', ':')).encode()).decode()

cases = json.loads(sys.stdin.read())
out = []
for case in cases:
    raw = eval(case['raw']) if case.get('python') else case['raw']
    web_token, web_problem = web.validate_token(raw)
    broker_token, broker_problem = broker.validate_token(raw)
    out.append({
        'name': case['name'],
        'raw_string': raw,
        'accepted': web_problem is None,
        'message': web_problem,
        'token': web_token,
        'agree': (web_token, web_problem) == (broker_token, broker_problem),
    })
print(json.dumps(out))
`;
  const run = spawnSync('python3', ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(run.status, 0, `python3 failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/* `python: true` means raw is a Python expression evaluated next to the token()
   helper above, so a case can build a real token. Everything else is a literal
   string, which is what a club actually pastes. */
const CASES = [
  { name: 'a real connector token', raw: 'token()', python: true, accept: true },
  { name: 'a 64-byte secret', raw: 'token(secret_bytes=64)', python: true, accept: true },
  { name: 'the optional endpoint field', raw: "token(extra={'e': 'fed'})", python: true, accept: true },
  { name: 'surrounding whitespace from a paste', raw: "'  ' + token() + '\\n'", python: true, accept: true },
  { name: 'empty', raw: '', accept: false },
  { name: 'whitespace only', raw: '   ', accept: false },
  { name: 'a cert.pem', raw: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----', accept: false },
  { name: 'a Cloudflare API token', raw: 'v1.0-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', accept: false },
  { name: 'a credentials file, base64d', raw: "base64.b64encode(json.dumps({'AccountTag': 'a' * 32, 'TunnelSecret': 'x' * 44, 'TunnelID': '8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8'}).encode()).decode()", python: true, accept: false },
  { name: 'base64 of something that is not JSON', raw: "base64.b64encode(b'n' * 200).decode()", python: true, accept: false },
  { name: 'a token with its last characters lost', raw: 'token()[:-8]', python: true, accept: false },
  { name: 'a token pasted twice', raw: 'token() * 2', python: true, accept: false },
  { name: 'a base64url-mangled token', raw: "token().replace('I', '-', 1)", python: true, accept: false },
  { name: 'unpadded base64', raw: "token().rstrip('=')", python: true, accept: false },
  { name: 'the right shape but a tunnel id that is not a UUID', raw: "token(tunnel='not-a-uuid')", python: true, accept: false },
  { name: 'JSON missing the account field', raw: "base64.b64encode(json.dumps({'t': '8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8', 's': base64.b64encode(b'x' * 32).decode()}).encode()).decode()", python: true, accept: false },
  { name: 'an empty account field', raw: "token(account='')", python: true, accept: false },
  { name: 'a number instead of a string', raw: '12345', python: true, accept: false },
  { name: 'None', raw: 'None', python: true, accept: false },
];

const RESULTS = verdicts(CASES);

test('the validator accepts real connector tokens and nothing else', () => {
  for (const [index, expected] of CASES.entries()) {
    const got = RESULTS[index];
    assert.equal(got.accepted, expected.accept, `${expected.name}: expected accept=${expected.accept}, got ${got.accepted} (${got.message})`);
  }
});

test('both boundaries agree on every case', () => {
  /* wifi-privileged.py is the one with authority. If it ever disagrees with
     wifi-startup.py, one of the two copies has been edited alone. */
  const drifted = RESULTS.filter((r) => !r.agree).map((r) => r.name);
  assert.deepEqual(drifted, [], `the web and broker copies of validate_token disagree on: ${drifted.join(', ')}`);
});

test('an accepted token comes back stripped, and is otherwise untouched', () => {
  /* The broker writes exactly what comes back out of here into the
     EnvironmentFile, so a stray newline from a paste has to be gone by this
     point and nothing else may have changed. */
  const clean = RESULTS[0];
  const pasted = RESULTS[3];
  assert.equal(pasted.accepted, true);
  assert.equal(pasted.token, clean.token);
  assert.match(pasted.token, /^eyJ[A-Za-z0-9]+={0,2}$/);
});

test('no rejection message quotes the token back', () => {
  /* A message that echoes what was typed puts the credential into the HTML,
     and into whatever the browser or the TV does with it afterwards. */
  for (const result of RESULTS) {
    if (result.accepted) continue;
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0, 'a rejection must say something a volunteer can act on');
    assert.ok(!/ey[A-Za-z0-9]{10}/.test(result.message), `message quotes the token: ${result.message}`);
    assert.ok(!/BEGIN|v1\.0-/.test(result.message), `message quotes the input: ${result.message}`);
  }
});

test('the JS validator (validateTunnelToken) agrees with both Python copies on every case', () => {
  /* The broker runs validateTunnelToken at the HTTP boundary AND the privileged
     boundary. If the JS copy drifts from the Python copies, one boundary
     accepts what the other rejects. */
  const drifted = [];
  for (const result of RESULTS) {
    const { error, token: jsToken } = validateTunnelToken(result.raw_string);
    const jsAccepted = error === undefined;
    if (jsAccepted !== result.accepted) {
      drifted.push(`${result.name}: Python says accept=${result.accepted}, JS says accept=${jsAccepted}`);
    }
    // When both accept, both should return exactly the same (trimmed) token.
    if (result.accepted && jsAccepted && jsToken !== result.token) {
      drifted.push(`${result.name}: Python token=${result.token}, JS token=${jsToken}`);
    }
  }
  assert.deepEqual(drifted, [], `JS and Python copies disagree:\n  ${drifted.join('\n  ')}`);
});
