#!/usr/bin/env python3
"""Local, on-screen Wi-Fi commissioning for the kiosk."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import base64
import json
import os
import re
import socket
import uuid

DEVICE = 'wlan0'
HOST = '127.0.0.1'
PORT = 8090
PRIVILEGED_SOCKET = '/run/pitchtribe-wifi-privileged.sock'
SCREEN_ID = re.sub(r'[^a-zA-Z0-9_-]', '-', os.uname().nodename)
PLAYER = os.environ.get('PITCHTRIBE_URL', 'http://localhost/player/?screen=@HOSTNAME@').replace('@HOSTNAME@', SCREEN_ID)


def privileged(request):
    """Use the filesystem-protected root broker; HTTP headers confer no authority."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(55)
        client.connect(PRIVILEGED_SOCKET)
        client.sendall(json.dumps(request, separators=(',', ':')).encode() + b'\n')
        stream = client.makefile('rb')
        response = stream.readline(4097)
        if len(response) > 4096 or not response.endswith(b'\n'):
            raise OSError('invalid privileged response')
        return json.loads(response)


def wifi_connected():
    try:
        return privileged({'action': 'status'}).get('connected') is True
    except (OSError, ValueError):
        return False


# A Cloudflare connector token is standard base64 of
# {"a":account,"t":tunnel id,"s":tunnel secret} (cloudflared 2026.11.2,
# connection/connection.go:81-86). Real tokens are 180-252 characters, and
# because they are base64 of all-ASCII JSON they can never contain '+' or '/',
# so the stricter alphabet below is safe - a '-' or '_' means something other
# than a connector token was pasted. The measurements and the proof are in
# deliverables/pit-231/TUNNEL-TOKEN-STORAGE-CONTRACT.md.
#
# validate_token is duplicated verbatim in wifi-privileged.py. That is on
# purpose: this process has no authority, so the broker repeats the check
# rather than trusting it. app/test/tunnel-token.test.js fails if the two
# copies ever disagree.
TOKEN_CHARS = re.compile(r'[A-Za-z0-9]+={0,2}')
TOKEN_MIN, TOKEN_MAX = 120, 512
TOKEN_HELP = ('That is not a PitchTribe remote access token. It is one long code starting '
              'eyJ, sent to you by PitchTribe.')


def validate_token(raw):
    """Check a connector token. Returns (token, None) or (None, message).

    Never put the token, or any part of it, into the returned message.
    """
    if not isinstance(raw, str):
        return None, TOKEN_HELP
    token = raw.strip()
    if not token:
        return None, 'Paste the remote access token PitchTribe sent you.'
    if not token.startswith('eyJ') or not TOKEN_CHARS.fullmatch(token) or len(token) % 4:
        return None, TOKEN_HELP
    if not TOKEN_MIN <= len(token) <= TOKEN_MAX:
        return None, ('That code is the wrong length for a remote access token. '
                      'Check the whole code was copied.')
    try:
        claims = json.loads(base64.b64decode(token, validate=True))
        account, tunnel, secret = claims['a'], claims['t'], claims['s']
        uuid.UUID(tunnel)
        base64.b64decode(secret, validate=True)
    except (ValueError, TypeError, KeyError):
        # Deliberately not reporting the cause: an exception message here can
        # carry the pasted credential into a response or a log.
        return None, TOKEN_HELP
    if not (isinstance(account, str) and account and isinstance(secret, str) and secret):
        return None, TOKEN_HELP
    return token, None


STYLE = '''<style>
body{font:18px system-ui,sans-serif;max-width:38rem;margin:8vh auto;padding:0 1.2rem;color:#17202a}
h1{font-size:1.8rem}label{display:block;margin:1.2rem 0 .4rem}select,input,button{font:inherit;padding:.7rem;width:100%;box-sizing:border-box}
button{margin-top:1rem;background:#176b45;color:white;border:0;border-radius:.4rem;cursor:pointer}
a{display:inline-block;margin-top:1.3rem;color:#176b45}#status{min-height:2rem}
#remote{margin-top:2.6rem;border-top:1px solid #d7dee6;padding-top:.6rem}
#remote h2{font-size:1.15rem;color:#4a5560}#remote-status{min-height:2rem}
#remote-off{background:#eef1f4;color:#17202a}
</style>'''

