# Pi 4 setup hardware and bench record

This is an operator procedure. The phone-facing setup flow needs QA review and
physical commissioning before release.
Pi 4 commissioning is required for the release gate. Pi 5 commissioning is an
optional compatibility check and is not a mandatory runbook requirement.

## Accepted security evidence and model waiver

PIT-188 accepted the supplied Pi 4 authorization evidence for the reviewed
startup Wi-Fi credential flow. The Security reviewer formally waived Pi 5
commissioning as a release requirement. Pi 5 remains untested; the waiver does
not represent Pi 5 compatibility or runtime evidence. The approval is limited
to the reviewed Pi 4 evidence and the waived Pi 5 gate. Keep any optional Pi 5
compatibility results separate from the required Pi 4 evidence.

## Wiring and owner retrieval

- Fit a normally-open momentary switch between BCM GPIO17 (header pin 11) and
  ground (header pin 6). The input uses its internal pull-up. Do not connect 5 V.
- Attach a **3.3 V** USB UART receiver to GPIO14 TX (pin 8) and ground (pin 6).
  Leave the adapter TX disconnected. Use 115200 8N1 and keep the serial receiver
  in the owner's custody; the AP key appears only there. Do not point the
  receiver at a public screen or capture its output in shared logs.
- Hold the button continuously for at least three seconds. A 50 ms debounce
  filters switch bounce. The setup SSID and key are transmitted over UART for
  the local owner. The UART overlay is removed after 20 seconds, and serial
  login remains masked. A short hold must produce no output.
- The first boot creates `/var/lib/pitchtribe-setup/identity.json` as root:root
  mode 0600 in a root-owned 0700 directory. The shared image has no key. An
  upgrade preserves it. After a deliberate local rotation, retrieve the new
  label and key over UART; rotation is rejected during an active setup window.

## Remote access (optional)

The commissioning page has a **Remote access (optional)** section with one
field. It is optional in the full sense: it never gates Connect, it never gates
Continue without Wi-Fi, and a card with nothing typed into it is a finished,
supported card. Everything on the TV works without it.

**Where the code comes from.** PitchTribe mints one Cloudflare Tunnel per club
in our own Zero Trust account and hands the club exactly one string — their
connector token, a long code starting `eyJ`. The club never signs in to
Cloudflare, never creates a tunnel and never sees an API token. The procedure
that produces it is `deliverables/pit-229/CLUB-TUNNEL-PROVISIONING.md`. The
field accepts that token and nothing else: a `cert.pem`, a Cloudflare API
token or an account-wide credential is refused with a message saying what was
expected.

**What entering it does.** It lets PitchTribe reach this club's dashboard from
outside the building to help them. It publishes nothing by itself: the tunnel
is remotely managed, so there is no `config.yml` on the card, and what the
tunnel serves — hostname, ingress, Access policy — lives in our account and is
already configured before the club is handed a token.

**Where to type it.** Either front door; they write the same file through the
same root broker.

- On the TV at commissioning: the section on `http://127.0.0.1:8090/`, or
  `/remote` on the same listener. `/remote` exists because `/` is only served
  while `wlan0` is down — once Wi-Fi is up it redirects to the player — and a
  connector needs the internet, so the token box has to stay reachable after
  the network works.
- In the dashboard: Settings → Remote access (PIT-236).

**A code can be entered before the Wi-Fi works.** That is the normal order on
a bench. The page says *"Code saved. Remote access will connect once the venue
Wi-Fi is working"* and means it — the connector retries on its own and the link
comes up later with nothing more to do.

**Re-entering a code replaces the old one.** There is no "change" flow and no
need to turn it off first. A replacement is written to a temporary file in the
same directory and renamed over the live one, so there is no moment at which
the connector can read half a credential. If the new code turns out to be
invalid, the card is put back exactly as it was, including a previously working
code.

**Turning remote access back off.** Press **Turn remote access off** in the
same section, on the page or in the dashboard. That disables and stops
`pitchtribe-tunnel.service` and deletes the credential; nothing is left behind
and the club can re-enter a code later. On a card with a shell, the equivalent
is:

```sh
sudo systemctl disable --now pitchtribe-tunnel.service
sudo rm -f /etc/pitchtribe/tunnel.env
```

In that order: the unit has `ConditionPathExists` on the credential, so
stopping it after the file is gone reads as a condition failure instead of a
clean stop. Taking a club's access away centrally is separate and does not
need the card at all — we rotate the tunnel secret or delete the tunnel, and
the code on the card stops working. A revoked code cannot affect the player or
the LAN dashboard, and the page reports it as *"no longer valid"* rather than
as a fault.

### The storage contract

Both front doors write this, and nothing else may invent a second scheme. This
table is the interface; `deliverables/pit-231/TUNNEL-TOKEN-STORAGE-CONTRACT.md`
is the evidence behind each line of it.

