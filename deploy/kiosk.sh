#!/usr/bin/env bash
# Launched by pitchtribe-kiosk.service: full-screen Chromium inside the cage
# Wayland kiosk compositor, pointed at this screen's player page.
set -euo pipefail

URL="${PITCHTRIBE_URL:-http://localhost/player/?screen=@HOSTNAME@}"
# Each Pi shows the screen named after its hostname (lounge-tv.local → lounge-tv).
SCREEN_ID="$(hostname | tr -c 'a-zA-Z0-9_\n-' '-')"
URL="${URL//@HOSTNAME@/$SCREEN_ID}"
CHROMIUM="${CHROMIUM:-$(command -v chromium || command -v chromium-browser)}"
PROFILE="${HOME}/.config/pitchtribe-chromium"
mkdir -p "$PROFILE"

# Wait (up to ~60 s) for the server so the screen doesn't open on an error page.
# The page retries by itself too, so carry on regardless. Both health paths are tried
# because this URL may be the app's player page or the signage server's clubhouse wall.
origin="$(printf '%s' "$URL" | sed -E 's#^([a-z]+://[^/]+).*#\1#')"
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null --max-time 2 "${origin}/healthz" && break
  curl -fsS -o /dev/null --max-time 2 "${origin}/api/health" && break
  sleep 2
done

# Clear "Chromium didn't shut down correctly" after a power cut.
prefs="$PROFILE/Default/Preferences"
if [[ -f "$prefs" ]]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' "$prefs"
fi

exec cage -d -s -- "$CHROMIUM" \
  --user-data-dir="$PROFILE" \
  --ozone-platform=wayland \
  --kiosk \
  --app="$URL" \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=Translate,MediaRouter \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic \
  --overscroll-history-navigation=0 \
  --enable-gpu-rasterization \
  --ignore-gpu-blocklist
