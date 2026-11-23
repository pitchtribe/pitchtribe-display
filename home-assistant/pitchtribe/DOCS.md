# PitchTribe for Home Assistant

This preview packages the full PitchTribe signage server for Home Assistant OS
on aarch64 (including 64-bit Raspberry Pi) or amd64. It is a local app (formerly
called an add-on), not a HACS integration. Home Assistant Container does not have
an app store. The archive contains the app and sports engine source; installation
builds it locally and requires internet access to download Node and npm packages.

## Install

1. Extract `pitchtribe-home-assistant.tar.gz`. Copy the entire `pitchtribe` folder
   into Home Assistant's `local_apps` share (or `/local_apps` through Terminal & SSH).
   Older installations expose this as the `addons` share or `/addons`; use the
   local-app folder provided by your installation. Inside it, the result must
   include `pitchtribe/config.json`, `pitchtribe/Dockerfile` and
   `pitchtribe/source/`. The Samba share app provides network access to this folder.
2. In **Settings → Apps → Install app**, use the menu to check for updates/reload.
   Older Home Assistant versions call this **Add-ons → Add-on store**.
3. Under **Local apps**, open **PitchTribe**, install it and start it. Enable
   **Start on boot**. If port 8080 is already used, change its Network port first.
4. Select **Open Web UI** and create your PitchTribe administrator password.
5. On each TV/browser open
   `http://HOME_ASSISTANT_IP:8080/player/?screen=lounge-tv`.
   Use a different screen ID for each TV and the selected port if you changed it.
   Manage content and playlists at `http://HOME_ASSISTANT_IP:8080/admin/`.

The UI opens directly on the local network, with PitchTribe's own login.
Home Assistant ingress and Home Assistant remote-access URLs are not supported.
Do not forward this port to the internet. No Supervisor or Home Assistant API
token, host networking, device mappings or privileged mode is requested.

## Storage and backups

Settings, uploaded media and feed state live in `/data/pitchtribe`, which survives
app restarts and upgrades. Include PitchTribe in Home Assistant backups. Stop
the app before taking a backup for a consistent copy, then restart it. Back up
before uninstalling: uninstalling can remove app data. To upgrade a local package,
replace the folder with the newer version and reload the app store.

## What works here

Dashboard, content uploads, playlists, scheduling, browser players, sports feeds
and widgets are hosted by this app. TVs still need their own browser or kiosk
hardware. Installing this app does not turn the Home Assistant host's HDMI output
into a signage player.

Pi operating-system controls (guest Wi-Fi access point, SSH administration,
USB backup helpers, OS updates and local HDMI kiosk) require the standalone Pi
installation. Some of those controls remain visible in the current dashboard;
do not use them in this package. Use Home Assistant for app updates and backups.

## Preview validation

This is a preview package. Dependency installation and 22 authentication/signage API tests passed.
The health suite passed one check and failed eight because this development
host reports low available memory (extra `memory-low` warnings). Docker image builds and a real Supervisor install
must still be verified on a Home Assistant OS host before production use.

References:
- https://contributors.home-assistant.io/apps/first-app/
- https://developers.home-assistant.io/docs/apps/configuration
