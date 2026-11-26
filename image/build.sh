#!/usr/bin/env bash
# Builds a ready-to-flash PitchTribe SD card image: the official Raspberry Pi OS
# Lite (64-bit) image with PitchTribe already installed by deploy/install.sh.
#
#   sudo image/build.sh [output-dir]
#
# Runs on an arm64 Linux host (CI uses GitHub's ubuntu-24.04-arm runner), so the
# Pi OS userland runs natively in a chroot with no emulation. Needs root for
# loop devices and mounts, plus: curl xz-utils parted e2fsprogs util-linux.
#
# Options (environment variables):
#   BASE_URL=<url>        Raspberry Pi OS image to start from (.img.xz). Default:
#                         the latest Raspberry Pi OS Lite (64-bit) release.
#   IMAGE_NAME=<name>     output file name without extension (default pitchtribe-rpi-arm64)
#   IMAGE_VERSION=<ver>   recorded in /etc/pitchtribe-release (default: git describe)
#   PITCHTRIBE_PORTAL=0   leave the guest Wi-Fi portal out of the image. It is
#                         installed by default because the dashboard offers Guest
#                         Wi-Fi on every card, and it stays completely inert
#                         until someone switches it on there.
#   PITCHTRIBE_NO_OS_UPGRADE=1   leave the base image's packages where they are.
#                         The build normally installs the Raspberry Pi OS updates
#                         waiting for the base image, which is often months old,
#                         so a flashed card is patched before its first boot.
#   EXTRA_MB=2560         space added to the root filesystem for PitchTribe + Chromium
#   XZ_LEVEL=6            xz compression level (CI pull requests use a faster one)
#
# Output, in output-dir (default ./out):
#   <name>.img.xz               the image — flash it with Raspberry Pi Imager
#   <name>.img.xz.sha256        checksum
#   <name>.json                 Raspberry Pi Imager repository entry (sizes, hashes)
set -euo pipefail

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
[[ "$(uname -m)" == aarch64 ]] || die "build on an arm64 host (the Pi OS chroot runs natively)"
for c in curl xz parted losetup e2fsck resize2fs fstrim sha256sum; do
  command -v "$c" >/dev/null || die "missing $c"
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/out}" && cd "${1:-$ROOT/out}" && pwd)"
BASE_URL="${BASE_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"
NAME="${IMAGE_NAME:-pitchtribe-rpi-arm64}"
VERSION="${IMAGE_VERSION:-$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)}"
EXTRA_MB="${EXTRA_MB:-2560}"
XZ_LEVEL="${XZ_LEVEL:-6}"

WORK="$(mktemp -d)"
MNT="$WORK/mnt"
LOOP=""
cleanup() {
  set +e
  for m in dev/pts dev proc sys run boot/firmware ""; do
    mountpoint -q "$MNT/$m" && umount -l "$MNT/$m"
  done
  [[ -n "$LOOP" ]] && losetup -d "$LOOP"
  rm -rf "$WORK"
}
trap cleanup EXIT

# ------------------------------------------------------------------ download
log "Resolving base image from $BASE_URL"
URL="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$BASE_URL")"
[[ "$URL" == *.img.xz ]] || die "expected an .img.xz, got $URL"
log "Downloading $(basename "$URL")"
curl -fsSL --retry 3 -o "$WORK/base.img.xz" "$URL"
want="$(curl -fsSL --retry 3 "$URL.sha256" | awk '{print $1}')"
got="$(sha256sum "$WORK/base.img.xz" | awk '{print $1}')"
[[ -n "$want" && "$want" == "$got" ]] || die "checksum mismatch for $(basename "$URL") (want $want, got $got)"
log "Checksum OK"
xz -d -T0 "$WORK/base.img.xz"
IMG="$WORK/$NAME.img"
mv "$WORK/base.img" "$IMG"

