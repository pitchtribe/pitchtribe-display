#!/usr/bin/env python3
"""Root-only, first-boot identity for the physical Wi-Fi setup path.

No identity is created in the shared image. The JSON file is the sole source
for both the AP key and the owner label, including after an explicit rotation.
"""
import base64
import json
import os
from pathlib import Path
import re
import sys
import uuid

STATE = Path(os.environ.get("PITCHTRIBE_SETUP_STATE", "/var/lib/pitchtribe-setup"))
IDENTITY = STATE / "identity.json"


def identity():
    # 100 bits from the kernel CSPRNG, represented by exactly 20 Base32 chars.
    key = base64.b32encode(os.getrandom(13)).decode("ascii")[:20]
    suffix = uuid.uuid4().hex[:6].upper()
    return {"ssid": "PitchTribe-Setup-" + suffix, "key": key}


def checked():
    st = IDENTITY.lstat()
    if not IDENTITY.is_file() or st.st_uid != 0 or st.st_gid != 0 or st.st_mode & 0o777 != 0o600:
        raise RuntimeError("setup identity ownership or mode invalid")
    data = json.loads(IDENTITY.read_text(encoding="ascii"))
    if not re.fullmatch(r"[A-Z2-7]{20}", data.get("key", "")):
        raise RuntimeError("setup key invalid")
    if not re.fullmatch(r"PitchTribe-Setup-[A-F0-9]{6}", data.get("ssid", "")):
        raise RuntimeError("setup SSID invalid")
    return data


def write_new(replace=False):
    if os.geteuid() != 0:
        raise RuntimeError("root required")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if STATE.stat().st_uid != 0 or STATE.stat().st_mode & 0o777 != 0o700:
        raise RuntimeError("setup state directory ownership or mode invalid")
    if replace:
        if Path("/run/pitchtribe-setup/active").exists():
            raise RuntimeError("cannot rotate during a setup window")
        checked()
    elif IDENTITY.exists() or IDENTITY.is_symlink():
        checked()  # Upgrades must never replace an existing valid key.
        return
    tmp = STATE / (".identity-" + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as file:
            json.dump(identity(), file, separators=(",", ":"))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.chown(tmp, 0, 0)
        if replace:
            os.replace(tmp, IDENTITY)
        else:
            os.link(tmp, IDENTITY)  # Fails if another first-boot writer won.
            tmp.unlink()
        dir_fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("provision", "rotate", "check"):
            raise RuntimeError("usage: setup-identity.py provision|rotate|check")
        if sys.argv[1] == "check":
            checked()
        else:
            write_new(sys.argv[1] == "rotate")
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print("setup identity unavailable: " + str(exc), file=sys.stderr)
        sys.exit(1)
