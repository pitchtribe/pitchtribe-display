#!/usr/bin/env bash
# PitchTribe installer for Raspberry Pi OS (Trixie or Bookworm, Lite or Desktop)
# on a Pi 4/5.
#
#   git clone <this repo> pitchtribe && sudo pitchtribe/deploy/install.sh
#
# Or let deploy/bootstrap.sh fetch the checkout for you, which is the same thing
# in one line and is what the website publishes:
#
#   curl -sSL https://pitchtribe.media/install.sh | sudo bash
#
# Installs:
#   - Node.js 22 (NodeSource) if a recent Node isn't present
#   - PitchTribe in /opt/pitchtribe (app/ + the signage-server sports engine it embeds),
#     data in /var/lib/pitchtribe
#   - pitchtribe.service        — dashboard + API on port 80, and HTTPS on 443
#                                 with a certificate the Pi makes for itself
#   - pitchtribe-kiosk.service  — full-screen Chromium (in the cage Wayland
#                                 kiosk) on the HDMI output, showing this Pi's screen
#   - avahi so the dashboard is reachable at http://<hostname>.local
#   - USB stick backups: pitchtribe-backup.{path,timer} and pitchtribe-backup@.service
#   - remote access (SSH on/off from the dashboard): pitchtribe-remote-access.path
#   - cloudflared, for the Cloudflare Tunnel the commissioning page can switch on.
#     The binary and Cloudflare's apt source, and nothing else: no tunnel, no token
#     and no cloudflared.service until a club commissions one on the device.
#   - Raspberry Pi OS updates: installed now, then every night in front of the
#     backup (pitchtribe-os-update.service, deploy/update/os-update.sh)
#
# Options (environment variables):
#   PITCHTRIBE_NO_KIOSK=1         server only (e.g. a headless "hub" Pi)
#   PITCHTRIBE_SERVER=http://hub.local   kiosk only: show a screen from another PitchTribe server
#   PITCHTRIBE_PORT=80            dashboard port
#   PITCHTRIBE_HTTPS_PORT=443     HTTPS port; 0 serves plain http only
#   PITCHTRIBE_NO_OS_UPGRADE=1    don't install the waiting OS updates during this
#                                 run (the nightly update is set up either way)
#   PITCHTRIBE_PORTAL=1           also set up the guest Wi-Fi captive portal on wlan0
#                                 (the Pi must be connected to the club router by cable)
#   PITCHTRIBE_IMAGE_BUILD=1      used by image/build.sh: install into a mounted SD card
#                                 image from a chroot. Services are enabled for the
#                                 first boot but not started now.
#   PITCHTRIBE_CLUB_DIR=<club>    one club's own card content (a clubhouse wall rather
#                                 than a playlist player): a directory in this checkout
#                                 holding card/ and card.env — see deploy/club-content.sh.
#                                 Optional, and there is no such directory in this repo:
#                                 the ordinary route is to put clubhouse.json in the data
#                                 directory on the card (signage-server/CLUBHOUSE.md).
set -euo pipefail

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# This script copies app/ and signage-server/ into /opt/pitchtribe, so it needs
# the repository on disk and cannot be read from a pipe: when bash reads a script
# from stdin BASH_SOURCE is unset, and SRC_DIR below would silently resolve to /.
# deploy/bootstrap.sh is the pipeable entry point — it clones a checkout first.
[[ -n "${BASH_SOURCE[0]:-}" ]] || die "this script cannot be piped into a shell — it needs a PitchTribe checkout on disk.
Use the one-line installer, which fetches one for you:
  curl -sSL https://pitchtribe.media/install.sh | sudo bash"