# ----------------------------------------------------- grow the root partition
log "Adding ${EXTRA_MB} MB to the root partition"
truncate -s "+${EXTRA_MB}M" "$IMG"
parted -s "$IMG" resizepart 2 100%
LOOP="$(losetup -fP --show "$IMG")"
e2fsck -pf "${LOOP}p2" || [[ $? -le 1 ]]
resize2fs "${LOOP}p2"

mkdir -p "$MNT"
mount "${LOOP}p2" "$MNT"
mount "${LOOP}p1" "$MNT/boot/firmware"
for m in dev dev/pts proc sys run; do mount --bind "/$m" "$MNT/$m"; done

# ------------------------------------------------------------- install inside
CODENAME="$(. "$MNT/etc/os-release" && echo "${VERSION_CODENAME:-unknown}")"
log "Base is Raspberry Pi OS ($CODENAME)"

# Name resolution for apt and npm inside the chroot. resolv.conf may be a symlink
# into /run (which is the host's /run here), so swap it out and put it back after.
mv "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
cp -L /etc/resolv.conf "$MNT/etc/resolv.conf"
# Packages must not try to start daemons during the build.
printf '#!/bin/sh\nexit 101\n' >"$MNT/usr/sbin/policy-rc.d"
chmod +x "$MNT/usr/sbin/policy-rc.d"

mkdir -p "$MNT/tmp/pitchtribe"
cp -a "$ROOT/app" "$ROOT/signage-server" "$ROOT/deploy" "$MNT/tmp/pitchtribe/"
rm -rf "$MNT/tmp/pitchtribe/app/node_modules" "$MNT/tmp/pitchtribe/signage-server/node_modules"

# A club line — a build for one named building — carries that club's own card
# content and a .pitchtribe-club file naming it. The content has to go into the
# chroot with everything else, because a flashed club card must come up as that
# club rather than as a playlist player with the club's name on the box. There is
# no such file on main, so this does nothing to the image everybody downloads.
if [[ -f "$ROOT/.pitchtribe-club" ]]; then
  CLUB="$(tr -d '[:space:]' <"$ROOT/.pitchtribe-club")"
  [[ "$CLUB" =~ ^[A-Za-z0-9._-]+$ && "$CLUB" != .* && -d "$ROOT/$CLUB" ]] \
    || die ".pitchtribe-club names “$CLUB”, which is not a directory in this checkout"
  cp -a "$ROOT/$CLUB" "$ROOT/.pitchtribe-club" "$MNT/tmp/pitchtribe/"
  log "Club line: $CLUB — this card will boot into that club's own screen"
fi

log "Running deploy/install.sh in the image"
chroot "$MNT" /usr/bin/env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
  PITCHTRIBE_IMAGE_BUILD=1 PITCHTRIBE_PORTAL="${PITCHTRIBE_PORTAL:-1}" \
  PITCHTRIBE_NO_OS_UPGRADE="${PITCHTRIBE_NO_OS_UPGRADE:-0}" \
  bash /tmp/pitchtribe/deploy/install.sh

# ------------------------------------------------------------- image defaults
log "Applying image defaults"
# Default hostname, so the dashboard is at http://pitchtribe.local and the screen
# is called "pitchtribe". Raspberry Pi Imager's customisation replaces it.
echo pitchtribe >"$MNT/etc/hostname"
sed -i 's/^127\.0\.1\.1\s.*/127.0.1.1\tpitchtribe/' "$MNT/etc/hosts"
grep -q '^127\.0\.1\.1' "$MNT/etc/hosts" || printf '127.0.1.1\tpitchtribe\n' >>"$MNT/etc/hosts"

# Raspberry Pi OS Lite asks for a keyboard layout and a username on the first
# console when the card was written without Imager customisation. On a screen
# with no keyboard that wizard would sit there forever and hold the kiosk back,
# so switch it off: the display and dashboard need no login account. Anyone who
# wants SSH sets a user (and Wi-Fi) in Imager's customisation before writing.
if [[ -e "$MNT/lib/systemd/system/userconfig.service" || -e "$MNT/usr/lib/systemd/system/userconfig.service" ]]; then
  chroot "$MNT" systemctl disable userconfig.service || true
  chroot "$MNT" systemctl mask userconfig.service
  log "First-boot username wizard (userconfig.service) masked"
