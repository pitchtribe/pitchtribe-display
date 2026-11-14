#!/usr/bin/env bash
# What the clubhouse card did while nobody was watching.
#
#   soak-watch sample    one sample  (run by pitchtribe-soak.timer, once a minute)
#   soak-watch report    the week, summarised, with a verdict per "done" criterion
#   soak-watch event "…" note something a human did, e.g. "pulled the mains"
#
# This exists because "runs unattended for seven days" is a claim somebody has to be able
# to check afterwards, and a Pi that has been quietly restarting every six hours looks
# exactly like a Pi that has been fine. It is a test instrument, not part of the product:
# nothing here phones home, nothing leaves the card, and the card is no more reachable
# with this installed than without it. See SOAK.md.
#
# SD-card wear is an explicit constraint of this project, so the write path is deliberate:
# the minute-by-minute samples go to tmpfs and are capped, and the only thing that touches
# the card is one line an hour plus one line per event worth keeping. A week of soaking
# costs about 200 lines.
set -uo pipefail

RUN_DIR="${PITCHTRIBE_SOAK_RUN_DIR:-/run/pitchtribe-soak}"
STATE_DIR="${PITCHTRIBE_SOAK_STATE_DIR:-/var/lib/pitchtribe-soak}"
SAMPLES="$RUN_DIR/samples.tsv"
LOG="$STATE_DIR/soak.log"
MAX_SAMPLES="${PITCHTRIBE_SOAK_MAX_SAMPLES:-20160}"   # 14 days at one a minute
ORIGIN="${PITCHTRIBE_SOAK_ORIGIN:-http://localhost}"
UNITS="${PITCHTRIBE_SOAK_UNITS:-pitchtribe-kiosk.service pitchtribe.service pitchtribe-signage.service}"

mkdir -p "$RUN_DIR" "$STATE_DIR" 2>/dev/null || true

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One line on the card. Called for the hourly heartbeat and for anything notable — a
# restart, an outage starting or ending, a boot, a human pulling a cable.
note() {
  printf '%s\t%s\n' "$(now_iso)" "$*" >>"$LOG" 2>/dev/null || true
}

# ---------------------------------------------------------------------------- sampling

# Restarts since boot, summed over the units that matter. systemd keeps this, so a card
# that has been flapping cannot present itself as a card that has been up.
restarts() {
  local total=0 n
  for unit in $UNITS; do
    n="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null)"
    [[ "$n" =~ ^[0-9]+$ ]] && total=$((total + n))
  done
  printf '%s' "$total"
}

# Is the browser still there, and how big has it got? A leak over six days is the failure
# this whole exercise is looking for, and it is invisible in a screenshot.
chromium_rss_kb() {
  local kb
  kb="$(ps -eo rss,comm --no-headers 2>/dev/null | awk '$2 ~ /chrom/ { s += $1 } END { print s+0 }')"
  printf '%s' "${kb:-0}"
}

# Under-voltage and thermal throttling, which on a Pi is the difference between "the
# software is unreliable" and "the power supply is". Bit 0 under-voltage now, bit 16
# under-voltage since boot, bits 2/18 throttled.
throttled() {
  local raw
  raw="$(vcgencmd get_throttled 2>/dev/null)" || { printf 'na'; return; }
  printf '%s' "${raw#throttled=}"
}

cpu_temp_c() {
  local raw
  raw="$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)" || { printf 'na'; return; }
  printf '%s' "$((raw / 1000))"
}

