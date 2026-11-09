#!/usr/bin/env bash
# Installs the Raspberry Pi OS updates a club would otherwise have to remember
# to install by hand. Run as root: once by deploy/install.sh, so a card is
# patched before it ever shows a screen, and then every night in front of the
# nightly backup (see 10-os-update.conf) by pitchtribe-os-update.service.
#
#   apt-get update                   refresh the package lists
#   apt-get --with-new-pkgs upgrade  install what's waiting
#   apt-get clean                    don't leave the .debs on the card
#
# Deliberately *not* done here:
#   - no `full-upgrade` / `dist-upgrade`: those may remove packages to resolve a
#     change, and nothing should uninstall Chromium or the kiosk at 03:30 with
#     no one in the building. A release upgrade stays a job someone does on
#     purpose — see https://pitchtribe.media/docs/updates-backups/.
#   - no `autoremove`: same reason, it removes things.
#   - no reboot: the screen is the product, and a Pi that restarts itself in the
#     middle of a match day is worse than a kernel that waits. Updates that need
#     one say so in the status file below, and the club reboots when it suits.
#
# Nothing is ever asked at the terminal (there is no one there), and a package
# that ships a new config file keeps the one on the card: PitchTribe edits
# /etc/dnsmasq.conf and /etc/ssh/sshd_config, and an upgrade must not undo that.
#
# It talks to the dashboard the way the backup helper does, through a file in
# DATA_DIR:
#   os-update-status.json   { checkedAt, lastOkAt, result, upgraded, packages[],
#                             rebootRequired, message }
# Settings → About shows it (app/lib/os-update.js), which is the only way anyone
# at a club finds out that a restart is waiting, or that the card has quietly
# stopped being patched.
#
# Tests (app/test/os-updates.test.js) run this with a stub apt-get on PATH.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/pitchtribe}"
STATUS="$DATA_DIR/os-update-status.json"
# Debian's "something installed wants a restart" flag. A variable so the tests
# can point it somewhere writable.
REBOOT_FLAG="${PITCHTRIBE_OS_UPDATE_REBOOT_FLAG:-/run/reboot-required}"
# How long to wait for another apt — a volunteer over SSH, or unattended-upgrades
# if a club installed it — rather than failing the night's run.
LOCK_WAIT="${PITCHTRIBE_OS_UPDATE_LOCK_WAIT:-600}"
# The status file names what was installed. Enough to read at a glance; the
# first upgrade of an old card can be a hundred packages long.
MAX_NAMED=40

log() { printf '==> %s\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
APT=(
  apt-get -q -y
  -o "DPkg::Lock::Timeout=$LOCK_WAIT"
  # Keep the config files on the card; never stop to ask about them.
  -o Dpkg::Options::=--force-confdef
  -o Dpkg::Options::=--force-confold
)

# apt's messages are the one thing here that isn't ours, so take the quotes,
# backslashes and line breaks out of them before they go into JSON.
json_escape() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   '; }

# The last night that *worked*, carried forward from the previous status file.
# `result` only says how tonight went, and a Pi behind a captive guest network
# writes a fresh `checkedAt` every morning for a month without installing a
# thing — so "this card stopped being patched in October" needs its own date.
# Only timestamp characters are taken out of the old file, so nothing in it can
# get into the JSON written below.
last_ok_at() {
  local result="$1" now="$2" prev
  if [[ "$result" == ok ]]; then printf '"%s"' "$now"; return 0; fi
  [[ -f "$STATUS" ]] || { printf 'null'; return 0; }
  prev="$(sed -n 's/.*"lastOkAt"[[:space:]]*:[[:space:]]*"\([0-9T:Z-]\{1,40\}\)".*/\1/p' "$STATUS" | head -1)"
  # A status file written before this field existed: its own date will do, if
  # the night it describes was a good one.
  if [[ -z "$prev" ]] && grep -q '"result"[[:space:]]*:[[:space:]]*"ok"' "$STATUS"; then
    prev="$(sed -n 's/.*"checkedAt"[[:space:]]*:[[:space:]]*"\([0-9T:Z-]\{1,40\}\)".*/\1/p' "$STATUS" | head -1)"
  fi
  if [[ -n "$prev" ]]; then printf '"%s"' "$prev"; else printf 'null'; fi
}

# Written only if the data directory is there: install.sh runs this before the
# directory exists, and an extra-screen Pi has no dashboard to read it.
# root-owned and world-readable inside DATA_DIR (0750, owned by the dashboard's
# user), because the dashboard reads this file and never writes it.
write_status() {
  local result="$1" message="$2" upgraded="$3"
  shift 3
  [[ -d "$DATA_DIR" ]] || return 0
  local reboot=false
  [[ -e "$REBOOT_FLAG" ]] && reboot=true
  local packages='' p
  for p in "${@:1:$MAX_NAMED}"; do
    packages+="${packages:+, }\"$(json_escape "$p")\""
  done
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local tmp="$STATUS.tmp"
  cat >"$tmp" <<EOF
{
  "checkedAt": "$now",
  "lastOkAt": $(last_ok_at "$result" "$now"),
  "result": "$result",
  "upgraded": $upgraded,
  "packages": [$packages],
  "rebootRequired": $reboot,
  "message": "$(json_escape "$message")"
}
EOF
  chmod 0644 "$tmp"
  mv "$tmp" "$STATUS"
}

# ------------------------------------------------------------ package lists
if ! out="$("${APT[@]}" update 2>&1)"; then
  # A club's Pi is not always online — a cable out of the switch, a captive
  # guest network, the broadband down for the week. That is not a failure
  # anyone needs telling twice: say so, and let tonight pass.
  log "Couldn't refresh the package lists — skipping tonight's update"
  printf '%s\n' "$out" >&2
  write_status offline "could not reach the package archive" 0
  exit 0
fi

# What would be installed, asked before installing it, so the status file can
# name the packages. `Inst <name> ...` is apt's simulation output.
pending=()
while read -r _ name _; do
  [[ -n "$name" ]] && pending+=("$name")
done < <("${APT[@]}" --simulate --with-new-pkgs upgrade 2>/dev/null | grep '^Inst ' || true)

if [[ ${#pending[@]} -eq 0 ]]; then
  log "Raspberry Pi OS is up to date"
  write_status ok "already up to date" 0
  exit 0
fi

# ---------------------------------------------------------------- the upgrade
log "Installing ${#pending[@]} update(s): ${pending[*]}"
if ! "${APT[@]}" --with-new-pkgs upgrade; then
  # Left for the next night, and for the dashboard to show: a run that stops
  # half way is what a full card or a dropped connection looks like.
  log "The upgrade did not finish"
  write_status error "apt-get upgrade failed — see journalctl -u pitchtribe-os-update" 0
  exit 1
fi

# The .debs are no use once installed, and an SD card has no room to spare.
"${APT[@]}" clean || true

log "Installed ${#pending[@]} update(s)"
if [[ -e "$REBOOT_FLAG" ]]; then
  log "One of these needs a restart to take effect — the Pi picks it up at its next reboot"
fi
write_status ok "installed ${#pending[@]} update(s)" "${#pending[@]}" "${pending[@]}"
