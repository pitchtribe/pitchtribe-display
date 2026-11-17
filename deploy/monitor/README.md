# Watching a card from outside it

Everything else under `deploy/` installs **on** a club's Pi. This installs on a
different machine — any always-on Linux box on the same LAN — and watches the Pi
over the network.

That split is the whole point. A watcher on the card itself shares its power
supply, its SD card and its kernel, so in the one case anyone is watching for it
reports nothing at all.

## What it catches

`GET /healthz` always answers `200` while the service is running, so a port
check only ever proves the service is alive. The probe reads the numbers
alongside that — free space, memory, host and process uptime, screens online,
and the state of the nightly OS update — because the failures that take a club
off the air are slower than a crash:

- the card fills up with uploaded video, and the next upload or backup fails;
- the nightly OS update has been failing since the summer, so the card has
  stopped getting security fixes while reporting success every morning;
- the service is crash-looping, answering between restarts;
- the self-signed certificate is about to expire, and every dashboard in the
  club starts warning.

## Install

Needs Node 20 or newer on the watching machine.

```sh
sudo install -d /opt/pitchtribe-monitor
sudo install -m 755 scripts/health-probe.mjs /opt/pitchtribe-monitor/

# The card's certificate fingerprint. Read it from the Pi's dashboard under
# Settings → Secure connection, or ask the card for it:
echo | openssl s_client -connect pitchtribe:443 -servername pitchtribe 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256

sudo tee /etc/pitchtribe-monitor.conf >/dev/null <<'CONF'
PROBE_HOST=pitchtribe
PROBE_FINGERPRINT=AA:BB:CC:...
PROBE_EXTRA=
CONF
sudo chmod 644 /etc/pitchtribe-monitor.conf

sudo install -m 644 deploy/monitor/pitchtribe-health-probe.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pitchtribe-health-probe.timer
```

Check it, and read the results:

```sh
systemctl list-timers pitchtribe-health-probe.timer
journalctl -u pitchtribe-health-probe.service -n 20
```

## Three settings worth understanding before changing them

**`PROBE_HOST` must be the name on the certificate.** The card makes its own
certificate at first boot, covering the short hostname (`pitchtribe`) and the
`.local` form — but not the `.lan` form and not the IP address. Probing by
address can therefore never verify, which is how monitoring ends up running with
verification disabled for no reason at all.

**`PROBE_FINGERPRINT` is required, and the probe refuses to start without it**
unless you pass `--insecure`. There is no authority to verify a self-signed
certificate against, so `-k` is the usual next move and it authenticates
nothing. Pinning the fingerprint is stronger than CA verification here, and it
also catches a reimaged or swapped card, because a new card makes a new key.
Reflashing a card means updating this file.

**`PROBE_EXTRA` is where version drift goes**, e.g.
`PROBE_EXTRA=--expect-version 0.4.3`. Leave it empty unless you want the timer
to report failure for the whole time a release is pending — which is honest, and
noisy.

The probe forces IPv4. The Pi's name resolves to both an A and an AAAA record
and the order is not stable between lookups, so on an IPv4-only watcher an
unpinned probe fails intermittently against a card that is perfectly healthy.

## Alerting

The unit exits `0` up, `1` needs attention, `2` down, so a non-zero exit leaves
it failed and visible to `systemctl --failed`. Wire up whatever notifier you use
as a drop-in rather than editing the unit:

```sh
sudo systemctl edit pitchtribe-health-probe.service
```

```ini
[Unit]
OnFailure=my-notifier@%n.service
```
