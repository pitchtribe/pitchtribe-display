#!/bin/sh
# Restrict the local startup Wi-Fi HTTP listener to the kiosk service UID.
# This uses a dedicated table so it composes with the guest portal ruleset.
set -eu

KIOSK_UID="$(id -u pitchtribe-kiosk)"

# The table is owned by this service. Replace it in one nft transaction on a
# service restart so no partially applied rule set is exposed.
REPLACE=
if nft list table inet pitchtribe_wifi_http >/dev/null 2>&1; then
  REPLACE='delete table inet pitchtribe_wifi_http'
fi
nft -f - <<EOF
${REPLACE}
add table inet pitchtribe_wifi_http
add chain inet pitchtribe_wifi_http output { type filter hook output priority -10; policy accept; }
add rule inet pitchtribe_wifi_http output tcp dport 8090 meta skuid != $KIOSK_UID reject
# cloudflared's readiness endpoint, pinned to 127.0.0.1:20241 by
# pitchtribe-tunnel.service. We need it: it is the only honest answer to
# "did a connector actually register". But the same listener serves
# /debug/pprof/heap, unauthenticated, and a heap profile of a process holding
# a connector token is a way to read that token without root - which is the
# whole thing the EnvironmentFile exists to prevent. cloudflared opens this
# port whether or not we pass --metrics (it tries 20241-20245, then a random
# port), so pinning it is what makes one rule enough. Root only: the broker
# does the health check, nothing else has any business here.
add rule inet pitchtribe_wifi_http output tcp dport 20241 meta skuid != 0 reject
EOF
