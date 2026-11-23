#!/usr/bin/env python3
"""Physical-button Wi-Fi commissioning on one NetworkManager-managed radio."""
import fcntl
from http.server import BaseHTTPRequestHandler, HTTPServer
import html
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import subprocess
import sys
import time
import urllib.parse
import uuid

from gpiozero import Button

RUNTIME = Path('/run/pitchtribe-setup')
ACTIVE = RUNTIME / 'active'
LOCK = Path('/run/pitchtribe-radio.lock')
NM_DIR = Path('/etc/NetworkManager/system-connections')
GUEST = Path('/var/lib/pitchtribe/portal-network.json')
ADDR = '10.77.0.1'
DEVICE = 'wlan0'
WINDOW = 300


def nm(*args, timeout=25):
    return subprocess.run(('nmcli', *args), check=True, capture_output=True,
                          text=True, timeout=timeout).stdout


def file_atomic(path, content):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def identity():
    spec = importlib.util.spec_from_file_location('identity', '/usr/local/lib/pitchtribe/setup-identity.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.checked()


def guest_enabled():
    if not GUEST.exists():
        return False
    # A malformed guest configuration is a conflict, never permission to start.
    return json.loads(GUEST.read_text()).get('enabled') is not False


def keyfile(profile_id, profile_uuid, ssid, key, ap):
    # NM keyfile values must not contain delimiters or control characters.
    if not re.fullmatch(r'[\x20-\x7e]{1,32}', ssid) or any(c in ssid for c in '=;\\'):
        raise ValueError('invalid SSID')
    if not 8 <= len(key) <= 63 or any(ord(c) < 32 or ord(c) > 126 or c in '\n\r' for c in key):
        raise ValueError('invalid WPA passphrase')
    lines = ['[connection]', f'id={profile_id}', f'uuid={profile_uuid}',
             'type=wifi', f'interface-name={DEVICE}',
             'autoconnect=false' if ap else 'autoconnect=true',
             '' if ap else 'autoconnect-priority=100', '',
             '[wifi]', f'ssid={ssid}', f'mode={"ap" if ap else "infrastructure"}',
             'band=bg' if ap else '', '', '[wifi-security]', 'key-mgmt=wpa-psk',
             f'psk={key}', '', '[ipv4]', 'method=shared' if ap else 'method=auto',
             f'address1={ADDR}/24' if ap else '', '', '[ipv6]', 'method=disabled' if ap else 'method=auto', '']
    return '\n'.join(lines) + '\n'


def station_ready(profile_uuid):
    try:
        out = nm('-f', 'GENERAL.CONNECTION,IP4.ADDRESS', 'device', 'show', DEVICE)
        return profile_uuid in nm('-g', 'UUID', 'connection', 'show', '--active') and 'IP4.ADDRESS' in out
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


class Server(HTTPServer):
    allow_reuse_address = False

    def __init__(self, controller):
        super().__init__((ADDR, 8088), Handler)
        self.controller = controller
        self.timeout = 1


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def allowed(self):
        try:
            return (ipaddress.ip_address(self.client_address[0]) in ipaddress.ip_network('10.77.0.0/24')
                    and self.headers.get('Host') == f'{ADDR}:8088'
                    and time.monotonic() < self.server.controller.deadline)
        except ValueError:
            return False

    def send_page(self, code, body):
        data = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.allowed() or self.path != '/':
            return self.send_page(404, 'Unavailable')
        controller = self.server.controller
        names = controller.nearby
        choices = ''.join(f'<option value="{html.escape(x, quote=True)}">' for x in names)
        self.send_page(200, '<!doctype html><meta name="viewport" content="width=device-width">'
                       '<title>PitchTribe Wi-Fi setup</title><h1>Connect to club Wi-Fi</h1>'
                       '<p>Choose a nearby network or type its name. This setup window lasts five minutes.</p>'
                       '<form method="post" action="/connect" autocomplete="off">'
                       f'<input type="hidden" name="nonce" value="{controller.nonce}">'
                       f'<label>Wi-Fi name <input name="ssid" list="nearby" required maxlength="32"></label><datalist id="nearby">{choices}</datalist>'
                       '<label>Password <input name="password" type="password" required minlength="8" maxlength="63"></label>'
                       '<button type="submit">Connect</button></form>'
                       '<p>If connection fails, hold the physical setup button again for three seconds.</p>')

    def do_POST(self):
        if not self.allowed() or self.path != '/connect' or self.headers.get('Origin') not in (None, f'http://{ADDR}:8088'):
            return self.send_page(404, 'Unavailable')
        if self.headers.get('Content-Type') != 'application/x-www-form-urlencoded':
            return self.send_page(415, 'Unsupported form')
        try:
            size = int(self.headers.get('Content-Length', '-1'))
            if not 0 < size <= 512:
                raise ValueError()
            fields = urllib.parse.parse_qs(self.rfile.read(size).decode('utf-8'), strict_parsing=True)
            if set(fields) != {'nonce', 'ssid', 'password'} or any(len(v) != 1 for v in fields.values()):
                raise ValueError()
            controller = self.server.controller
            if not secrets.compare_digest(fields['nonce'][0], controller.nonce):
                raise ValueError()
            profile = keyfile('PitchTribe Club Wi-Fi', str(uuid.uuid4()), fields['ssid'][0], fields['password'][0], False)
        except (ValueError, UnicodeError, KeyError):
            return self.send_page(400, 'Invalid form. Reopen setup and try again.')
        controller.nonce = ''  # Single use, including failed association.
        self.send_page(200, 'Connecting. Your phone will disconnect from setup Wi-Fi. If the Pi does not join, hold the setup button again.')
        controller.pending = profile


def run_window(data):
    if guest_enabled() or subprocess.run(('systemctl', 'is-active', '--quiet', 'hostapd.service')).returncode == 0:
        return
    if 'unmanaged' in nm('-g', 'GENERAL.STATE', 'device', 'show', DEVICE).lower():
        return
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    previous_uuid = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', DEVICE).strip()
    try:
        scan = nm('-t', '-f', 'SSID', 'device', 'wifi', 'list', 'ifname', DEVICE, timeout=12)
        nearby = sorted({x.replace('\\:', ':') for x in scan.splitlines() if x and len(x) <= 32})[:40]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        nearby = []
    ap_uuid = str(uuid.uuid4())
    ap_file = RUNTIME / 'setup.nmconnection'
    controller = type('Controller', (), {})()
    controller.nonce = secrets.token_urlsafe(32)
    controller.deadline = time.monotonic() + WINDOW
    controller.pending = None
    controller.nearby = nearby
    connected = False
    file_atomic(ap_file, keyfile('PitchTribe Temporary Setup', ap_uuid, data['ssid'], data['key'], True))
    file_atomic(ACTIVE, 'active\n')
    server = None
    serial = None
    try:
        ready_r, ready_w = os.pipe2(os.O_CLOEXEC)
        try:
            serial = subprocess.Popen(('/usr/local/lib/pitchtribe/setup-serial.py',),
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, pass_fds=(ready_w,),
                                      env={**os.environ, 'PITCHTRIBE_READY_FD': str(ready_w)})
        finally:
            os.close(ready_w)
        try:
            if not select.select((ready_r,), (), (), 5)[0] or os.read(ready_r, 1) != b'1':
                raise RuntimeError('owner UART unavailable')
        finally:
            os.close(ready_r)
        nm('connection', 'load', str(ap_file))
        nm('connection', 'up', 'uuid', ap_uuid, 'ifname', DEVICE, timeout=35)
        server = Server(controller)
        while time.monotonic() < controller.deadline and controller.pending is None:
            server.handle_request()
        if controller.pending is not None:
            server.server_close()
            server = None
            station_uuid = re.search(r'^uuid=(.+)$', controller.pending, re.M).group(1)
            profile_file = NM_DIR / ('pitchtribe-club-' + station_uuid + '.nmconnection')
            try:
                file_atomic(profile_file, controller.pending)
                nm('connection', 'load', str(profile_file))
                nm('connection', 'up', 'uuid', station_uuid, 'ifname', DEVICE, timeout=45)
                for _ in range(20):
                    if station_ready(station_uuid):
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('station did not acquire address')
                connected = True
                # An existing valid profile is retained until the new one succeeds.
            except Exception:
                if profile_file.exists():
                    subprocess.run(('nmcli', 'connection', 'delete', 'uuid', station_uuid), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                profile_file.unlink(missing_ok=True)
                raise
    finally:
        if server:
            server.server_close()
        subprocess.run(('nmcli', 'connection', 'down', 'uuid', ap_uuid), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(('nmcli', 'connection', 'delete', 'uuid', ap_uuid), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ap_file.unlink(missing_ok=True)
        ACTIVE.unlink(missing_ok=True)
        if serial and serial.poll() is None:
            serial.terminate()
            try:
                serial.wait(timeout=3)
            except subprocess.TimeoutExpired:
                serial.kill()
                serial.wait()
        subprocess.run(('dtoverlay', '-r', 'uart0'), stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        if not connected and previous_uuid and previous_uuid != ap_uuid:
            subprocess.run(('nmcli', 'connection', 'up', 'uuid', previous_uuid, 'ifname', DEVICE),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=35)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    if len(sys.argv) == 2 and sys.argv[1] == 'cleanup':
        cleanup_stale()
        return
    if len(sys.argv) != 1:
        raise RuntimeError('invalid setup command')
    data = identity()
    def stop(_number, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    button = Button(17, pull_up=True, bounce_time=0.05)
    try:
        while True:
            button.wait_for_press()
            start = time.monotonic()
            while button.is_pressed and time.monotonic() - start < 3:
                time.sleep(0.02)
            if button.is_pressed and time.monotonic() - start >= 3:
                with LOCK.open('a+') as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        run_window(data)
                    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                        print('setup window failed; press button to retry', flush=True)
            while button.is_pressed:
                time.sleep(0.05)
    finally:
        button.close()


def cleanup_stale():
    # systemd invokes this on restart and stop, including after a forced kill.
    for args in (('nmcli', 'connection', 'down', 'id', 'PitchTribe Temporary Setup'),
                 ('nmcli', 'connection', 'delete', 'id', 'PitchTribe Temporary Setup'),
                 ('dtoverlay', '-r', 'uart0')):
        subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (RUNTIME / 'setup.nmconnection').unlink(missing_ok=True)
    ACTIVE.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