APP_DIR=/opt/pitchtribe
DATA_DIR=/var/lib/pitchtribe
# Root's own, and deliberately not inside DATA_DIR. What bounds a support
# access session is kept here, because DATA_DIR belongs to SVC_USER — and a
# backup restore chowns everything in it to SVC_USER as well. The dashboard
# reads a mirror of the state; it never gets to decide when access ends.
STATE_DIR=/var/lib/pitchtribe-remote-access
SVC_USER=pitchtribe
PORTAL_USER=pitchtribe-portal
# The group the remote access status file is readable as, with one member:
# SVC_USER. Not group pitchtribe — that one is wider than the dashboard (the
# captive portal's user is in it, to reach DATA_DIR/portal), and while a support
# access sign-in is waiting to be finished that file holds the Raspberry Pi
# Connect verification code. Whoever gets to that code first pairs this Pi to
# their own Raspberry Pi ID instead of the club's, so it does not get to share a
# group with anything a guest on an untrusted network can reach.
MIRROR_GROUP=pitchtribe-dashboard
KIOSK_USER=pitchtribe-kiosk
WIFI_SETUP=0
# A club's ports are recorded nowhere but the unit file this installer renders,
# so the defaults below are only right on a card nothing has installed yet. On a
# re-run — an upgrade, or a second pass to pick up a new Environment= line — an
# unset PITCHTRIBE_PORT used to mean 80, which silently moved a club off its
# chosen port and took its HTTPS_PORT=0 with it. Read the live value back first;
# an explicit PITCHTRIBE_PORT still wins, and a port of 0 is a real answer (it
# turns HTTPS off), which is why this tests for a number rather than emptiness.
installed_port() { # $1 = Environment= variable name in the installed unit
  local value
  value="$(sed -n "s/^Environment=$1=\([0-9]\+\)\$/\1/p" \
    /etc/systemd/system/pitchtribe.service 2>/dev/null | tail -n 1)"
  printf '%s' "$value"
}
PORT="${PITCHTRIBE_PORT:-$(installed_port PORT)}"
HTTPS_PORT="${PITCHTRIBE_HTTPS_PORT:-$(installed_port HTTPS_PORT)}"
PORT="${PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"
SERVER="${PITCHTRIBE_SERVER:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || die "run with sudo"
[[ -f "$SRC_DIR/app/server.js" && -f "$SRC_DIR/signage-server/package.json" ]] || die "run this script from a PitchTribe checkout (app/ and signage-server/ not found)"
command -v apt-get >/dev/null || die "this installer supports Debian / Raspberry Pi OS only"

export DEBIAN_FRONTEND=noninteractive

IMAGE_BUILD="${PITCHTRIBE_IMAGE_BUILD:-0}"
# Start or restart a unit now — except when building an image, where nothing runs
# until the card boots (the units are enabled, so they start then).
start_now() { [[ "$IMAGE_BUILD" == 1 ]] || systemctl "$@"; }

# --------------------------------------------------------- Raspberry Pi OS updates
# A club flashes a card and leaves it on a wall for a season, so PitchTribe
# patches the OS itself: once now — the base image can be months old, and
# everything below installs on top of it — and then every night in front of the
# nightly backup. deploy/update/os-update.sh says what it does and does not do.
log "Updating Raspberry Pi OS"
install -m 0755 "$SRC_DIR/deploy/update/os-update.sh" /usr/local/bin/pitchtribe-os-update
install -m 0644 "$SRC_DIR/deploy/update/pitchtribe-os-update.service" /etc/systemd/system/
if [[ "${PITCHTRIBE_NO_OS_UPGRADE:-0}" == 1 ]]; then
  log "Skipped the upgrade for now (PITCHTRIBE_NO_OS_UPGRADE=1) — the nightly one still runs"
else
  # Never fatal. A club on a slow or half-blocked connection should still end up
  # with a working PitchTribe, and tonight's run picks the updates up.
  /usr/local/bin/pitchtribe-os-update || log "The OS update didn't finish — carrying on, tonight's run will pick it up"
fi
if [[ -n "$SERVER" ]]; then
  # An extra-screen Pi has no nightly backup to run in front of, so it gets its
  # own timer. A full PitchTribe uses the backup's schedule, below.
  install -m 0644 "$SRC_DIR/deploy/update/pitchtribe-os-update.timer" /etc/systemd/system/
  start_now daemon-reload
  systemctl enable pitchtribe-os-update.timer
  start_now start pitchtribe-os-update.timer
fi

