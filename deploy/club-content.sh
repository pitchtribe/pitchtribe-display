#!/usr/bin/env bash
# Puts one club's own content on the card.
#
#   club-content.sh <club-dir> [data-dir] [kiosk-env-file]
#
# Run by deploy/install.sh when the checkout it is installing from carries a club
# directory — content for one named building rather than for the system everybody
# downloads. It is also the whole job by hand on a card that is already running:
#
#   sudo deploy/club-content.sh <club-dir>
#
# Why it exists: most cards are playlist players, configured from the dashboard
# after they boot. A single-club card is not — its screen is a wall driven by
# files in the data directory, and the only person near it is a volunteer with no
# keyboard. Without this, a club's own image flashes, boots, serves the right
# page and shows the wrong club: ours. That shipped once (caldecote-0.0.1) and it
# is the one failure nobody catches in a screenshot, because the page answers
# 200 and looks deliberate.
#
# What a club directory holds. These belong to whoever prepares the card; the
# base system never writes them:
#
#   <club>/card/      everything in here is copied into the data directory
#   <club>/card.env   KEY=value lines merged into the kiosk's environment file.
#                     A value starting with "/" is a path on this card and is
#                     hung off the origin the installer already wrote, so a card
#                     showing a screen from another PitchTribe keeps pointing at
#                     it.
#
# Two rules, both deliberate:
#
#   - A file already in the data directory is never overwritten. Upgrading a club
#     card must not throw away the season somebody typed in on a Saturday
#     evening, or the photographs, or hours that have since been corrected.
#   - A club directory that is named but missing or empty is an error, not a
#     no-op. A club card that quietly installs as a playlist player is precisely
#     the failure this script exists to prevent, so it fails the install instead.
set -euo pipefail

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

CLUB_DIR="${1:-}"
DATA_DIR="${2:-/var/lib/pitchtribe}"
# Empty means "this card has no kiosk" (PITCHTRIBE_NO_KIOSK=1, or a server-only
# hub): the content still goes on, and card.env is skipped out loud.
KIOSK_ENV="${3-/etc/default/pitchtribe-kiosk}"
OWNER="${PITCHTRIBE_CLUB_OWNER:-pitchtribe}"

[[ -n "$CLUB_DIR" ]] || die "usage: club-content.sh <club-dir> [data-dir] [kiosk-env-file]"
[[ -d "$CLUB_DIR" ]] || die "no club directory at $CLUB_DIR"
CARD="$CLUB_DIR/card"
[[ -d "$CARD" ]] || die "$CLUB_DIR has no card/ directory, so there is nothing to put on the card.
A club directory holds card/ (files for the data directory) and optionally card.env."

shopt -s nullglob dotglob
ENTRIES=("$CARD"/*)
(( ${#ENTRIES[@]} > 0 )) || die "$CARD is empty, so this card would boot as a playlist player with a club's name on the box"

# ------------------------------------------------------------------ content
# Never re-mode an existing data directory: on a running card it already belongs
# to the service user, and the installer made it.
if [[ ! -d "$DATA_DIR" ]]; then
  install -d -m 0750 "$DATA_DIR"
  if [[ $EUID -eq 0 ]] && id -u "$OWNER" >/dev/null 2>&1; then chown "$OWNER:$OWNER" "$DATA_DIR"; fi
fi
for src in "${ENTRIES[@]}"; do
  name="$(basename "$src")"
  dest="$DATA_DIR/$name"
  if [[ -e "$dest" ]]; then
    log "kept this card's own $name — an upgrade never overwrites it"
    continue
  fi
  cp -a "$src" "$dest"
  if [[ -d "$dest" ]]; then chmod 0755 "$dest"; else chmod 0644 "$dest"; fi
  # Only root can hand files to the service user, and only if the install has
  # already made it. Running this out of a checkout as yourself is for tests.
  if [[ $EUID -eq 0 ]] && id -u "$OWNER" >/dev/null 2>&1; then
    chown -R "$OWNER:$OWNER" "$dest"
  fi
  log "placed $name"
done

# -------------------------------------------------------------- kiosk lines
ENV_SRC="$CLUB_DIR/card.env"
if [[ ! -f "$ENV_SRC" ]]; then
  log "no card.env in $CLUB_DIR — leaving the kiosk pointed where it is"
  exit 0
fi
if [[ -z "$KIOSK_ENV" || ! -f "$KIOSK_ENV" ]]; then
  log "no kiosk environment file${KIOSK_ENV:+ at $KIOSK_ENV} — this card shows no screen of its own, so card.env is skipped"
  exit 0
fi

# The origin the installer wrote, so a relative value in card.env lands on the
# same server the kiosk is already pointed at (this Pi, or a hub).
ORIGIN="$(sed -n 's#^[[:space:]]*PITCHTRIBE_URL=\(https\?://[^/]*\).*#\1#p' "$KIOSK_ENV" | tail -n 1)"

mapfile -t LINES <"$ENV_SRC"
for line in "${LINES[@]}"; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  # `[[ … ]] && continue` would end the whole install on the first blank line,
  # because a false test is a failing command under `set -e`.
  if [[ -z "$trimmed" || "$trimmed" == '#'* ]]; then continue; fi
  [[ "$line" == *=* ]] || die "card.env: not a KEY=value line: $line"
  key="${line%%=*}"
  val="${line#*=}"
  key="${key//[[:space:]]/}"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "card.env: not a variable name: $key"
  if [[ "$val" == /* ]]; then
    [[ -n "$ORIGIN" ]] || die "card.env wants $key=$val, a path, but $KIOSK_ENV has no http(s) origin to hang it off"
    val="$ORIGIN$val"
  fi
  # Rewritten line by line rather than with sed, because the value is a URL and
  # escaping one into a sed expression is how a replacement quietly half-happens.
  tmp="$(mktemp)"
  cat "$KIOSK_ENV" >"$tmp"
  : >"$KIOSK_ENV.new"
  done_once=0
  while IFS= read -r l || [[ -n "$l" ]]; do
    if [[ "$l" == "$key="* ]]; then
      if (( done_once == 0 )); then printf '%s=%s\n' "$key" "$val" >>"$KIOSK_ENV.new"; fi
      done_once=1
    else
      printf '%s\n' "$l" >>"$KIOSK_ENV.new"
    fi
  done <"$tmp"
  if (( done_once == 0 )); then printf '%s=%s\n' "$key" "$val" >>"$KIOSK_ENV.new"; fi
  cat "$KIOSK_ENV.new" >"$KIOSK_ENV"
  rm -f "$tmp" "$KIOSK_ENV.new"
  log "kiosk: $key=$val"
done