| | |
| --- | --- |
| Credential | `/etc/pitchtribe/tunnel.env`, one line, `TUNNEL_TOKEN=<token>` |
| Mode / owner | `0600 root:root` in `/etc/pitchtribe` (`0755 root:root`) |
| Unit | `pitchtribe-tunnel.service`, installed on every card and left disabled |
| Written by | `deploy/setup/wifi-privileged.py` as root, over its Unix socket — never a web process, never the dashboard directly |
| Broker actions | `tunnel-status`, `tunnel-enable` (`token`), `tunnel-disable` |
| Enable | validate, atomic replace, `systemctl enable` + `restart`, then wait on real health |
| Disable | `systemctl disable --now`, then delete the credential |
| Health | `GET http://127.0.0.1:20241/ready` — `200` means a connector actually registered. `systemctl start` returning 0 proves nothing |

The token is **never** passed on a command line. `cloudflared service install
<token>` writes it into a world-readable `ExecStart` and into a process command
line any local user can read from `/proc`; a club card has a kiosk UID and
other local identities by design, so that is not acceptable here even though it
was acceptable on a single-admin Pi. `cloudflared` reads `TUNNEL_TOKEN` from
the unit's environment instead, and redacts it in its own startup log.

Validation happens twice, with the same rules in both places — at the web
boundary in `wifi-startup.py` and again at the privileged boundary in
`wifi-privileged.py`, because the web process has no authority. Both copies are
covered by `app/test/tunnel-token.test.js`, which fails if they ever drift
apart.

## Required Pi 4 commissioning checklist

Perform each row on a Pi 4 with a newly flashed image and a wired button.
Record UTC time, model, image hash, and pass/fail in a private bench record.
Never paste the UART contents or AP key into the record. The same checklist may
be run on a Pi 5 as an optional compatibility check; Pi 5 results are not
required to satisfy this runbook.

### Startup screen acceptance (required on Pi 4; optional on Pi 5)

### Local authorization checks (run on a development host or Pi)

Before the hardware checklist, validate the privilege boundary without using
real credentials:

1. Run `python3 -m py_compile deploy/setup/wifi-startup.py deploy/setup/wifi-privileged.py`
   and `bash -n deploy/install.sh`. Then
   `node --test app/test/tunnel-token.test.js app/test/remote-access-route.test.js`,
   which covers the connector-token validator at both boundaries and drives the
   remote-access routes over HTTP against a stubbed broker. No Pi and no real
   token are needed for either.
2. On an installed Pi, confirm the startup HTTP process runs as
  `pitchtribe-kiosk` and the broker runs as root. Check
  `stat -c '%U:%G %a' /run/pitchtribe-wifi-privileged.sock`; expected is
  `root:pitchtribe-wifi 660`. Confirm only `pitchtribe-kiosk` is a member of
  `pitchtribe-wifi` (`getent group pitchtribe-wifi`).
3. Confirm `nft list table inet pitchtribe_wifi_http` shows an output rule
   rejecting TCP destination port 8090 when `meta skuid` differs from the
   numeric UID of `pitchtribe-kiosk` (`id -u pitchtribe-kiosk`). Confirm the
   guest portal table, when installed, is still present with
   `nft list table inet pitchtribe_portal`.
4. From a different local UID, run
   `sudo -u nobody curl --max-time 3 -i http://127.0.0.1:8090/connect`;
   expect curl to fail before receiving an HTTP status. Then as
   `pitchtribe-kiosk`, request `http://127.0.0.1:8090/` and confirm an HTTP
   response. This proves the OS boundary denies another UID while preserving
   kiosk access. Do not submit credentials in either check.
5. As an unrelated unprivileged account, attempt to connect to the broker's
   Unix socket; it must fail with permission denied. As the kiosk account, send
   an invalid request and confirm the broker returns a bounded error without
   logging its payload. Do not send or record real Wi-Fi credentials.
6. Confirm the HTTP process cannot write
   `/etc/NetworkManager/system-connections` and has no `nmcli` subprocesses.
   The HTTP listener's loopback binding and HTTP headers are not authorization;
   the nftables output rule and broker socket ownership enforce the boundary.

These checks cover local process authorization only. They are not evidence of
Pi 4 hardware commissioning; complete the required checklist below.

With Guest Wi-Fi disabled and no saved station profile, boot with HDMI attached
and no Ethernet. Confirm the on-screen picker appears, nearby networks scan,
and a valid venue credential connects and opens the named player screen. Try a
wrong password and an unavailable SSID; confirm a useful retry state and that
the kiosk does not remain on a browser connection-error page. Reboot with the
saved profile and confirm it opens the player without prompting. Confirm
Continue without Wi-Fi opens the local player. While Guest Wi-Fi is active,
confirm the picker refuses radio changes with an explanatory message. Reinstall
PitchTribe with an existing station profile and confirm normal autoconnection
still works. Check the kiosk starts if the local helper restarts during boot.

1. Confirm `enable_uart=0` in `/boot/firmware/config.txt`; confirm no serial
   getty is active. Check key file owner/mode with `stat -c '%U:%G %a'` and
   confirm two separately flashed cards have different identities by comparing
   private digests, not by printing keys.
2. Reboot. Confirm no setup radio or listener is active and no UART key appears.
   Press for two seconds; confirm no UART output. Hold for three seconds;
   confirm one owner-only UART disclosure, then no output after 20 seconds.
