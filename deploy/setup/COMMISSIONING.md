# Pi 4/5 setup hardware and bench record

This is an operator procedure. The phone-facing setup flow needs QA review and
physical commissioning before release.

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

## Pi 4 and Pi 5 commissioning checklist

Perform each row on **both** models with a newly flashed image and a wired
button. Record UTC time, model, image hash, and pass/fail in a private bench
record. Never paste the UART contents or AP key into the record.

### Startup screen acceptance (also required on both models)

### Local authorization checks (run on a development host or Pi)

Before the hardware checklist, validate the privilege boundary without using
real credentials:

1. Run `python3 -m py_compile deploy/setup/wifi-startup.py deploy/setup/wifi-privileged.py`
   and `bash -n deploy/install.sh`.
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
Pi 4/Pi 5 hardware commissioning; complete the model-specific checklist below.

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

For each row on **both** Pi 4 and Pi 5, capture UTC timestamp, model, image
SHA256, `systemctl status pitchtribe-setup-network.service`, `nmcli device
status`, `ip -4 address show wlan0`, and the relevant redacted journal lines.
Keep owner UART output and credentials out of shared logs. Confirm no station
password appears in `journalctl`, browser history, app JSON, or world-readable
files. Record the exact pass/fail and any NetworkManager error code privately.

Current state: the identity, serial gate, AP controller, form, and station
transition are installed in source. This checklist is a verification recipe,
not a claim of completed Pi hardware commissioning.