# The server's own account of itself: is it answering, and how old is the data it would
# put on screen? Stale-but-dated is the brief's requirement, so age is the thing to watch,
# not just whether the port is open.
health() {
  local body
  body="$(curl -fsS --max-time 5 "$ORIGIN/api/health" 2>/dev/null)" || { printf 'down\tna'; return; }
  local updated
  # The server pretty-prints, so the whitespace and the newlines go before the match.
  updated="$(printf '%s' "$body" | tr -d ' \t\n' | sed -n 's/.*"updatedAt":"\([^"]*\)".*/\1/p')"
  if [[ -z "$updated" ]]; then printf 'up\tna'; return; fi
  local age=$(( $(date -u +%s) - $(date -u -d "$updated" +%s 2>/dev/null || echo 0) ))
  printf 'up\t%s' "$age"
}

# Does the wall itself still render? A server answering JSON while the page 500s is a
# black television, so the page is fetched too — the same URL the kiosk is pointed at.
wall_status() {
  local code
  # -w prints the code on failure too, so the fallback is only for curl writing nothing
  # at all; without this the two spellings of "no answer" concatenate into "000000".
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$ORIGIN/clubhouse" 2>/dev/null)"
  printf '%s' "${code:-000}"
}

internet() {
  # The brief calls no internet a normal condition, so this is recorded, not alarmed at.
  curl -fsS -o /dev/null --max-time 5 https://www.google.com/generate_204 2>/dev/null \
    && printf 'up' || printf 'down'
}

sample() {
  local ts up_s r rss thr temp hs page net
  ts="$(now_iso)"
  up_s="$(cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1)"
  r="$(restarts)"
  rss="$(chromium_rss_kb)"
  thr="$(throttled)"
  temp="$(cpu_temp_c)"
  hs="$(health)"            # two fields: state and data age
  page="$(wall_status)"
  net="$(internet)"
  local mem_avail
  mem_avail="$(awk '/MemAvailable/ { print $2 }' /proc/meminfo 2>/dev/null)"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ts" "${up_s:-0}" "$r" "$rss" "${mem_avail:-0}" "$thr" "$temp" "$hs" "$page" "$net" \
    >>"$SAMPLES"

  # Cap the tmpfs file so a long soak cannot fill /run.
  local lines
  lines="$(wc -l <"$SAMPLES" 2>/dev/null || echo 0)"
  if (( lines > MAX_SAMPLES )); then
    tail -n "$((MAX_SAMPLES / 2))" "$SAMPLES" >"$SAMPLES.trim" && mv "$SAMPLES.trim" "$SAMPLES"
  fi

  # --- what reaches the card: state changes, and one heartbeat an hour.
  local prev_marker="$RUN_DIR/last-state"
  local marker="$r|${hs%%$'\t'*}|$page|$net"
  local prev=""
  [[ -f "$prev_marker" ]] && prev="$(cat "$prev_marker")"
  printf '%s' "$marker" >"$prev_marker"

  if [[ "$prev" != "$marker" ]]; then
    if [[ -n "$prev" ]]; then
      note "change restarts=$r health=${hs%%$'\t'*} wall=$page net=$net (was ${prev//|/ })"
    else
      # No previous marker in tmpfs means tmpfs is new, which means the Pi has booted.
      note "boot uptime=${up_s}s restarts=$r health=${hs%%$'\t'*} wall=$page net=$net throttled=$thr"
    fi
  fi

  local stamp="$RUN_DIR/last-hourly"
  local hour
  hour="$(date -u +%Y-%m-%dT%H)"
  if [[ ! -f "$stamp" || "$(cat "$stamp")" != "$hour" ]]; then
    printf '%s' "$hour" >"$stamp"
    note "hourly uptime=${up_s}s restarts=$r chromium_rss_kb=$rss mem_avail_kb=${mem_avail:-0} throttled=$thr temp=${temp}C health=${hs//$'\t'/ age=} wall=$page net=$net"
  fi
}

# ----------------------------------------------------------------------------- the report

report() {
  if [[ ! -s "$SAMPLES" ]]; then
    echo "No samples in $SAMPLES. Is pitchtribe-soak.timer running?"
    return 1
  fi
  awk -F'\t' '
    NR == 1 { first = $1 }
    {
      last = $1; n++
      up = $2 + 0; r = $3 + 0; rss = $4 + 0; avail = $5 + 0; thr = $6; temp = $7 + 0
      hstate = $8; age = $9; page = $10; net = $11

      if (up < prev_up) boots++           # uptime going backwards is a reboot
      prev_up = up
      if (n > 1 && r > max_r) restart_events++
      if (r > max_r) max_r = r
      if (rss > max_rss) max_rss = rss
      if (avail > 0 && (min_avail == 0 || avail < min_avail)) min_avail = avail
      if (temp > max_temp) max_temp = temp
      if (thr != "na" && thr != "0x0") throttle = thr
      if (hstate == "down") down++
      if (page != "200") page_bad++
      if (net == "down") net_down++
      if (age != "na") { seen_age = 1; if (age + 0 > max_age) max_age = age + 0 }
      if (hstate == "down" || page != "200") { run++; if (run > worst_run) worst_run = run } else run = 0
    }
    END {
      printf "soak window    %s  →  %s   (%d samples, %.1f days)\n", first, last, n, n / 1440.0
      printf "reboots        %d\n", boots
      printf "service restarts %d (NRestarts peaked at %d)\n", restart_events, max_r
      printf "wall page      %d of %d samples not HTTP 200%s\n", page_bad, n, (page_bad ? "" : "  — never once")
      printf "server         %d samples with /api/health down\n", down
      printf "longest gap    %d consecutive minutes with no wall\n", worst_run
      if (seen_age)
        printf "data age       worst %d s (%.1f h) — stale is allowed, undated is not\n", max_age, max_age / 3600.0
      else
        printf "data age       never read — the server did not answer once\n"
      printf "chromium       peak RSS %d MB\n", max_rss / 1024
      printf "memory         least available %d MB\n", min_avail / 1024
      printf "temperature    peak %d C\n", max_temp
      printf "power/thermal  %s\n", (throttle == "" ? "no under-voltage or throttling flagged" : "FLAGGED: " throttle " — suspect the power supply, not the software")
      printf "internet       %d samples offline (the brief calls this normal)\n", net_down
      print  ""
      print  "verdict, against the brief:"
      printf "  seven days unattended      %s\n", (n >= 7 * 1440 * 0.98 ? "PASS — a week of samples, no gaps" : "NOT YET — needs " int(7 * 1440 * 0.98) " samples, has " n)
      printf "  recovers by itself         %s\n", (boots > 0 ? (worst_run <= 5 ? "PASS — rebooted " boots "x, back inside 5 min each time" : "FAIL — a reboot left the wall down " worst_run " min") : "UNTESTED — nobody has cut the power yet")
      printf "  no leak over the week      %s\n", (max_rss / 1024 < 1200 ? "PASS — peak " int(max_rss / 1024) " MB" : "LOOK — peak " int(max_rss / 1024) " MB, check the trend not the peak")
      printf "  never a blank screen       %s\n", (page_bad == 0 ? "PASS" : "LOOK — " page_bad " samples without a page")
    }
  ' "$SAMPLES"

  echo
  echo "what reached the card (last 20 lines of $LOG):"
  tail -n 20 "$LOG" 2>/dev/null || echo "  (nothing yet)"
}

case "${1:-sample}" in
  sample) sample ;;
  report) report ;;
  event)  shift; note "event ${*:-unspecified}"; echo "noted" ;;
  *) echo "usage: soak-watch [sample|report|event \"what happened\"]" >&2; exit 2 ;;
esac