if [[ -z "$SERVER" ]]; then
  # ---------------------------------------------------------------- server
  need_node=1
  if command -v node >/dev/null; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
    [[ "$major" -ge 20 ]] && need_node=0
  fi
  if [[ $need_node -eq 1 ]]; then
    log "Installing Node.js 22"
    apt-get update -q
    apt-get install -y -q ca-certificates curl gnupg
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
    apt-get update -q
    apt-get install -y -q nodejs
  fi

  log "Installing avahi (http://$(hostname).local)"
  apt-get install -y -q avahi-daemon

  log "Installing PitchTribe to $APP_DIR"
  id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR"
  install -d -o root -g root -m 0700 "$STATE_DIR"
  getent group "$MIRROR_GROUP" >/dev/null || groupadd --system "$MIRROR_GROUP"
  usermod -a -G "$MIRROR_GROUP" "$SVC_USER"
  # A tripwire, not a formality: the whole value of this group is that it has
  # one member. Group pitchtribe used to be narrow too, and then the captive
  # portal joined it. Adding somebody here is how that happens again.
  #
  # It stops the install rather than warning, because a warning in installer
  # output on a Pi nobody is watching is not a control. But it is recoverable
  # without editing this script: PITCHTRIBE_ALLOW_MIRROR_GROUP_MEMBERS is a
  # space-separated list of accounts somebody has decided on purpose may read
  # the verification code. Going through it is a decision; not noticing is not.
  mirror_allowed="$SVC_USER ${PITCHTRIBE_ALLOW_MIRROR_GROUP_MEMBERS:-}"
  mirror_members="$(getent group "$MIRROR_GROUP" | cut -d: -f4 | tr ',' ' ')"
  mirror_extra=""
  for m in $mirror_members; do
    [[ " $mirror_allowed " == *" $m "* ]] || mirror_extra="$mirror_extra $m"
  done
  [[ -z "$mirror_extra" ]] \
    || die "group $MIRROR_GROUP must contain only $SVC_USER, and also contains:$mirror_extra.