# Deliberately secondary, and never required: no Connect button and no
# "Continue without Wi-Fi" depends on anything in here.
REMOTE_SECTION = '''<section id="remote"><h2>Remote access (optional)</h2>
<p>Only fill this in if PitchTribe sent you a remote access code. It lets PitchTribe open this
club&rsquo;s dashboard from outside the building to help you. Everything on the TV works without it,
and you can add it later.</p>
<form id="remote-form"><label for="token">Remote access code</label>
<input id="token" type="password" autocomplete="off" spellcheck="false" required>
<button id="remote-enable">Turn remote access on</button></form>
<p id="remote-status" role="status" aria-live="polite"></p>
<button id="remote-off" type="button" hidden>Turn remote access off</button></section>
<script>
const tokenField=document.querySelector('#token'),remoteStatus=document.querySelector('#remote-status'),
  remoteEnable=document.querySelector('#remote-enable'),remoteOff=document.querySelector('#remote-off');
function showRemote(d,fallback){remoteStatus.textContent=d.message||d.error||fallback;remoteOff.hidden=d.enabled!==true}
async function remoteRefresh(){try{const r=await fetch('/remote-status',{cache:'no-store'});showRemote(await r.json(),'')}catch(err){remoteStatus.textContent=''}}
async function remotePost(path,body,busy){remoteEnable.disabled=remoteOff.disabled=true;remoteStatus.textContent=busy;
  try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();showRemote(d,'Could not change remote access. Try again.');if(r.ok)tokenField.value=''}
  catch(err){remoteStatus.textContent='Could not reach the setup helper. Try again shortly.'}
  finally{remoteEnable.disabled=remoteOff.disabled=false}}
document.querySelector('#remote-form').addEventListener('submit',e=>{e.preventDefault();
  remotePost('/remote-access',{token:tokenField.value},'Checking the code…')});
remoteOff.addEventListener('click',()=>remotePost('/remote-access/off',{},'Turning remote access off…'));
remoteRefresh();
</script>'''

