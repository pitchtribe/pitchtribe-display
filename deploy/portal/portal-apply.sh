#!/usr/bin/env bash
# Applies the guest Wi-Fi settings saved in the dashboard. Run as root by
# pitchtribe-portal-apply.service whenever /var/lib/pitchtribe/portal-network.json
# changes (pitchtribe-portal-apply.path), at boot, and when a USB Wi-Fi or
# network adapter is plugged in or out (90-pitchtribe-portal.rules).
#
#   Wi-Fi radio ──┐                                      (built-in, or a USB adapter
#                 ├─ br-guest (10.42.0.1/22) ──nftables──▶ eth0   with external aerials)
#   USB LAN port ─┘   guests only                         club router / internet
#   (ceiling access points, via a PoE switch)
#
# - hostapd: open access point on the chosen radio, 2.4 or 5 GHz, with client
#   isolation; it joins the radio to the br-guest bridge
# - a USB Ethernet adapter, when access points are switched on, joins the same
#   bridge, so the access points' guests share the same sign-in and limits.
#   Bridge ports are isolated from each other: Wi-Fi guests can't reach wired ones.
# - dnsmasq: DHCP + DNS for guests (about 1,000 addresses), advertises the
#   portal (RFC 8910)
# - nftables: unapproved guests' web traffic -> portal; everything else dropped;
#   approved guests (set "allowed", filled by the portal with a timeout) get the
#   internet only — never the club LAN — with per-device speed limits.
#
# PORTAL_DRY_RUN=1 writes the configuration under $PORTAL_ETC and prints the
# commands instead of running them (used by the tests).
set -euo pipefail

STATE_DIR="${PORTAL_STATE_DIR:-/var/lib/pitchtribe}"
CONF="$STATE_DIR/portal-network.json"
ETC="${PORTAL_ETC:-/etc}"
HW="${PORTAL_HW:-/opt/pitchtribe/app/lib/portal-hw.js}"
BRIDGE=br-guest
UPLINK_IF="${PORTAL_UPLINK:-eth0}"
ADDR=10.42.0.1
PREFIX=22
PORTAL_PORT=8082
DRY="${PORTAL_DRY_RUN:-}"
SETUP_ACTIVE="${PITCHTRIBE_SETUP_ACTIVE:-/run/pitchtribe-setup/active}"

run() { if [[ -n "$DRY" ]]; then echo "+ $*"; else "$@"; fi; }

[[ -f "$CONF" ]] || { echo "no $CONF yet — nothing to do"; exit 0; }

# Read and validate the JSON with node (installed with PitchTribe).
eval "$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ssid = String(c.ssid || "Club-Guest");
  if (!/^[\x20-\x7e]{1,32}$/.test(ssid)) throw new Error("bad ssid");
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const sh = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const band = c.band === "5" ? "5" : "2.4";
  // 5 GHz: the four UK/EU channels that need no radar detection (DFS).
  const channels = band === "5" ? [36, 40, 44, 48] : [1, 6, 11];
  console.log([
    "ENABLED=" + (c.enabled ? 1 : 0),
    "SSID=" + sh(ssid),
    "BAND=" + band,
    "CHANNEL=" + (channels.includes(Number(c.channel)) ? Number(c.channel) : channels[band === "5" ? 0 : 1]),
    "DOWN_KBYTES=" + int(c.downMbps, 1, 200, 10) * 125,
    "UP_KBYTES=" + int(c.upMbps, 1, 100, 3) * 125,
  ].join("\n"));
' "$CONF")"

# Which radio and which wired port to use (and a status file for the dashboard).
eval "$(node "$HW" shell "$CONF" "$STATE_DIR/portal-hardware.json")"

release_ports() {
  # Take every interface out of the guest bridge (it may be re-added below).
  local dev
  for dev in $(ip -o link show master "$BRIDGE" 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1); do
    run ip link set "$dev" nomaster || true
  done
}