Whatever is in it can read $DATA_DIR/remote-access-status.json, which holds the
Raspberry Pi Connect verification code while support access is being switched on.
If that is deliberate, re-run with PITCHTRIBE_ALLOW_MIRROR_GROUP_MEMBERS=\"$(echo "$mirror_extra" | xargs)\"."
  rm -rf "$APP_DIR.new"
  mkdir -p "$APP_DIR.new/app" "$APP_DIR.new/signage-server"
  cp -a "$SRC_DIR/app/." "$APP_DIR.new/app/"
  cp -a "$SRC_DIR/signage-server/." "$APP_DIR.new/signage-server/"
  rm -rf "$APP_DIR.new/app/data" "$APP_DIR.new/app/node_modules" "$APP_DIR.new/signage-server/config.json"
  # app depends on ../signage-server (file: dependency, linked by npm)
  (cd "$APP_DIR.new/app" && npm ci --omit=dev --no-audit --no-fund)
  rm -rf "$APP_DIR.old"
  [[ -d "$APP_DIR" ]] && mv "$APP_DIR" "$APP_DIR.old"
  mv "$APP_DIR.new" "$APP_DIR"
  rm -rf "$APP_DIR.old"

  install -m 0755 "$SRC_DIR/deploy/reset-password.sh" /usr/local/bin/pitchtribe-reset-password

  # SSH hardening. SSH itself stays off until someone switches it on in the
  # dashboard (Settings → Remote access); this only sets the terms it runs on.
  # Password logins stay enabled on purpose — that feature sets a password, and
  # see deploy/ssh/10-pitchtribe-hardening.conf for the rest of the reasoning.
  log "Hardening SSH (it stays off until the dashboard switches it on)"
  install -d -m 0755 /etc/ssh/sshd_config.d
  # Older sshd_config files don't pull the drop-in directory in by themselves.
  if [[ -f /etc/ssh/sshd_config ]] && ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
    sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
  fi
  install -m 0644 "$SRC_DIR/deploy/ssh/10-pitchtribe-hardening.conf" /etc/ssh/sshd_config.d/
  # Never leave a config behind that sshd would refuse to start on: if the
  # merged config doesn't parse, drop our part and keep the Pi reachable.
  # `sshd -t` also fails for reasons that are none of our business — in a fresh
  # image there are no host keys yet, as those are generated on first boot — so
  # only back out when sshd's complaint actually names our file. Reverting on
  # any failure would silently drop this hardening from every built image.
  if command -v sshd >/dev/null \
    && sshd -t 2>&1 | grep -q '10-pitchtribe-hardening\.conf'; then
    rm -f /etc/ssh/sshd_config.d/10-pitchtribe-hardening.conf
    log "SSH hardening skipped — sshd rejected our drop-in, left SSH untouched"
  elif [[ "$IMAGE_BUILD" != 1 ]] && systemctl is-active --quiet ssh.service; then
    # Only when SSH is already on; this must not be what starts it.
    systemctl reload ssh.service || systemctl restart ssh.service || true
  fi
  # USB stick backups (Settings → Backups in the dashboard): a root helper run
  # nightly, on request from the dashboard, and when a stick is plugged in.
  install -m 0644 "$SRC_DIR/deploy/backup/pitchtribe-backup@.service" "$SRC_DIR/deploy/backup/pitchtribe-backup.path" \
    "$SRC_DIR/deploy/backup/pitchtribe-backup.timer" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/backup/91-pitchtribe-backup.rules" /etc/udev/rules.d/
  # The key that encrypts those backups belongs to root, not to the dashboard's
  # user: the dashboard is the part of this that faces the network, and the
  # helper is the only thing that needs to read it. The recovery code beside it
  # does go to the service user, because Settings → Backups shows it on request.
  # Asserted on every run: a `chown -R` from an older restore, or a volunteer
  # following half an old forum post, should not leave either one readable.
  # Neither file is created here — the helper makes them when a club switches
  # encryption on — and neither is ever written to a backup.
  if [[ -f "$DATA_DIR/backup-key" ]]; then
    chown root:root "$DATA_DIR/backup-key"
    chmod 0600 "$DATA_DIR/backup-key"
  fi
  if [[ -f "$DATA_DIR/backup-recovery.json" ]]; then
    chown "$SVC_USER:$SVC_USER" "$DATA_DIR/backup-recovery.json"
    chmod 0600 "$DATA_DIR/backup-recovery.json"
  fi
  # Remote access (Settings → Remote access): a root helper that switches SSH on
  # or off and sets its login, and switches support access (Raspberry Pi Connect)
  # on or off, when the dashboard asks. The timer ends a support session that has
  # run out even if nobody ever opens the dashboard again.
  install -m 0644 "$SRC_DIR/deploy/remote-access/pitchtribe-remote-access@.service" \
    "$SRC_DIR/deploy/remote-access/pitchtribe-remote-access.path" \
    "$SRC_DIR/deploy/remote-access/pitchtribe-support-expire.timer" /etc/systemd/system/
  # Cloudflare Tunnel (the dashboard from outside the building, when a club asks
  # for it). Only the binary goes on here, and deliberately: a tunnel exists once
  # somebody pastes a connector token into the commissioning page on the device,
  # and until then there is no tunnel, no token and no service. Having cloudflared
  # already on the card is what lets that be a text box on a page rather than a
  # volunteer being talked through apt over the phone — the one thing it needs is
  # a shell, which this product does not hand out.
  #
  # From Cloudflare's own apt repo rather than a downloaded .deb, so the nightly
  # OS update patches it along with everything else. A tunnel daemon frozen at
  # whatever version the image shipped with is the package on this card that can
  # least afford to rot: it is the part facing the internet.
  log "Installing cloudflared (inert — no tunnel until a token is commissioned)"
  # Not fatal under `set -e`, deliberately: if curl cannot be installed then the
  # fetches below fail too, and that runs into the failure policy at the end of
  # this block — fatal in an image build, a warning on a Pi that already works.
  # Aborting the whole installer here would take the rest of PitchTribe with it.
  command -v curl >/dev/null || apt-get install -y -q ca-certificates curl \
    || log "couldn't install curl — the cloudflared fetches below will fail"
  install -d -m 0755 /usr/share/keyrings
  cloudflared_installed=0
  # The key lands first and the source line only goes in once it is really there.
  # A `signed-by=` pointing at a missing or truncated keyring makes every later
  # `apt-get update` on the card fail, which would take the nightly OS update
  # down with it — the exact opposite of what using the repo is for.
  if curl -fsSL --retry 3 -o /usr/share/keyrings/cloudflare-main.gpg.new https://pkg.cloudflare.com/cloudflare-main.gpg \
    && [[ -s /usr/share/keyrings/cloudflare-main.gpg.new ]]; then
    mv /usr/share/keyrings/cloudflare-main.gpg.new /usr/share/keyrings/cloudflare-main.gpg
    chmod 0644 /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' >/etc/apt/sources.list.d/cloudflared.list
    # Not fatal on its own: another source failing to refresh is none of our
    # business, and the install below is the thing that actually has to work.
    apt-get update -q || log "apt-get update didn't finish — trying the Cloudflare package anyway"
    if apt-get install -y -q cloudflared; then cloudflared_installed=1; fi
  else
    rm -f /usr/share/keyrings/cloudflare-main.gpg.new
    log "couldn't fetch Cloudflare's signing key, so the apt source was left off — nothing will upgrade cloudflared until this installer runs again"
  fi
  if [[ "$cloudflared_installed" == 0 ]]; then
    # Only when the repo didn't answer. Same binary, published by Cloudflare for
    # a 64-bit Pi, but outside apt — so it stays at this version until the repo
    # is reachable and a later run picks the upgrade up. The apt source stays
    # where it is for exactly that. The package has no dependencies, so dpkg is
    # enough here.
    log "Cloudflare's apt repo didn't answer — installing the arm64 package from the release instead"
    if curl -fsSL --retry 3 -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb \
      && dpkg -i /tmp/cloudflared.deb; then
      cloudflared_installed=1
    fi
    rm -f /tmp/cloudflared.deb
  fi
  if [[ "$cloudflared_installed" == 1 ]]; then
    # Nothing is run or enabled: `cloudflared service install <token>` is what
    # creates cloudflared.service, and it belongs on the device at commissioning,
    # with a token a club pasted in. image/build.sh asserts that none of it
    # happened here.
    log "cloudflared $(dpkg-query -W -f '${Version}' cloudflared 2>/dev/null || echo '(unpackaged)') installed — no tunnel, no token, no service"
    # pitchtribe-tunnel.service runs as User=cloudflared (added in PIT-240).
    # The official Cloudflare deb's postinst creates this user on a fresh
    # package install, but not when reinstalling the same version — which is
    # the normal path on a re-run of this installer on an already-commissioned
    # Pi. Create both the group and the user explicitly so the service can
    # start regardless of which install path was taken.
    getent group cloudflared >/dev/null || groupadd --system cloudflared
    id -u cloudflared >/dev/null 2>&1 \
      || useradd --system --no-create-home --shell /usr/sbin/nologin \
           -g cloudflared cloudflared
    # Upgrade path: tunnel.env may be owned root:root from before PIT-240 when
    # the service ran without a User= directive. Fix ownership so cloudflared
    # can read it; the commissioning flow sets this correctly on new files.
    if [[ -f /etc/pitchtribe/tunnel.env ]]; then
      chown cloudflared:cloudflared /etc/pitchtribe/tunnel.env
    fi
  elif [[ "$IMAGE_BUILD" == 1 ]]; then
    die "could not install cloudflared, from Cloudflare's apt repo or from the release package.