else
  log "No first-boot username wizard (userconfig.service) in this base image"
fi

# --------------------------------------------------- support access (Connect)
# Raspberry Pi OS Lite ships rpi-connect-lite, and the dashboard's "Let
# PitchTribe support connect" is built on it (Settings → Remote access). It is
# adopted deliberately, not shipped by accident, so make the state of a fresh
# card explicit rather than inherited: the client is present, it is signed out,
# and nothing starts it. The club turns it on, signing in to the club's own
# Raspberry Pi ID, and it expires on its own. Fail the build if any of that is
# not true, because "a remote access client nobody chose" is the one state a
# club card must never be flashed in.
log "Checking Raspberry Pi Connect ships signed out and disabled"
if chroot "$MNT" sh -c 'command -v rpi-connect' >/dev/null 2>&1; then
  CONNECT_PKG="$(chroot "$MNT" dpkg-query -W -f '${Package} ${Version}\n' 'rpi-connect*' 2>/dev/null | head -1)"
  log "Connect client present: ${CONNECT_PKG:-rpi-connect (unpackaged)}"
  # No account on the image. rpi-connectd keeps its credentials under the home
  # of whoever signed in, so any such file would be baked into every card.
  CONNECT_CREDS="$(find "$MNT/root" "$MNT/home" -maxdepth 4 -path '*rpi-connect*' -type f 2>/dev/null || true)"
  [[ -z "$CONNECT_CREDS" ]] || die "the image has Raspberry Pi Connect state baked in, which would ship one account to every card:
$CONNECT_CREDS"
  # Nothing may start it: not as a system service, and not enabled for every
  # user — and no lingering user, which is what would start a user service
  # with nobody logged in.
  ! chroot "$MNT" systemctl is-enabled rpi-connect.service >/dev/null 2>&1 \
    || die "rpi-connect.service is enabled as a system service in the image"
  CONNECT_USER_WANTS="$(ls -1 "$MNT/etc/systemd/user/default.target.wants" 2>/dev/null | grep -i rpi-connect || true)"
  [[ -z "$CONNECT_USER_WANTS" ]] || die "rpi-connect is enabled for every user in the image ($CONNECT_USER_WANTS)"
  LINGER="$(ls -1 "$MNT/var/lib/systemd/linger" 2>/dev/null || true)"
  [[ -z "$LINGER" ]] || die "the image has lingering user sessions ($LINGER), which would start rpi-connect before any club asked for it"
  log "Connect: installed, signed out, no user enabled, no linger — off until a club turns it on"
else
  # Not an error: the dashboard reads this off the device and says support
  # access is unavailable rather than offering a button that cannot work.
  log "No Raspberry Pi Connect client in this base image — support access will show as unavailable"
fi

# ------------------------------------------- support access (Cloudflare Tunnel)
# cloudflared is on every card for the same reason Connect is: a club that later
# wants its dashboard from outside the building should not need a shell on the
# Pi. deploy/install.sh puts on the binary and Cloudflare's apt source and
# nothing else — a tunnel exists only once somebody pastes a connector token
# into the commissioning page, on the device.
#
# So the clean state asserted here is stronger than Connect's. Connect ships
# installed and signed out; cloudflared ships never configured. `cloudflared
# service install <token>` is what creates cloudflared.service and writes the
# token into it, so on a card nobody has commissioned that unit must not exist
# at all. A present-but-disabled one would mean a token was used during the
# build, and that token would then be on every card flashed from this image —
# one club's tunnel, shared by the whole fleet.
#
# None of this may lean on the policy-rc.d above. That stops a daemon being
# *started* during the build and nothing more: it would wave through an enabled
# unit and a baked credential, both of which come alive on first boot.
log "Checking cloudflared ships inert"
# install.sh fails the build outright when neither install route works, so a
# missing binary here means that check was bypassed, not that the card is fine.
chroot "$MNT" sh -c 'command -v cloudflared' >/dev/null 2>&1 \
  || die "cloudflared is not in the image — deploy/install.sh should have stopped the build before here"