PAGE = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect PitchTribe to Wi-Fi</title>
''' + STYLE + '''<h1>Connect PitchTribe to Wi-Fi</h1>
<p>Choose your venue’s WPA/WPA2 Personal Wi-Fi network and enter its password. PitchTribe will open when it connects.</p>
<form id="wifi"><label for="ssid">Wi-Fi network</label><select id="ssid" required></select><button id="rescan" type="button">Scan again</button>
<label for="password">Wi-Fi password</label><input id="password" type="password" autocomplete="off" required minlength="8" maxlength="63">
<button id="connect">Connect</button></form><p id="status" role="status" aria-live="polite"></p>
<a href="/player">Continue without Wi-Fi</a>
<script>
const select=document.querySelector('#ssid'),status=document.querySelector('#status'),button=document.querySelector('#connect');
async function refresh(){status.textContent='Searching for nearby networks…';try{const r=await fetch('/scan',{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not scan for networks. Try again.');select.replaceChildren();for(const name of d.networks){const o=document.createElement('option');o.value=name;o.textContent=name;select.append(o)}if(!d.networks.length)status.textContent='No networks found. Check the Wi-Fi adapter and try again.';else status.textContent='Choose your venue network.'}catch(err){status.textContent=err.message||'Could not scan for networks. Try again.'}}
document.querySelector('#wifi').addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;status.textContent='Connecting…';try{const r=await fetch('/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:select.value,password:document.querySelector('#password').value})});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not connect. Check the password and try again.');status.textContent='Connected. Opening PitchTribe…';location.href='/player'}catch(err){status.textContent=err.message}finally{button.disabled=false}});
refresh();
document.querySelector('#rescan').addEventListener('click',refresh);
</script>''' + REMOTE_SECTION + '''</html>'''

# The same section on a route of its own. '/' is only served while wlan0 is
# down (it 303s to the player once Wi-Fi is up), and a connector needs the
# internet, so the box on '/' alone would only ever be reachable before the Pi
# had any connectivity. This page is not gated by wifi_connected().
REMOTE_PAGE = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PitchTribe remote access</title>
''' + STYLE + '''<h1>PitchTribe remote access</h1>
<a href="/player">Back to PitchTribe</a>
''' + REMOTE_SECTION + '''</html>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, code, body, content_type='application/json; charset=utf-8'):
        data = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/':
            if wifi_connected():
                self.send_response(303)
                self.send_header('Location', PLAYER)
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                return
            return self.send(200, PAGE, 'text/html; charset=utf-8')
        if self.path == '/player':
            self.send_response(303)
            self.send_header('Location', PLAYER)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return
        if self.path == '/scan':
            try:
                result = privileged({'action': 'scan'})
                code = result.pop('status', 200)
                return self.send(code, json.dumps(result))
            except (OSError, ValueError):
                return self.send(503, json.dumps({'error': 'Wi-Fi scan failed. Check the adapter and try again.'}))
        if self.path == '/remote':
            return self.send(200, REMOTE_PAGE, 'text/html; charset=utf-8')
        if self.path == '/remote-status':
            try:
                result = privileged({'action': 'tunnel-status'})
                code = result.pop('status', 200)
                return self.send(code, json.dumps(result))
            except (OSError, ValueError):
                return self.send(503, json.dumps({'error': 'Remote access helper is unavailable. Try again shortly.'}))
        return self.send(404, 'Unavailable', 'text/plain; charset=utf-8')

    def do_POST(self):
        if self.path == '/remote-access':
            return self.remote_access()
        if self.path == '/remote-access/off':
            return self.remote_off()
        if self.path != '/connect':
            return self.send(404, 'Unavailable')
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 512:
                raise ValueError()
            data = json.loads(self.rfile.read(size))
            ssid, password = data['ssid'], data['password']
            if not isinstance(ssid, str) or not re.fullmatch(r'[\x20-\x7e]{1,32}', ssid) or any(c in ssid for c in '=;\\'):
                raise ValueError()
            if not isinstance(password, str) or not 8 <= len(password) <= 63 or any(ord(c) < 32 or ord(c) > 126 for c in password):
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError):
            return self.send(400, json.dumps({'error': 'Enter a valid Wi-Fi name and WPA password.'}))
        try:
            result = privileged({'action': 'connect', 'ssid': ssid, 'password': password})
            code = result.pop('status', 200)
            return self.send(code, json.dumps(result))
        except (OSError, ValueError):
            return self.send(503, json.dumps({'error': 'Wi-Fi setup helper is unavailable. Try again shortly.'}))

    def remote_access(self):
        """Accept a connector token. Never echo it back, and never log it."""
        try:
            size = int(self.headers.get('Content-Length', '0'))
            # Per-route bound, like /connect's. A connector token is 180-252
            # characters, so this body is at most 264 bytes (measured in
            # deliverables/pit-231/TUNNEL-TOKEN-STORAGE-CONTRACT.md); 1024
            # leaves about four times that and still frames well inside the
            # broker's own 1024-byte request cap. /connect's 512 is untouched.
            if not 0 < size <= 1024:
                raise ValueError()
            token = json.loads(self.rfile.read(size)).get('token')
        except (ValueError, TypeError, AttributeError, UnicodeError):
            return self.send(400, json.dumps({'error': TOKEN_HELP}))
        token, problem = validate_token(token)
        if problem:
            return self.send(400, json.dumps({'error': problem}))
        try:
            result = privileged({'action': 'tunnel-enable', 'token': token})
            code = result.pop('status', 200)
            return self.send(code, json.dumps(result))
        except (OSError, ValueError):
            return self.send(503, json.dumps({'error': 'Remote access helper is unavailable. Try again shortly.'}))

    def remote_off(self):
        try:
            result = privileged({'action': 'tunnel-disable'})
            code = result.pop('status', 200)
            return self.send(code, json.dumps(result))
        except (OSError, ValueError):
            return self.send(503, json.dumps({'error': 'Remote access helper is unavailable. Try again shortly.'}))


if __name__ == '__main__':
    HTTPServer((HOST, PORT), Handler).serve_forever()
