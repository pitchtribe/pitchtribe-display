#!/usr/bin/env bash
# Rewrites a Raspberry Pi cmdline.txt so the card boots quietly on a club TV.
#
#   image/harden-cmdline.sh <path to cmdline.txt>
#
# Called by image/build.sh against the image's boot partition. Kept as its own
# script so it can be tested (app/test/hardening.test.js) against a real
# Raspberry Pi OS cmdline instead of only being read.
#
# Three things happen here:
#
#  - every console= moves to tty3. This is the one that matters. On a stock card
#    the kernel console is tty1 — the HDMI output — and the first boot writes a
#    lot to it: the card resizes its own filesystem and reboots, then cloud-init
#    runs, all before the kiosk takes the screen. getty@tty1 is already off
#    (deploy/install.sh), so once the console moves, nothing writes to the
#    screen the room can see. A keyboard and Alt+F3 still show the boot log.
#  - the serial consoles go with it: config.txt sets enable_uart=0, so a console
#    on serial0 is a setting that cannot work, and leaving it there contradicts
#    the hardening next to it.
#  - the quiet parameters are added if they are not already there.
#
# cmdline.txt must stay ONE line: the bootloader reads the first line and
# ignores the rest, so anything on a second line is silently dropped.
#
# Deliberately NOT set here: fsck.mode=skip, because these cards get unplugged
# rather than shut down and the boot-time check is what repairs the filesystem
# afterwards; and noswap, because no swap risks the kernel killing Chromium on a
# 2 GB Pi.
set -euo pipefail

FILE="${1:?usage: harden-cmdline.sh <cmdline.txt>}"
[[ -f "$FILE" ]] || { echo "harden-cmdline.sh: $FILE does not exist" >&2; exit 1; }

# Only the first line is the kernel command line; read -r takes exactly that.
read -r cmdline <"$FILE" || true

params=()
for param in $cmdline; do
  case "$param" in
    console=*) ;; # replaced by the single console below
    *) params+=("$param") ;;
  esac
done
for param in quiet loglevel=3 logo.nologo vt.global_cursor_default=0; do
  [[ " ${params[*]} " == *" $param "* ]] || params+=("$param")
done
# Last, so that running this twice produces exactly the same line.
params+=(console=tty3)

printf '%s\n' "${params[*]}" >"$FILE"
