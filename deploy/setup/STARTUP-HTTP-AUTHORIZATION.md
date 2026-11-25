# Startup Wi-Fi HTTP authorization check

This checklist verifies the local OS boundary for the startup Wi-Fi screen on
an installed Raspberry Pi image that includes the startup Wi-Fi service. The
reviewer-approved validation gate for this change accepts the completed Pi 4
results; Pi 5 validation is waived because no Pi 5 is available. This checklist
uses no Wi-Fi credentials.

## On the target Pi

1. Check the required services and identities:

   ```sh
   systemctl is-active pitchtribe-wifi-http-firewall.service
   systemctl is-active pitchtribe-wifi-startup.service
   id -u pitchtribe-kiosk
   systemctl show pitchtribe-wifi-startup.service -p User
   ```

   Both services should be active; the startup service should report
   `User=pitchtribe-kiosk`.

2. Inspect the dedicated firewall table and confirm its reject rule targets
   TCP destination port 8090 for every socket UID except the numeric UID
   printed by `id -u pitchtribe-kiosk`:

   ```sh
   nft list table inet pitchtribe_wifi_http
   ```

   If the guest portal is installed, confirm its separate rules remain present:

   ```sh
   nft list table inet pitchtribe_portal
   ```

3. From the kiosk identity, request the listener root page. It should return
   an HTTP response:

   ```sh
   sudo -u pitchtribe-kiosk curl --max-time 3 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/
   ```

4. From a different local identity, try the `/connect` route without sending
   any data. The firewall should reject the connection before an HTTP status
   is received:

   ```sh
   sudo -u nobody curl --max-time 3 -i http://127.0.0.1:8090/connect
   ```

   Pass means curl exits with a connection error and prints no HTTP status
   line. If an HTTP status is returned, fail the check and do not use the
   startup credential flow.

## Record and report

Record the model, image SHA-256, UTC time, and pass/fail for service state,
firewall rule, kiosk request, non-kiosk denial, and portal coexistence (where
applicable). Return only those sanitized results. Do not include credentials,
UART output, or full environment files.

These checks verify the installed-image behavior; source syntax checks alone
do not prove firewall behavior on other hardware. For this change, Security
reviewed the supplied Pi 4 results (2026-11-23T20:04:10Z; image SHA-256
`72d1d7b8a36c632d07da3c010907fafd64136e1a11e269da3046800c8bce142e`):
services active, kiosk UID 1001 received HTTP 303, non-kiosk access was rejected before HTTP, the UID-specific output
reject rule was present, the startup and Guest Wi-Fi nftables tables coexisted,
and reboot persistence was reported passed. Security found no remaining Pi 4
authorization issue. Pi 5 validation is waived for this review by the owning
reviewer; this waiver does not claim Pi 5 behavior was tested.