This is fatal in an image build on purpose: a card whose commissioning page
offers a connector-token box that cannot work is worse than a build that stopped."
  else
    # A Pi that is already commissioned keeps working — the dashboard reads this
    # off the device and says remote access is unavailable rather than offering a
    # button with nothing behind it, the same way it does for Raspberry Pi Connect.
    log "couldn't install cloudflared — remote access will show as unavailable. Re-run this installer once the Pi can reach pkg.cloudflare.com."
  fi

  # The nightly OS update runs in front of the nightly backup, as one job: the
  # backup timer is the schedule for both. See deploy/update/10-os-update.conf.
  install -d -m 0755 /etc/systemd/system/pitchtribe-backup@nightly.service.d
  install -m 0644 "$SRC_DIR/deploy/update/10-os-update.conf" /etc/systemd/system/pitchtribe-backup@nightly.service.d/
  # A card that was an extra screen before has a timer of its own for this; the
  # backup chain replaces it, and two of them would patch the card twice.
  systemctl disable pitchtribe-os-update.timer 2>/dev/null || true
  rm -f /etc/systemd/system/pitchtribe-os-update.timer
  [[ "$IMAGE_BUILD" == 1 ]] || udevadm control --reload 2>/dev/null || true
  sed -e "s|@PORT@|$PORT|g" -e "s|@HTTPS_PORT@|$HTTPS_PORT|g" "$SRC_DIR/deploy/pitchtribe.service" >/etc/systemd/system/pitchtribe.service
  start_now daemon-reload
  systemctl enable pitchtribe.service pitchtribe-backup.path pitchtribe-backup.timer pitchtribe-backup@scan.service \
    pitchtribe-remote-access.path pitchtribe-remote-access@status.service pitchtribe-support-expire.timer
  start_now restart pitchtribe.service
  start_now start pitchtribe-backup.path pitchtribe-backup.timer pitchtribe-remote-access.path \
    pitchtribe-support-expire.timer
  start_now start --no-block pitchtribe-remote-access@status.service || true
  start_now start --no-block pitchtribe-backup@scan.service || true
  SERVER="http://localhost$([[ "$PORT" == 80 ]] || echo ":$PORT")"
fi

