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
#
# Options (environment variables):
#   PITCHTRIBE_NO_KIOSK=1         server only (e.g. a headless "hub" Pi)
#   PITCHTRIBE_SERVER=http://hub.local   kiosk only: show a screen from another PitchTribe server
#   PITCHTRIBE_PORT=80            dashboard port
#   PITCHTRIBE_HTTPS_PORT=443     HTTPS port; 0 serves plain http only
#   PITCHTRIBE_PORTAL=1           also set up the guest Wi-Fi captive portal on wlan0
#                                 (the Pi must be connected to the club router by cable)
#   PITCHTRIBE_IMAGE_BUILD=1      used by image/build.sh: install into a mounted SD card
#                                 image from a chroot. Services are enabled for the
#                                 first boot but not started now.
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
SVC_USER=pitchtribe
PORTAL_USER=pitchtribe-portal
KIOSK_USER=pitchtribe-kiosk
PORT="${PITCHTRIBE_PORT:-80}"
HTTPS_PORT="${PITCHTRIBE_HTTPS_PORT:-443}"
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
  # Remote access (Settings → Remote access): a root helper that switches SSH on
  # or off and sets its login, when the dashboard asks.
  install -m 0644 "$SRC_DIR/deploy/remote-access/pitchtribe-remote-access@.service" \
    "$SRC_DIR/deploy/remote-access/pitchtribe-remote-access.path" /etc/systemd/system/
  [[ "$IMAGE_BUILD" == 1 ]] || udevadm control --reload 2>/dev/null || true
  sed -e "s|@PORT@|$PORT|g" -e "s|@HTTPS_PORT@|$HTTPS_PORT|g" "$SRC_DIR/deploy/pitchtribe.service" >/etc/systemd/system/pitchtribe.service
  start_now daemon-reload
  systemctl enable pitchtribe.service pitchtribe-backup.path pitchtribe-backup.timer pitchtribe-backup@scan.service \
    pitchtribe-remote-access.path pitchtribe-remote-access@status.service
  start_now restart pitchtribe.service
  start_now start pitchtribe-backup.path pitchtribe-backup.timer pitchtribe-remote-access.path
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

if [[ "${PITCHTRIBE_NO_KIOSK:-0}" != 1 ]]; then
  # ----------------------------------------------------------------- kiosk
  log "Installing the kiosk display (cage + Chromium)"
  apt-get install -y -q cage fonts-noto-color-emoji
  if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
    apt-get install -y -q chromium || apt-get install -y -q chromium-browser
  fi
  CHROMIUM="$(command -v chromium || command -v chromium-browser)"

  id -u "$KIOSK_USER" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$KIOSK_USER"
  usermod -a -G video,render,input,audio "$KIOSK_USER"

  install -m 0755 "$SRC_DIR/deploy/kiosk.sh" /usr/local/bin/pitchtribe-kiosk
  cat >/etc/default/pitchtribe-kiosk <<EOF
# Read by pitchtribe-kiosk.service. @HOSTNAME@ becomes this Pi's hostname when the
# kiosk starts, so each Pi shows its own screen (and an SD card image works on any Pi).
PITCHTRIBE_URL=${SERVER%/}/player/?screen=@HOSTNAME@
CHROMIUM=${CHROMIUM}
EOF
  install -m 0644 "$SRC_DIR/deploy/pitchtribe-kiosk.service" /etc/systemd/system/pitchtribe-kiosk.service
  start_now daemon-reload
  # The kiosk takes over the first console; boot to the console, not a desktop.
  systemctl set-default multi-user.target
  systemctl disable getty@tty1.service 2>/dev/null || true
  systemctl enable pitchtribe-kiosk.service
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
