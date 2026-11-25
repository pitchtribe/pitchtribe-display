#!/usr/bin/env python3
"""Root-only NetworkManager broker for the kiosk startup Wi-Fi page."""
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import uuid

DEVICE = 'wlan0'
SOCKET = '/run/pitchtribe-wifi-privileged.sock'
CONNECTION_DIR = Path('/etc/NetworkManager/system-connections')
GUEST = Path('/var/lib/pitchtribe/portal-network.json')
RADIO_LOCK = Path('/run/pitchtribe-radio.lock')
SETUP_ACTIVE = Path('/run/pitchtribe-setup/active')


def nm(*args, timeout=15):
    return subprocess.run(('nmcli', *args), check=True, capture_output=True,
                          text=True, timeout=timeout).stdout.strip()


def guest_enabled():
    try:
        return json.loads(GUEST.read_text()).get('enabled') is not False
    except FileNotFoundError:
        return False
    except (ValueError, OSError):
        return True


def dispatch(request):
    action = request.get('action')
    if action == 'status':
        try:
            return {'connected': nm('-g', 'GENERAL.STATE', 'device', 'show', DEVICE).startswith('100')}
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return {'connected': False}
    if action == 'scan':
        if guest_enabled():
            return {'error': 'Wi-Fi setup is unavailable while Guest Wi-Fi is active.', 'status': 409}
        try:
            # NetworkManager can leave its software radio switch off after a
            # prior setup or administrative change. The startup picker owns
            # station Wi-Fi only when the guest portal is disabled, so turn
            # that switch on before asking it to scan. A hardware block still
            # fails closed and is reported through the normal scan error.
            nm('radio', 'wifi', 'on')
            output = nm('-t', '-f', 'SSID', 'device', 'wifi', 'list', 'ifname', DEVICE, timeout=12)
            return {'networks': sorted({line.replace('\\:', ':') for line in output.splitlines()
                                        if line and len(line) <= 32})[:50]}
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return {'error': 'Wi-Fi scan failed. Check the adapter and try again.', 'status': 503}
    if action != 'connect':
        return {'error': 'Unavailable', 'status': 400}

    # Validate again at the privileged boundary; never rely on the web process.
    ssid, password = request.get('ssid'), request.get('password')
    if (not isinstance(ssid, str) or not re.fullmatch(r'[\x20-\x7e]{1,32}', ssid)
            or any(c in ssid for c in '=;\\') or not isinstance(password, str)
            or not 8 <= len(password) <= 63 or any(ord(c) < 32 or ord(c) > 126 for c in password)):
        return {'error': 'Enter a valid Wi-Fi name and WPA password.', 'status': 400}
    profile_uuid = None
    profile = None
    try:
        # Lock across the complete radio transition and recheck after acquiring it.
        with RADIO_LOCK.open('a+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {'error': 'The Wi-Fi radio is busy. Try again shortly.', 'status': 409}
            if guest_enabled() or SETUP_ACTIVE.exists() or subprocess.run(
                    ('systemctl', 'is-active', '--quiet', 'hostapd.service')).returncode == 0:
                return {'error': 'Wi-Fi setup is unavailable while Guest Wi-Fi or setup mode is active.', 'status': 409}
            profile_uuid = str(uuid.uuid4())
            profile = CONNECTION_DIR / ('pitchtribe-venue-' + profile_uuid + '.nmconnection')
            content = ('[connection]\n' f'id=PitchTribe Venue Wi-Fi {profile_uuid}\n'
                       f'uuid={profile_uuid}\n' 'type=wifi\n' f'interface-name={DEVICE}\n'
                       'autoconnect=true\n\n[wifi]\n' f'ssid={ssid}\n' 'mode=infrastructure\n\n'
                       '[wifi-security]\nkey-mgmt=wpa-psk\n' f'psk={password}\n\n'
                       '[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n')
            fd = os.open(profile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            nm('connection', 'load', str(profile), timeout=15)
            nm('connection', 'up', 'uuid', profile_uuid, 'ifname', DEVICE, timeout=45)
        return {'connected': True}
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        if profile_uuid:
            subprocess.run(('nmcli', 'connection', 'delete', 'uuid', profile_uuid),
                           capture_output=True, timeout=10)
            if profile:
                profile.unlink(missing_ok=True)
        return {'error': 'Could not connect. Check the password and try again.', 'status': 503}


class RequestHandler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            raw = self.rfile.readline(1025)
            if len(raw) > 1024 or not raw.endswith(b'\n'):
                return
            request = json.loads(raw)
            response = dispatch(request) if isinstance(request, dict) else {'error': 'Unavailable', 'status': 400}
            self.wfile.write(json.dumps(response, separators=(',', ':')).encode() + b'\n')
        except (ValueError, OSError):
            pass


class UnixServer(socketserver.UnixStreamServer):
    allow_reuse_address = True


if __name__ == '__main__':
    try:
        os.unlink(SOCKET)
    except FileNotFoundError:
        pass
    server = UnixServer(SOCKET, RequestHandler)
    os.chmod(SOCKET, 0o660)
    import grp
    os.chown(SOCKET, 0, grp.getgrnam('pitchtribe-wifi').gr_gid)
    server.serve_forever()