3. Verify `dtoverlay -l` has no setup UART overlay after timeout and after
   `systemctl stop pitchtribe-setup-network.service`. Confirm no key in
   `journalctl -u pitchtribe-setup-network.service`, HDMI, kiosk, or tty1/tty3.
4. With guest Wi-Fi disabled, hold the button for three seconds. Join the unique
   WPA2 setup AP from a phone and open `http://10.77.0.1:8088/`. Confirm a
   fresh nonce form and nearby SSID choices. Submit a club SSID and password;
   confirm `wlan0` gets a club DHCP address and both the AP and listener stop.
   Confirm the new `.nmconnection` is root:root mode 0600. Repeat with a wrong
   password; confirm the previous working profile remains and the button is
   required for another attempt. Do not record either password.
5. Hold the button and leave the form untouched for over five minutes. Confirm
   AP, listener, nonce, and `/run/pitchtribe-setup/active` disappear. A browser
   refresh must fail until a new physical hold. Stop and restart the service
   during a window; confirm the same cleanup. Reboot without pressing the
   button; confirm setup is still inactive.
6. Turn on Guest Wi-Fi while setup is active and confirm the portal apply refuses
   the radio. With Guest Wi-Fi already active, hold the button and confirm no
   setup AP starts. Switch Guest Wi-Fi off and confirm NetworkManager regains
   `wlan0`; then repeat setup. Check that the setup address never serves the
   guest portal or dashboard.

### Remote access token (required before remote access ships)

Needs a real connector token for a test tunnel in our Zero Trust account. Do
not use a club's token, and do not paste any token into a bench record, an
issue thread or a shared log.

1. On a freshly flashed card, before typing anything: confirm the unit is
   there, disabled, and cannot start.

   ```sh
   systemctl is-enabled pitchtribe-tunnel.service
   test -e /etc/pitchtribe/tunnel.env && echo UNEXPECTED || echo "no credential"
   sudo systemctl start pitchtribe-tunnel.service
   systemctl is-active pitchtribe-tunnel.service
   sudo journalctl -u pitchtribe-tunnel.service -n 20 --no-pager
   ```

   Expect `disabled`, `no credential`, and an explicit start that is an inert
   no-op — `inactive` with a condition-failed note, not a crash loop.

2. Enter the token on the TV page's Remote access section. Expect a plain
   outcome within about half a minute, then confirm what actually happened:

   ```sh
   stat -c '%U:%G %a' /etc/pitchtribe/tunnel.env
   systemctl is-enabled pitchtribe-tunnel.service
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20241/ready
   ```

   Expect `root:root 600`, `enabled`, and `200`. A `503` with the page saying
   the code is saved and will connect later is a pass only if the card has no
   working internet; record which case it was.

3. **The redaction evidence set.** With `T` set to the token in a shell
   variable (never in a file, and clear it afterwards), every one of these must
   produce no output:

   ```sh
   systemctl cat pitchtribe-tunnel.service | grep -F "$T"
   systemctl show pitchtribe-tunnel.service -p Environment | grep -F "$T"
   ps aux | grep -F "$T"
   sudo cat /proc/$(systemctl show -p MainPID --value pitchtribe-tunnel.service)/cmdline | tr '\0' ' ' | grep -F "$T"
   sudo journalctl -u pitchtribe-tunnel.service --no-pager | grep -F "$T"
   sudo journalctl -u pitchtribe-wifi-startup.service -u pitchtribe-wifi-privileged.service --no-pager | grep -F "$T"
   ```

   Also confirm the HTTP response body never contains it, and that the token
   does not appear in the page after a reload. Record the set as pass/fail
   without quoting the token. A hit on any line fails the check and the
   credential path does not ship.

4. Re-enter a different valid token and confirm the replacement is clean:
   `/etc/pitchtribe/tunnel.env` is still `0600 root:root`, there is no
   `tunnel.env.*` left in `/etc/pitchtribe`, and `/ready` returns `200` again.
   Then enter a deliberately invalid code and confirm the previous working one
   still works — the page should refuse the bad code and change nothing.

5. Ask PitchTribe to revoke the tunnel's secret centrally. Confirm the page
   reports the code as no longer valid rather than as a fault, and that the
   player and the LAN dashboard are unaffected throughout.

6. Press **Turn remote access off**. Confirm the unit is `disabled` and
   `inactive`, `/etc/pitchtribe/tunnel.env` is gone, and the dashboard and
   player are still working. Reboot and confirm no connector starts.

For each required Pi 4 row, capture UTC timestamp, model, image SHA256,
`systemctl status pitchtribe-setup-network.service`, `nmcli device status`,
`ip -4 address show wlan0`, and the relevant redacted journal lines. If running
the optional Pi 5 check, capture the same evidence separately. Keep owner UART
output and credentials out of shared logs. Confirm no station password appears
in `journalctl`, browser history, app JSON, or world-readable files. Record the
exact pass/fail and any NetworkManager error code privately.

Current state: the identity, serial gate, AP controller, form, and station
transition are installed in source. This checklist is a verification recipe,
not a claim of completed Pi hardware commissioning.
