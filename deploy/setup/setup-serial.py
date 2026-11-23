#!/usr/bin/env python3
"""GPIO17-gated, short UART disclosure. Stdout and logs never hold the key."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import termios
import time

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if os.geteuid() != 0:
        raise RuntimeError("root required")
    spec = importlib.util.spec_from_file_location("identity", "/usr/local/lib/pitchtribe/setup-identity.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    data = module.checked()
    from gpiozero import Button
    button = Button(17, pull_up=True, bounce_time=0.05)
    try:
        while True:
            button.wait_for_press()
            start = time.monotonic()
            while button.is_pressed and time.monotonic() - start < 3:
                time.sleep(0.02)
            if button.is_pressed and time.monotonic() - start >= 3:
                break
        # UART is disabled by config.txt at boot. A runtime overlay limits pin
        # ownership to this window; failure to materialize the device is fatal.
        run("dtoverlay", "uart0")
        try:
            path = Path("/dev/serial0")
            for _ in range(20):
                if path.exists() and stat.S_ISCHR(path.stat().st_mode):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("UART device did not appear")
            fd = os.open(path, os.O_WRONLY | os.O_NOCTTY | os.O_CLOEXEC | os.O_NONBLOCK)
            try:
                attrs = termios.tcgetattr(fd)
                attrs[0] = attrs[1] = attrs[3] = 0
                attrs[2] = termios.CS8 | termios.CLOCAL | termios.CREAD
                attrs[4] = attrs[5] = termios.B115200
                termios.tcsetattr(fd, termios.TCSANOW, attrs)
                # Only the UART receives the credential. No HDMI, journal,
                # shell argument, guest portal, or dashboard output is used.
                os.write(fd, ("PitchTribe owner setup\r\nSSID: " + data["ssid"] +
                              "\r\nKey: " + data["key"] + "\r\n").encode("ascii"))
                termios.tcdrain(fd)
                time.sleep(20)
            finally:
                os.close(fd)
        finally:
            run("dtoverlay", "-r", "uart0")
    finally:
        button.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Deliberately omit exception text: a future dependency could include
        # a secret in it. systemd logs only this generic failure marker.
        print("setup serial retrieval failed closed", file=sys.stderr)
        sys.exit(1)