if [[ "${PITCHTRIBE_PORTAL:-0}" == 1 ]]; then
  # ------------------------------------------------------------ guest Wi-Fi
  log "Installing the guest Wi-Fi captive portal (hostapd, dnsmasq, nftables)"
  if [[ "$IMAGE_BUILD" != 1 ]] && ! ip -o link show eth0 >/dev/null 2>&1; then
    die "the guest Wi-Fi needs the Pi's network cable (eth0) for its internet connection"
  fi
  apt-get install -y -q hostapd dnsmasq nftables

  # The portal gets its own user and its own directory. It is the one process
  # guests can reach, and in DATA_DIR a single written file is by design a root
  # account (the remote-access helper acts on remote-access-request.json
  # appearing), so it must not share the dashboard's user or its writable path.
  #
  # Group `pitchtribe` as a supplementary group so it can traverse DATA_DIR
  # (0750) to reach its own directory; db.json is 0600 and stays unreadable to
  # it. The directory is group-writable and setgid so the dashboard can publish
  # the sign-in page's settings into it and clear the guest list, and both
  # sides' files keep the shared group.
  # The group normally exists already (the dashboard's user owns it), but this
  # block also runs on a portal-only Pi with PITCHTRIBE_SERVER set elsewhere.
  getent group "$SVC_USER" >/dev/null || groupadd --system "$SVC_USER"
  id -u "$PORTAL_USER" >/dev/null 2>&1 \
    || useradd --system --home "$DATA_DIR/portal" --shell /usr/sbin/nologin "$PORTAL_USER"
  usermod --append --groups "$SVC_USER" "$PORTAL_USER"
  install -d -o "$PORTAL_USER" -g "$SVC_USER" -m 2770 "$DATA_DIR/portal"
  # Upgrades: cards installed before the split keep the guest list and session
  # stats in DATA_DIR itself. Move them, so the club does not open the
  # dashboard to an empty guest list.
  for f in portal-sessions.json portal-guests.jsonl; do
    if [[ -f "$DATA_DIR/$f" && ! -f "$DATA_DIR/portal/$f" ]]; then
      mv "$DATA_DIR/$f" "$DATA_DIR/portal/$f"
      log "moved $f into $DATA_DIR/portal (the portal has its own user now)"
    fi
  done
  chown -R "$PORTAL_USER:$SVC_USER" "$DATA_DIR/portal"
  chmod 640 "$DATA_DIR/portal/"* 2>/dev/null || true
  # pitchtribe-portal-apply tells NetworkManager to leave the guest radio, the
  # access-point port and the guest bridge alone, whichever ones are in use.
  # The default dnsmasq config must not grab every interface.
  grep -q '^conf-dir=/etc/dnsmasq.d' /etc/dnsmasq.conf 2>/dev/null || echo 'conf-dir=/etc/dnsmasq.d/,*.conf' >>/etc/dnsmasq.conf
  install -m 0755 "$SRC_DIR/deploy/portal/portal-apply.sh" /usr/local/bin/pitchtribe-portal-apply
  install -m 0644 "$SRC_DIR/deploy/portal/pitchtribe-portal.service" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/portal/pitchtribe-portal-apply.service" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/portal/pitchtribe-portal-apply.path" /etc/systemd/system/
  # Re-apply when a USB Wi-Fi adapter or USB network adapter is plugged in or out.
  install -m 0644 "$SRC_DIR/deploy/portal/90-pitchtribe-portal.rules" /etc/udev/rules.d/
  [[ "$IMAGE_BUILD" == 1 ]] || udevadm control --reload 2>/dev/null || true
  # Installed, but nothing broadcasts or listens until Guest Wi-Fi is switched on
  # in the dashboard. pitchtribe-portal-apply is what switches the parts below on
  # and off, from the settings; these three make sure that nothing else does.
  #
  # dnsmasq: apt enables it, and its stock configuration answers DHCP and DNS on
  # every interface — which on a club's network means a second, unasked-for DHCP
  # server. It must only run with the guest-only configuration that
  # pitchtribe-portal-apply writes, so take it out of the boot sequence.
  # hostapd: Debian ships it masked until it is configured, which is the right
  # state here too — pitchtribe-portal-apply unmasks it once there is a radio and
  # a hostapd.conf to go with it.
  #
  # pitchtribe-portal.service listens on the guest bridge address (10.42.0.1),
  # which only exists while guest Wi-Fi is on. Enabling it for boot would leave
  # it restarting every three seconds on every card that never turns guest Wi-Fi
  # on, so pitchtribe-portal-apply starts it instead — after the bridge is up.
  systemctl disable dnsmasq.service || true
  systemctl mask hostapd.service || true
  systemctl disable pitchtribe-portal.service || true
  systemctl enable pitchtribe-portal-apply.service pitchtribe-portal-apply.path
  # `disable` and `mask` are file operations, which is why they work in the image
  # chroot — but a quiet failure here would put a second DHCP server on every
  # club's network, so check the files rather than trust an exit status.
  for unit in dnsmasq.service hostapd.service pitchtribe-portal.service; do
    link="/etc/systemd/system/multi-user.target.wants/$unit"
    if [[ -e "$link" || -L "$link" ]]; then
      rm -f "$link"
      log "took $unit out of the boot sequence by hand — systemctl left it enabled"
    fi
  done
  if [[ "$(readlink -f /etc/systemd/system/hostapd.service 2>/dev/null || true)" != /dev/null ]]; then
    ln -sfn /dev/null /etc/systemd/system/hostapd.service
    log "masked hostapd by hand — systemctl left it unmasked"
  fi
  # On a Pi that is already running, apt will have started dnsmasq on its stock
  # configuration a moment ago. Stop it: only the guest-only configuration counts.
  start_now stop dnsmasq.service || true
  start_now daemon-reload
  start_now start pitchtribe-portal-apply.path
  start_now start pitchtribe-portal-apply.service || true
  log "Guest Wi-Fi installed — switch it on and design the sign-in page under Guest Wi-Fi in the dashboard"
