#!/usr/bin/env python3
"""Local, on-screen Wi-Fi commissioning for the kiosk."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import re
import socket

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


PAGE = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect PitchTribe to Wi-Fi</title>
<style>
body{font:18px system-ui,sans-serif;max-width:38rem;margin:8vh auto;padding:0 1.2rem;color:#17202a}
h1{font-size:1.8rem}label{display:block;margin:1.2rem 0 .4rem}select,input,button{font:inherit;padding:.7rem;width:100%;box-sizing:border-box}
button{margin-top:1rem;background:#176b45;color:white;border:0;border-radius:.4rem;cursor:pointer}
a{display:inline-block;margin-top:1.3rem;color:#176b45}#status{min-height:2rem}
</style><h1>Connect PitchTribe to Wi-Fi</h1>
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
</script></html>'''


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
        return self.send(404, 'Unavailable', 'text/plain; charset=utf-8')

    def do_POST(self):
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


if __name__ == '__main__':
    HTTPServer((HOST, PORT), Handler).serve_forever()
