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
EOF
