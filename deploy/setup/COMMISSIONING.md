# Pi 4/5 setup hardware and bench record

This is an operator procedure. The phone-facing setup flow is awaiting QA review.

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
   `systemctl stop pitchtribe-setup-serial.service`. Confirm no key in
   `journalctl -u pitchtribe-setup-serial.service`, HDMI, kiosk, or tty1/tty3.
4. Test AP association, local phone form, station transition, timeout, and guest
   radio coexistence **after the remaining setup AP service is installed**.
   Capture timestamped `nmcli device status`, service state, IP address, and
   radio state. Redact SSIDs if private and never capture passwords or keys.

Current state: the identity and serial gate are installed; AP, form, and station
transition are still pending. These steps are a verification recipe, not a
claim of completed Pi hardware commissioning.