fi

# The physical setup button and per-card identity are installed on Pi images
# and on Pi 4/5 installs. Provisioning runs on the device, never in the chroot.
if [[ "$IMAGE_BUILD" == 1 || -f /proc/device-tree/model ]]; then
  log "Installing physical-button offline Wi-Fi setup"
  WIFI_SETUP=1
  getent group pitchtribe-wifi >/dev/null || groupadd --system pitchtribe-wifi
  apt-get install -y -q python3-gpiozero python3-lgpio nftables
  install -d -o root -g root -m 0755 /usr/local/lib/pitchtribe
  install -m 0755 "$SRC_DIR/deploy/setup/setup-identity.py" /usr/local/lib/pitchtribe/
  install -m 0755 "$SRC_DIR/deploy/setup/setup-serial.py" /usr/local/lib/pitchtribe/
  install -m 0755 "$SRC_DIR/deploy/setup/setup-network.py" /usr/local/lib/pitchtribe/
  install -m 0755 "$SRC_DIR/deploy/setup/wifi-startup.py" /usr/local/lib/pitchtribe/
  install -m 0755 "$SRC_DIR/deploy/setup/wifi-privileged.py" /usr/local/lib/pitchtribe/
  install -m 0755 "$SRC_DIR/deploy/setup/wifi-http-firewall.sh" /usr/local/lib/pitchtribe/
  install -m 0644 "$SRC_DIR/deploy/setup/pitchtribe-setup-identity.service" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/setup/pitchtribe-setup-network.service" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/setup/pitchtribe-wifi-privileged.service" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/setup/pitchtribe-wifi-startup.service" /etc/systemd/system/
  install -m 0644 "$SRC_DIR/deploy/setup/pitchtribe-wifi-http-firewall.service" /etc/systemd/system/
  # Remote access. The unit goes on every card and is deliberately left
  # disabled: it has ConditionPathExists on a credential that only exists once
  # a club pastes a token into the commissioning page, so an unprovisioned
  # card has a unit that cannot start rather than a unit that fails. The
  # directory is created here so the broker's atomic replace has somewhere to
  # stage; the credential itself is never written by this installer, and an
  # existing one is left exactly as it is on a re-run.
  install -m 0644 "$SRC_DIR/deploy/setup/pitchtribe-tunnel.service" /etc/systemd/system/
  install -d -o root -g root -m 0755 /etc/pitchtribe
  systemctl disable --now pitchtribe-setup-serial.service 2>/dev/null || true
  rm -f /etc/systemd/system/pitchtribe-setup-serial.service
  systemctl disable serial-getty@ttyAMA0.service serial-getty@serial0.service 2>/dev/null || true
  systemctl mask serial-getty@ttyAMA0.service serial-getty@serial0.service 2>/dev/null || true
  start_now daemon-reload
  systemctl enable pitchtribe-setup-identity.service pitchtribe-setup-network.service pitchtribe-wifi-privileged.service pitchtribe-wifi-http-firewall.service pitchtribe-wifi-startup.service
  start_now start pitchtribe-setup-identity.service pitchtribe-setup-network.service pitchtribe-wifi-privileged.service
fi

if [[ "${PITCHTRIBE_NO_KIOSK:-0}" != 1 ]]; then
  # ----------------------------------------------------------------- kiosk
  log "Installing the kiosk display (cage + Chromium)"
  apt-get install -y -q cage fonts-noto-color-emoji
  if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
    apt-get install -y -q chromium || apt-get install -y -q chromium-browser
  fi
  CHROMIUM="$(command -v chromium || command -v chromium-browser)"

  id -u "$KIOSK_USER" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$KIOSK_USER"
  usermod -a -G video,render,input,audio,pitchtribe-wifi "$KIOSK_USER"

  install -m 0755 "$SRC_DIR/deploy/kiosk.sh" /usr/local/bin/pitchtribe-kiosk
  cat >/etc/default/pitchtribe-kiosk <<EOF
