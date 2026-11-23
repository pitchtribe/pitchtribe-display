# Startup Wi-Fi HTTP authorization check

This checklist verifies the local OS boundary for the startup Wi-Fi screen on
both Raspberry Pi 4 and Raspberry Pi 5. It uses no Wi-Fi credentials. Run it
on an installed image that includes the startup Wi-Fi service.

## On each Pi

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

Run all checks on both Pi models. Record model, image SHA-256, UTC time, and
pass/fail for service state, firewall rule, kiosk request, non-kiosk denial,
and portal coexistence (where applicable). Return only those sanitized
results. Do not include credentials, UART output, or full environment files.

These checks verify the installed-image behavior; source syntax checks alone
do not prove Pi 4/Pi 5 firewall behavior. Keep the startup credential flow
gated until the hardware results are reviewed by Security.
