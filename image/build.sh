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
# No serial console: on a Pi the UART pins are a root shell for anyone who can
# reach the board, and nothing in PitchTribe uses them.
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