CFD_VER="$(chroot "$MNT" dpkg-query -W -f '${Version}' cloudflared 2>/dev/null || true)"
[[ -n "$CFD_VER" ]] || die "cloudflared is in the image but not as a package, so nothing will ever upgrade it"
# Measured against the headroom this script adds, because that is the space
# cloudflared has to fit inside: EXTRA_MB was sized for PitchTribe and Chromium,
# and cloudflared went onto the card after that number was chosen. The verdict is
# said out loud on every build so whoever next makes this package much bigger —
# or trims EXTRA_MB — finds out here, rather than on a card that filled up in a
# clubhouse. A tenth of the headroom is the line: cloudflared is a single static
# binary, so anything near that is a change in kind, not a version bump.
CFD_KB="$(chroot "$MNT" dpkg-query -W -f '${Installed-Size}' cloudflared 2>/dev/null || echo 0)"
CFD_MB=$((CFD_KB / 1024))
if [[ "$CFD_MB" -le $((EXTRA_MB / 10)) ]]; then
  log "cloudflared $CFD_VER installed: ${CFD_MB} MB of the ${EXTRA_MB} MB added to the root filesystem — headroom holds"
else
  log "WARNING: cloudflared $CFD_VER takes ${CFD_MB} MB of the ${EXTRA_MB} MB added to the root filesystem — raise EXTRA_MB before this squeezes a card"
fi
# Not fatal — install.sh already said so, and it only reaches the fallback when
# pkg.cloudflare.com was unreachable — but loud, because without the source this
# is the one package on the card the nightly OS update cannot patch.
[[ -f "$MNT/etc/apt/sources.list.d/cloudflared.list" ]] \
  || log "WARNING: no Cloudflare apt source in the image — cloudflared $CFD_VER will not be upgraded on any card flashed from it"
# The unit first, because `cloudflared service install <token>` is the way this
# goes wrong in practice and it deserves to be named rather than caught by the
# broader sweep below. It must be absent, not merely off: `systemctl is-enabled`
# answers "no" for a unit that does not exist, so testing only that would pass a
# card with a commissioned tunnel sitting there one `systemctl enable` from live.
# The two /lib paths are checked here and nowhere else — the credential sweep
# below only walks /etc, /root and /home.
for d in etc/systemd/system lib/systemd/system usr/lib/systemd/system; do
  CFD_UNIT="$(ls -A "$MNT/$d" 2>/dev/null | grep '^cloudflared' || true)"
  [[ -z "$CFD_UNIT" ]] || die "the image has a cloudflared unit in /$d ($CFD_UNIT), so a tunnel was installed during the build"
done
! chroot "$MNT" systemctl is-enabled cloudflared.service >/dev/null 2>&1 \
  || die "cloudflared.service is enabled in the image"
# A tunnel's credentials are files too. `tunnel login`/`tunnel create` leave
# cert.pem and a <tunnel-id>.json under /etc/cloudflared or ~/.cloudflared. Any
# of them in the image hands one tunnel's identity to every club that flashes it.
[[ ! -e "$MNT/etc/cloudflared" ]] \
  || die "the image has /etc/cloudflared, so a tunnel was configured during the build:
$(ls -A "$MNT/etc/cloudflared" 2>/dev/null)"
# The package's postinst makes /usr/local/etc/cloudflared and touches
# .installedFromPackageManager in it. That marker is expected; a config.yml or a
# credentials file beside it is not.
CFD_LOCAL="$(ls -A "$MNT/usr/local/etc/cloudflared" 2>/dev/null | grep -v '^\.installedFromPackageManager$' || true)"
[[ -z "$CFD_LOCAL" ]] || die "the image has cloudflared state in /usr/local/etc/cloudflared: $CFD_LOCAL"
# The apt source is the one file here that is meant to have that name in it.
CFD_CREDS="$(find "$MNT/etc" "$MNT/root" "$MNT/home" -maxdepth 4 -path '*cloudflared*' -type f \
  ! -path "$MNT/etc/apt/sources.list.d/cloudflared.list" 2>/dev/null || true)"
[[ -z "$CFD_CREDS" ]] || die "the image has cloudflared state baked in, which would ship one tunnel to every card:
$CFD_CREDS"
# And by content, not just by filename: TunnelSecret is the credentials file a
# tunnel is created with, a connector token is one long base64 blob that
# `service install` writes straight into ExecStart, and TUNNEL_TOKEN= is how
# our own unit receives one. Matched on the shape, so a credential someone
# renamed, or one written to a path nobody thought to list, is still caught.
CFD_TOKENS="$(grep -rlsIE 'TunnelSecret|cloudflared.*--token[[:space:]]+ey[A-Za-z0-9_-]{20,}|TUNNEL_TOKEN=ey[A-Za-z0-9+/=_-]{20,}' \
  "$MNT/etc" "$MNT/root" "$MNT/home" 2>/dev/null || true)"
[[ -z "$CFD_TOKENS" ]] || die "the image has what looks like a tunnel credential or connector token in it:
$CFD_TOKENS"
# Our own unit is the other half of this, and its expected state is different:
# the token box on the commissioning page is useless without it, so it must be
# present — but present, not enabled, and with no credential beside it. The two
# names are asserted separately so neither assertion has to be weakened to let
# the other pass.
[[ -f "$MNT/etc/systemd/system/pitchtribe-tunnel.service" ]] \
  || die "pitchtribe-tunnel.service is not in the image, so a club could paste a token into a card with nothing to run it — deploy/install.sh should have installed it"
! chroot "$MNT" systemctl is-enabled pitchtribe-tunnel.service >/dev/null 2>&1 \
  || die "pitchtribe-tunnel.service is enabled in the image; it is only enabled on a device when a club commissions a token"
[[ ! -e "$MNT/etc/pitchtribe/tunnel.env" ]] \
  || die "the image has a connector token in /etc/pitchtribe/tunnel.env, which would ship one club's tunnel to every card"
log "cloudflared: binary and apt source only — no unit, no credentials, no tunnel until a club commissions one"
log "pitchtribe-tunnel.service: installed, not enabled, no credential — the commissioning page has something to switch on"

# ----------------------------------------------------------- boot hardening
# A club screen has no keyboard and no serial cable plugged into it, so the
# boot-time consoles are only a way in, and kernel chatter on a bar TV is both
# untidy and tells a room more about the box than it needs to know.
log "Hardening the boot configuration"
CMDLINE="$MNT/boot/firmware/cmdline.txt"
if [[ -f "$CMDLINE" ]]; then
  # Moves the console off tty1 (the HDMI output) and adds the quiet parameters,
  # keeping cmdline.txt to one line. See image/harden-cmdline.sh for why each
  # part is there and what is deliberately left out.
  "$ROOT/image/harden-cmdline.sh" "$CMDLINE"
  log "cmdline.txt: quiet boot on tty3, no serial console ($(wc -w <"$CMDLINE") parameters on $(wc -l <"$CMDLINE") line)"
fi

CONFIG_TXT="$MNT/boot/firmware/config.txt"
if [[ -f "$CONFIG_TXT" ]] && ! grep -q '^# PitchTribe hardening' "$CONFIG_TXT"; then
  cat >>"$CONFIG_TXT" <<'EOF'