if [[ "$ENABLED" != 1 ]]; then
  echo "guest Wi-Fi off"
  run systemctl stop pitchtribe-portal.service hostapd.service || true
  run systemctl stop dnsmasq.service || true
  run nft delete table inet pitchtribe_portal 2>/dev/null || true
  release_ports
  run ip link delete "$BRIDGE" 2>/dev/null || true
  # A previous guest session may have marked wlan0 unmanaged. Hand it back to
  # NetworkManager so station mode (including offline onboarding) can work.
  nm_conf="$ETC/NetworkManager/conf.d/99-pitchtribe-portal.conf"
  if [[ -f "$nm_conf" ]]; then
    run rm -f "$nm_conf"
    run systemctl reload NetworkManager 2>/dev/null || true
  fi
  exit 0
fi

# Setup owns the radio for its bounded physical-button window. A dashboard
# write or udev re-apply must never start the open guest AP during that window.
if [[ -e "$SETUP_ACTIVE" ]]; then
  echo "setup Wi-Fi owns the radio; refusing guest Wi-Fi activation" >&2
  run systemctl stop pitchtribe-portal.service hostapd.service dnsmasq.service || true
  exit 1
fi

if [[ -z "$WIFI_IF" && -z "$WIRED_IF" ]]; then
  echo "guest Wi-Fi is on, but there is no radio or access-point port to run it on — see Guest Wi-Fi → Hardware in the dashboard" >&2
  run systemctl stop hostapd.service || true
fi

# --- keep NetworkManager away from the guest network ----------------------------
if [[ -d "$ETC/NetworkManager/conf.d" ]]; then
  unmanaged="interface-name:$BRIDGE"
  [[ -n "$WIFI_IF" ]] && unmanaged+=";interface-name:$WIFI_IF"
  [[ -n "$WIRED_IF" ]] && unmanaged+=";interface-name:$WIRED_IF"
  nm_conf="$ETC/NetworkManager/conf.d/99-pitchtribe-portal.conf"
  next="$(printf '# Written by pitchtribe-portal-apply.\n[keyfile]\nunmanaged-devices=%s\n' "$unmanaged")"
  if [[ "$(cat "$nm_conf" 2>/dev/null)" != "$next" ]]; then
    printf '%s\n' "$next" >"$nm_conf"
    run systemctl reload NetworkManager 2>/dev/null || true
  fi
fi

# --- the guest bridge -------------------------------------------------------------
if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
  run ip link add "$BRIDGE" type bridge
fi
release_ports
run ip link set "$BRIDGE" up
run ip addr flush dev "$BRIDGE"
run ip addr add "$ADDR/$PREFIX" dev "$BRIDGE"
run sysctl -q -w net.ipv4.ip_forward=1

if [[ -n "$WIRED_IF" ]]; then
  run ip addr flush dev "$WIRED_IF"
  run ip link set "$WIRED_IF" master "$BRIDGE"
  run ip link set "$WIRED_IF" up
  # Guests on the access points can't reach guests on the Pi's own radio. The
  # access points must isolate their own clients (see the guest Wi-Fi docs).
  run bridge link set dev "$WIRED_IF" isolated on
fi

# --- access point ---------------------------------------------------------------
install -d -m 0755 "$ETC/pitchtribe" "$ETC/hostapd" "$ETC/dnsmasq.d"
if [[ -n "$WIFI_IF" ]]; then
  if [[ "$BAND" == 5 ]]; then
    radio_conf="hw_mode=a
ieee80211n=1
ieee80211ac=1"
  else
    radio_conf="hw_mode=g
ieee80211n=1"
  fi
  cat >"$ETC/hostapd/hostapd.conf" <<EOF
# Written by pitchtribe-portal-apply — edit in the PitchTribe dashboard (Guest Wi-Fi).
interface=${WIFI_IF}
bridge=${BRIDGE}
driver=nl80211
ssid=${SSID}
utf8_ssid=1
country_code=${PORTAL_COUNTRY:-GB}
ieee80211d=1
${radio_conf}
channel=${CHANNEL}
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=0
# Open network; stop guests talking to each other's devices.
ap_isolate=1
max_num_sta=60
EOF
  run rfkill unblock wlan 2>/dev/null || true
  run ip addr flush dev "$WIFI_IF"
fi

