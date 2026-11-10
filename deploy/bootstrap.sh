#!/usr/bin/env bash
# PitchTribe one-line installer. Safe to pipe into a shell:
#
#   curl -sSL https://pitchtribe.media/install.sh | sudo bash
#
# Run this on a Raspberry Pi that is already booted into Raspberry Pi OS
# (Trixie or Bookworm, Lite or Desktop). It does not write an SD card — flash the card
# with Raspberry Pi Imager first, boot the Pi, then run this.
#
# All it does is fetch a checkout and hand over to deploy/install.sh, which does
# the real work. That script copies app/ and signage-server/ into /opt/pitchtribe,
# so it needs the repository on disk and cannot be piped into a shell itself.
# This wrapper is what makes the one-liner above work.
#
# Every PITCHTRIBE_* option documented in deploy/install.sh works here too — the
# install script inherits this shell's environment:
#
#   curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_PORTAL=1 bash
#
# By default this installs the latest *release*, not whatever happens to be on
# the main branch at that moment. The one-liner runs as root on a club's Pi, so
# it should only ever install a version that was tagged and released on purpose.
#
# Options for this wrapper only:
#   PITCHTRIBE_REPO=<url>   clone from somewhere else (default: GitHub)
#   PITCHTRIBE_REF=<ref>    install this tag or branch instead of the latest
#                           release — e.g. PITCHTRIBE_REF=main for the newest code
set -euo pipefail

REPO="${PITCHTRIBE_REPO:-https://github.com/pitchtribe/pitchtribe-display.git}"
REF="${PITCHTRIBE_REF:-}"

# Set only by app/test/bootstrap.test.js: work out which version would be
# installed and stop before installing it. Nothing on a Pi sets this.
DRY_RUN="${PITCHTRIBE_BOOTSTRAP_DRY_RUN:-0}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "$DRY_RUN" != 1 ]]; then
  [[ $EUID -eq 0 ]] || die "this installer needs root. Pipe it into sudo bash:
  curl -sSL https://pitchtribe.media/install.sh | sudo bash"
  command -v apt-get >/dev/null || die "this installer supports Debian / Raspberry Pi OS only"

  export DEBIAN_FRONTEND=noninteractive

  if ! command -v git >/dev/null; then
    log "Installing git"
    apt-get update -q
    apt-get install -y -q git ca-certificates
  fi
  # Needed to ask which release is current, so it is no longer optional.
  if ! command -v curl >/dev/null; then
    log "Installing curl"
    apt-get update -q
    apt-get install -y -q curl ca-certificates
  fi
fi

# owner/name, for the releases API. Works for https://, git@ and a .git suffix.
SLUG="$(printf '%s' "$REPO" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
API="${PITCHTRIBE_API:-https://api.github.com}/repos/$SLUG"

# Which release is current, asked of GitHub rather than assumed.
if [[ -z "$REF" ]]; then
  # Only GitHub can be asked. A mirror has to name its own version, rather than
  # quietly falling back to a branch — which is the behaviour this replaces.
  [[ "$REPO" == *github.com* ]] || die "$REPO is not on GitHub, so I cannot ask which release is the latest.
Name the version yourself:
  curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_REF=v0.4.2 bash"
  # `|| true`, because `set -e` would otherwise exit here silently — with the
  # curl exit status and no explanation — the moment the Pi is offline.
  REF="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API/releases/latest" 2>/dev/null \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
  # Fail closed. Installing "whatever is on main" because a lookup failed is
  # exactly the behaviour this replaces, so say so and name the way round it.
  [[ -n "$REF" ]] || die "could not work out the latest PitchTribe release from $API.
Check the Pi's internet connection, or choose a version yourself:
  curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_REF=main bash"
  log "Latest release: $REF"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log "Fetching PitchTribe ($REF)"
git clone --depth 1 --branch "$REF" --quiet "$REPO" "$WORK/pitchtribe" \
  || die "could not clone $REPO at $REF — check the Pi's internet connection"

# For a tag, check the commit we were given is the commit that tag names.
# This is not a signature — both answers come from GitHub — but it does catch a
# tag that moved between the two calls, and a checkout that does not match it.
if [[ "$REF" == v* ]]; then
  got="$(git -C "$WORK/pitchtribe" rev-parse HEAD)"
  # grep -o, not sed: the API answers on one line, and a greedy pattern would
  # pick the last "sha" in the body (a parent commit) instead of the first.
  want="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API/commits/$REF" 2>/dev/null \
    | grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{40\}"' | head -n 1 | cut -d'"' -f4 || true)"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    die "the checkout of $REF is commit $got, but GitHub says $REF is $want. Nothing was installed."
  fi
  [[ -n "$want" ]] || log "could not confirm $REF's commit with GitHub — carrying on with $got"
fi

if [[ "$DRY_RUN" == 1 ]]; then
  log "would install $REF (${got:-no commit check}) — stopping, this is a dry run"
  exit 0
fi

# Hand over. Not exec'd, so the trap above still cleans up the checkout, which
# install.sh has finished with by then (it copies what it needs into place).
bash "$WORK/pitchtribe/deploy/install.sh"