# PitchTribe hardening
# No rainbow splash before the kiosk takes the screen.
disable_splash=1
# No serial console. Owner key retrieval loads a runtime UART overlay only
# after the GPIO17 hold and removes it after the bounded local window.
enable_uart=0
# Nothing here speaks Bluetooth, so switch the radio off rather than leave it
# listening. Wi-Fi stays on — the guest portal and club network need it.
dtoverlay=disable-bt
EOF
  # disable-bt leaves the Bluetooth attach service failing on every boot.
  chroot "$MNT" systemctl disable hciuart.service 2>/dev/null || true
  log "config.txt: serial console and Bluetooth disabled, splash off"
fi

cat >"$MNT/etc/pitchtribe-release" <<EOF
PITCHTRIBE_VERSION=$VERSION
BASE_IMAGE=$(basename "$URL")
BASE_CODENAME=$CODENAME
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# Imager hands its settings to the card through cloud-init on images that ship
# it (Trixie and later), and through a first-run script on older ones.
if [[ -x "$MNT/usr/bin/cloud-init" ]]; then INIT_FORMAT=cloudinit-rpi; else INIT_FORMAT=systemd; fi
log "Imager customisation format: $INIT_FORMAT"

# ------------------------------------------------------------------ clean up
rm -rf "$MNT/tmp/pitchtribe" "$MNT/usr/sbin/policy-rc.d" "$MNT/root/.npm"
chroot "$MNT" apt-get clean
rm -rf "$MNT/var/lib/apt/lists/"*
rm -f "$MNT/etc/resolv.conf"
[[ -e "$WORK/resolv.conf.orig" || -L "$WORK/resolv.conf.orig" ]] && mv "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"
# Drop the build host's SSH host keys if any were generated; the Pi makes its own.
rm -f "$MNT/etc/ssh/ssh_host_"*

for m in run sys proc dev/pts dev boot/firmware; do umount "$MNT/$m"; done
# Zero the free space so the image compresses well.
fstrim "$MNT" || true
umount "$MNT"
e2fsck -pf "${LOOP}p2" || [[ $? -le 1 ]]
losetup -d "$LOOP"; LOOP=""

# ------------------------------------------------------------------ package
EXTRACT_SIZE="$(stat -c %s "$IMG")"
EXTRACT_SHA="$(sha256sum "$IMG" | awk '{print $1}')"
log "Compressing (xz -$XZ_LEVEL)"
xz -T0 "-$XZ_LEVEL" -c "$IMG" >"$OUT/$NAME.img.xz"
rm -f "$IMG"
(cd "$OUT" && sha256sum "$NAME.img.xz" >"$NAME.img.xz.sha256")
DL_SIZE="$(stat -c %s "$OUT/$NAME.img.xz")"
DL_SHA="$(awk '{print $1}' "$OUT/$NAME.img.xz.sha256")"

# One entry of a Raspberry Pi Imager repository (os_list). The release workflow
# fills in the download URL; Imager uses init_format to offer its customisation
# (hostname, user, SSH, Wi-Fi) for this image.
cat >"$OUT/$NAME.json" <<EOF
{
  "name": "PitchTribe ($VERSION)",
  "description": "Club digital signage. Raspberry Pi OS Lite ($CODENAME, 64-bit) with PitchTribe installed: boots straight to the screen, dashboard at http://pitchtribe.local",
  "url": "@URL@",
  "icon": "https://pitchtribe.media/assets/favicon.svg",
  "website": "https://pitchtribe.media",
  "release_date": "$(date -u +%Y-%m-%d)",
  "extract_size": $EXTRACT_SIZE,
  "extract_sha256": "$EXTRACT_SHA",
  "image_download_size": $DL_SIZE,
  "image_download_sha256": "$DL_SHA",
  "init_format": "$INIT_FORMAT",
  "devices": ["pi5-64bit", "pi4-64bit"]
}
EOF

log "Done: $OUT/$NAME.img.xz ($((DL_SIZE / 1024 / 1024)) MB, $((EXTRACT_SIZE / 1024 / 1024)) MB written to the card)"
