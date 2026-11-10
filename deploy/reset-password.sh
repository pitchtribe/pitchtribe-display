#!/usr/bin/env bash
# Sets a new PitchTribe dashboard password, for when it has been forgotten.
# Installed by deploy/install.sh as /usr/local/bin/pitchtribe-reset-password.
#
#   sudo pitchtribe-reset-password
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/pitchtribe}"
APP_DIR="${APP_DIR:-/opt/pitchtribe}"

[[ $EUID -eq 0 ]] || { echo "Run it with sudo:  sudo pitchtribe-reset-password" >&2; exit 1; }

read -rsp "New dashboard password (at least 8 characters): " p1; echo
read -rsp "Type it again: " p2; echo
[[ "$p1" == "$p2" ]] || { echo "The two passwords don't match. Nothing was changed." >&2; exit 1; }
[[ ${#p1} -ge 8 ]] || { echo "That's shorter than 8 characters. Nothing was changed." >&2; exit 1; }

# The server keeps the database in memory, so stop it while the file changes.
systemctl stop pitchtribe.service
trap 'systemctl start pitchtribe.service' EXIT
PT_PASSWORD="$p1" node "$APP_DIR/app/bin/reset-password.js" "$DATA_DIR/db.json"
chown pitchtribe:pitchtribe "$DATA_DIR/db.json"
# The file holds the password hash, the session signing secret and every API
# key. reset-password.js writes it 0600; this is the belt to that braces.
chmod 600 "$DATA_DIR/db.json"
