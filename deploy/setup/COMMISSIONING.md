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