cat >"$ETC/dnsmasq.d/pitchtribe-portal.conf" <<EOF
# Written by pitchtribe-portal-apply.
interface=${BRIDGE}
bind-interfaces
except-interface=lo
dhcp-range=10.42.0.20,10.42.3.250,255.255.252.0,2h
dhcp-option=option:router,${ADDR}
dhcp-option=option:dns-server,${ADDR}
# RFC 8910: tell modern devices where the captive portal is.
dhcp-option=114,"http://${ADDR}/"
domain-needed
bogus-priv
EOF

# --- firewall ---------------------------------------------------------------------
cat >"$ETC/pitchtribe/portal.nft" <<EOF
# Written by pitchtribe-portal-apply.
table inet pitchtribe_portal
delete table inet pitchtribe_portal
table inet pitchtribe_portal {
  # Guests who accepted the terms; the portal adds them with a timeout.
  set allowed { type ipv4_addr; flags timeout; }
  set down_rate { type ipv4_addr; flags dynamic, timeout; timeout 1m; }
  set up_rate { type ipv4_addr; flags dynamic, timeout; timeout 1m; }

  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    # The portal address always shows the portal...
    iifname "${BRIDGE}" ip daddr ${ADDR} tcp dport 80 dnat ip to ${ADDR}:${PORTAL_PORT}
    # ...and unapproved guests' web requests go there too (this pops up the sign-in sheet).
    iifname "${BRIDGE}" ip saddr != @allowed tcp dport 80 dnat ip to ${ADDR}:${PORTAL_PORT}
  }

  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    iifname "${BRIDGE}" oifname "${UPLINK_IF}" masquerade
  }

  chain input {
    type filter hook input priority filter; policy accept;
    # Guests may only use DHCP, DNS and the portal on this Pi — not the dashboard.
    iifname "${BRIDGE}" udp dport { 53, 67 } accept
    iifname "${BRIDGE}" tcp dport { 53, ${PORTAL_PORT} } accept
    iifname "${BRIDGE}" icmp type echo-request accept
    iifname "${BRIDGE}" ct state established,related accept
    iifname "${BRIDGE}" drop
  }

  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "${BRIDGE}" ip saddr != @allowed drop
    # Internet only: never the club's own network.
    iifname "${BRIDGE}" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    # Per-device speed limits.
    iifname "${BRIDGE}" update @up_rate { ip saddr limit rate over ${UP_KBYTES} kbytes/second } drop
    oifname "${BRIDGE}" update @down_rate { ip daddr limit rate over ${DOWN_KBYTES} kbytes/second } drop
  }
}
EOF

# Keep current guests online across re-applies.
saved=""
[[ -z "$DRY" ]] && saved="$(nft -j list set inet pitchtribe_portal allowed 2>/dev/null || true)"
run nft -f "$ETC/pitchtribe/portal.nft"
if [[ -n "$saved" ]]; then
  node -e '
    const j = JSON.parse(process.argv[1]);
    const set = (j.nftables || []).find((x) => x.set)?.set;
    for (const e of set?.elem || []) {
      const ip = e.elem?.val ?? e;
      const left = e.elem?.expires;
      if (typeof ip === "string" && left > 0) console.log(`${ip} timeout ${left}s`);
    }
  ' "$saved" | while read -r ip _ t; do nft add element inet pitchtribe_portal allowed "{ $ip timeout $t }" || true; done
fi

if [[ -n "$WIFI_IF" ]]; then
  run systemctl unmask hostapd.service >/dev/null 2>&1 || true
  run systemctl restart hostapd.service
  # hostapd has now added the radio to the bridge; isolate it from the wired port.
  run bridge link set dev "$WIFI_IF" isolated on || true
fi
run systemctl restart dnsmasq.service
run systemctl restart pitchtribe-portal.service

where=()
[[ -n "$WIFI_IF" ]] && where+=("${WIFI_IF} (${BAND} GHz, channel ${CHANNEL})")
[[ -n "$WIRED_IF" ]] && where+=("access points on ${WIRED_IF}")
echo "guest Wi-Fi “${SSID}” on ${where[*]:-nothing} (down ${DOWN_KBYTES} kB/s, up ${UP_KBYTES} kB/s per device)"