# Read by pitchtribe-kiosk.service. @HOSTNAME@ becomes this Pi's hostname when the
# kiosk starts, so each Pi shows its own screen (and an SD card image works on any Pi).
#
# For a single-club clubhouse wall instead of the playlist player, put the club's own
# file at ${DATA_DIR}/clubhouse.json, restart pitchtribe, then point this line at the
# wall and restart pitchtribe-kiosk (see signage-server/CLUBHOUSE.md, "On a card"):
#   PITCHTRIBE_URL=${SERVER%/}/feeds/clubhouse
# Without that file the page answers, but with our name on it and no football — so the
# file comes first.
PITCHTRIBE_URL=${SERVER%/}/player/?screen=@HOSTNAME@
PITCHTRIBE_WIFI_SETUP=${WIFI_SETUP}
CHROMIUM=${CHROMIUM}
EOF
  install -m 0644 "$SRC_DIR/deploy/pitchtribe-kiosk.service" /etc/systemd/system/pitchtribe-kiosk.service
  start_now daemon-reload
  # The kiosk takes over the first console; boot to the console, not a desktop.
  systemctl set-default multi-user.target
  systemctl disable getty@tty1.service 2>/dev/null || true
  systemctl enable pitchtribe-kiosk.service
  if [[ "$WIFI_SETUP" == 1 ]]; then
    start_now start pitchtribe-wifi-startup.service || true
  fi
  start_now restart pitchtribe-kiosk.service || true
  KIOSK_ENV_FILE=/etc/default/pitchtribe-kiosk
fi

# ------------------------------------------------------------- club content
# Most cards are playlist players and are configured from the dashboard after
# they boot. A card built for one named building is not: its screen is driven by
# files in the data directory, and the only person near it is a volunteer with no
# keyboard — so those files have to be on the card before its first boot.
#
# A checkout prepared for one building names its club directory in a
# .pitchtribe-club file at the top of it. There is no such file in this repo, so
# this is inert for the system everybody downloads.
CLUB_DIR="${PITCHTRIBE_CLUB_DIR:-}"
if [[ -z "$CLUB_DIR" && -f "$SRC_DIR/.pitchtribe-club" ]]; then
  CLUB_DIR="$(tr -d '[:space:]' <"$SRC_DIR/.pitchtribe-club")"
  # It is joined onto a path, so it names one directory here and nothing else.
  [[ "$CLUB_DIR" =~ ^[A-Za-z0-9._-]+$ && "$CLUB_DIR" != .* ]] \
    || die ".pitchtribe-club must name one directory in this checkout, not “$CLUB_DIR”"
fi
if [[ -n "$CLUB_DIR" ]]; then
  [[ "$CLUB_DIR" == /* ]] || CLUB_DIR="$SRC_DIR/$CLUB_DIR"
  log "Club card: putting $(basename "$CLUB_DIR")'s own content on it"
  # Not `|| true`: a club card that installs as a playlist player with the
  # club's name on the box is the failure this is here to prevent, so a missing
  # or unreadable club directory fails the install rather than passing quietly.
  "$SRC_DIR/deploy/club-content.sh" "$CLUB_DIR" "$DATA_DIR" "${KIOSK_ENV_FILE:-}"
  start_now restart pitchtribe.service || true
  start_now restart pitchtribe-kiosk.service || true
fi

if [[ "$IMAGE_BUILD" == 1 ]]; then
  log "Done — PitchTribe is installed in the image and starts on first boot"
  exit 0
fi

HOST="$(hostname).local"
log "Done!"
if systemctl is-enabled pitchtribe.service >/dev/null 2>&1; then
  echo
  echo "  Dashboard:  http://${HOST}$([[ "$PORT" == 80 ]] || echo ":$PORT")/"
  for ip in $(hostname -I); do echo "              http://${ip}$([[ "$PORT" == 80 ]] || echo ":$PORT")/"; done
  # The certificate is this Pi's own, made on first start, so a browser will
  # warn once. Settings -> Secure connection shows the fingerprint to check.
  [[ "$HTTPS_PORT" == 0 ]] || echo "  Secure:     https://${HOST}$([[ "$HTTPS_PORT" == 443 ]] || echo ":$HTTPS_PORT")/"
  echo
  echo "  Open it on your phone (same network) to create the admin password."
fi
