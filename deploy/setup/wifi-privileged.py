#!/usr/bin/env python3
"""Root-only NetworkManager broker for the kiosk startup Wi-Fi page."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import time
import urllib.request
import uuid

DEVICE = 'wlan0'
SOCKET = '/run/pitchtribe-wifi-privileged.sock'
CONNECTION_DIR = Path('/etc/NetworkManager/system-connections')
GUEST = Path('/var/lib/pitchtribe/portal-network.json')
RADIO_LOCK = Path('/run/pitchtribe-radio.lock')
SETUP_ACTIVE = Path('/run/pitchtribe-setup/active')

# Remote access (Cloudflare Tunnel). The contract these four names form is the
# one the dashboard's own token field (PIT-236) writes against; it is recorded
# in deploy/setup/COMMISSIONING.md, which is the interface, not this file.
TUNNEL_DIR = Path('/etc/pitchtribe')
TUNNEL_ENV = TUNNEL_DIR / 'tunnel.env'
TUNNEL_UNIT = 'pitchtribe-tunnel.service'
TUNNEL_LOCK = Path('/run/pitchtribe-tunnel.lock')
# cloudflared's readiness endpoint, pinned to this address by the unit's
# --metrics flag. 200 means at least one live edge connection.
TUNNEL_READY = 'http://127.0.0.1:20241/ready'


def nm(*args, timeout=15):
    return subprocess.run(('nmcli', *args), check=True, capture_output=True,
                          text=True, timeout=timeout).stdout.strip()


def wlan_connected():
    try:
        return nm('-g', 'GENERAL.STATE', 'device', 'show', DEVICE).startswith('100')
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def systemctl(*args, timeout=30):
    return subprocess.run(('systemctl', *args), capture_output=True, text=True, timeout=timeout)


def guest_enabled():
    try:
        return json.loads(GUEST.read_text()).get('enabled') is not False
    except FileNotFoundError:
        return False
    except (ValueError, OSError):
        return True


# Verbatim copy of validate_token in wifi-startup.py, down to the wording of
# the messages. The web process has no authority, so the check is repeated
# here rather than trusted - the standing rule in the connect path below
# applies to a credential at least as much as to a Wi-Fi password.
# app/test/tunnel-token.test.js fails if the two copies ever disagree.
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


def cloudflared_env_route():
    """Refuse to provision a cloudflared that cannot read the token from its
    environment. deploy/install.sh installs the package unpinned, so this is
    checked on the card rather than assumed from a version number. Verified
    present in 2026.11.2; if a later build ever drops it, write nothing rather
    than falling back to a token on the command line, where any local user
    could read it out of /proc.
    """
    try:
        helptext = subprocess.run(('cloudflared', 'tunnel', 'run', '--help'),
                                  capture_output=True, text=True, timeout=15)
        return '--token' in (helptext.stdout + helptext.stderr)
    except (OSError, subprocess.TimeoutExpired):
        return False


def tunnel_ready():
    """True once the connector has at least one live edge connection.

    `systemctl start` returning 0 proves nothing, so this asks cloudflared.
    The response body carries a count and a connector id, never the token.
    """
    try:
        with urllib.request.urlopen(TUNNEL_READY, timeout=3) as response:
            return json.loads(response.read(4096)).get('readyConnections', 0) > 0
    except (OSError, ValueError):
        return False


def tunnel_rejected(since):
    """True if the edge refused this token - revoked centrally, rotated, or
    simply the wrong club's.

    cloudflared retries an Unauthorized registration instead of exiting
    (supervisor.go:328-333), so an active unit says nothing; the refusal is
    only visible in the journal. Only this boolean leaves the function - the
    journal text is never returned or re-logged.
    """
    try:
        journal = subprocess.run(
            ('journalctl', '-u', TUNNEL_UNIT, '--since', since, '--no-pager', '-n', '300'),
            capture_output=True, text=True, timeout=10)
        return 'Unauthorized' in journal.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False


def tunnel_write(content):
    """Atomically replace the credential file with exactly `content`.

    The O_EXCL pattern used for the Wi-Fi profile below cannot overwrite by
    design, so a replacement is written to a temp file in the same directory
    with the same flags and mode, fsynced, and renamed over the live
    EnvironmentFile. Truncating the live file in place would leave a window in
    which cloudflared can read half a credential.
    """
    TUNNEL_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TUNNEL_DIR, 0o755)
    staging = TUNNEL_DIR / ('tunnel.env.' + uuid.uuid4().hex)
    try:
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(staging, TUNNEL_ENV)
    finally:
        staging.unlink(missing_ok=True)


def tunnel_restore(previous):
    """Put the card back exactly as it was: the previous credential, or none.

    Requirement 8's no-half-states clause. A club re-entering a bad token over
    a working one must not lose the working one.
    """
    try:
        if previous is None:
            systemctl('disable', '--now', TUNNEL_UNIT)
            TUNNEL_ENV.unlink(missing_ok=True)
        else:
            tunnel_write(previous)
            systemctl('restart', TUNNEL_UNIT)
    except OSError:
        pass


def tunnel_enable(token):
    """Provision the connector from a validated token, then report what really
    happened rather than what systemctl returned."""
    previous = None
    try:
        previous = TUNNEL_ENV.read_bytes()
    except OSError:
        pass
    try:
        with TUNNEL_LOCK.open('a+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {'error': 'Remote access is already being set up. Try again shortly.', 'status': 409}
            if not cloudflared_env_route():
                return {'error': 'Remote access is not available on this device. Ask PitchTribe for help.',
                        'status': 503}
            since = time.strftime('%Y-%m-%d %H:%M:%S')
            tunnel_write(('TUNNEL_TOKEN=' + token + '\n').encode())
            if (systemctl('enable', TUNNEL_UNIT).returncode != 0
                    or systemctl('restart', TUNNEL_UNIT).returncode != 0):
                tunnel_restore(previous)
                return {'error': 'Could not start remote access. Ask PitchTribe for help.', 'status': 503}
            # Bounded, and well inside the web process's 55s socket timeout.
            deadline = time.monotonic() + 25
            while True:
                if tunnel_ready():
                    return {'enabled': True, 'message': 'Remote access is on.'}
                if tunnel_rejected(since):
                    tunnel_restore(previous)
                    return {'enabled': previous is not None,
                            'error': 'This remote access code is no longer valid. Ask PitchTribe for a new one.',
                            'status': 400}
                if time.monotonic() >= deadline:
                    break
                time.sleep(2)
    except OSError:
        tunnel_restore(previous)
        return {'error': 'Could not save the remote access code.', 'status': 500}
    # Saved and retrying. Honest, and not a failure: a token is accepted before
    # the Pi has Wi-Fi, and the connector's own retry establishes the link.
    if not wlan_connected():
        return {'enabled': True,
                'message': 'Code saved. Remote access will connect once the venue Wi-Fi is working.'}
    return {'enabled': True,
            'message': 'Code saved, but remote access has not connected yet. It keeps trying - check again in a few minutes.'}


def dispatch(request):
    action = request.get('action')
    if action == 'status':
        return {'connected': wlan_connected()}
    if action == 'tunnel-status':
        if not TUNNEL_ENV.exists():
            return {'enabled': False, 'message': 'Remote access is off.'}
        if tunnel_ready():
            return {'enabled': True, 'message': 'Remote access is on.'}
        return {'enabled': True,
                'message': 'Remote access is set up but not connected right now. It keeps trying.'}
    if action == 'tunnel-enable':
        # Validate again at the privileged boundary; never rely on the web process.
        token, problem = validate_token(request.get('token'))
        if problem:
            return {'error': problem, 'status': 400}
        return tunnel_enable(token)
    if action == 'tunnel-disable':
        # Stop before the credential goes: ConditionPathExists would make a
        # stop after the unlink look like a condition failure, not a clean stop.
        systemctl('disable', '--now', TUNNEL_UNIT)
        try:
            TUNNEL_ENV.unlink(missing_ok=True)
        except OSError:
            return {'error': 'Could not turn remote access off. Ask PitchTribe for help.', 'status': 500}
        return {'enabled': False, 'message': 'Remote access is off.'}
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
