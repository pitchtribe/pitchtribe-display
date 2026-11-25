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

One thing to know about that refusal: the probe also accepts a fingerprint from
`PITCHTRIBE_FINGERPRINT` in its environment, and that is enough to satisfy it.
The unit passes `--fingerprint` explicitly, so this never applies to the timer —
but a stale export in an operator's shell will be picked up by a hand-run probe.
A wrong value is still rejected, exit `2`, "certificate fingerprint does not
match", so nothing unverified is ever trusted. It only means an interactive
probe can pass the *refusal* check using a value you did not mean to give it.

**`PROBE_EXTRA` is where version drift goes**, e.g.
`PROBE_EXTRA=--expect-version 0.4.3`. Leave it empty unless you want the timer
to report failure for the whole time a release is pending — which is honest, and
noisy.

The probe forces IPv4. The Pi's name resolves to both an A and an AAAA record
and the order is not stable between lookups, so on an IPv4-only watcher an
unpinned probe fails intermittently against a card that is perfectly healthy.

## "Down" and "I cannot see it" are different answers

Exit `3` means the probe never reached the card: the name did not resolve, or
there is no route to its network. No TCP connection, no TLS handshake, no
certificate and no body — so **the card's state is unknown**, and it may be
perfectly healthy. The failure is on this machine, in its resolver or its
routing. Fix that; do not drive to the clubhouse.

This exists because a watcher with no path to the club LAN turned two transport
errors into a confirmed "the card is down" report about a card nobody had
looked at (PIT-71). An honest monitor has to be able to say "I don't know".

Two failures stay exit `2` on purpose, because on a watcher that normally
reaches the card they are the faults this probe exists to catch:

- **connection refused** — something answers at the IP level and the service is
  not there, i.e. the service has stopped;
- **timeout** — the card is wedged, or a firewall is dropping the connection.

Both are also what an unroutable network looks like from inside a container,
where the router and an unassigned address refuse identically to the card. So
if a watcher reports a refusal for every address on the subnet, including ones
with nothing on them, it is on the wrong network rather than looking at a dead
card.

## Alerting

The unit exits `0` up, `1` needs attention, `2` down, `3` unobservable, so a
non-zero exit leaves it failed and visible to `systemctl --failed`. A `3` is
still worth acting on — a watcher that cannot see the card is a watch that has
stopped — but it is a different job for a different person. Wire up whatever
notifier you use as a drop-in rather than editing the unit:

```sh
sudo systemctl edit pitchtribe-health-probe.service
```

```ini
[Unit]
OnFailure=my-notifier@%n.service
```
