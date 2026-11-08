# PitchTribe signage app

Self-hosted digital signage for clubs, in the spirit of [Anthias](https://anthias.screenly.io/).
One Node.js server runs on a Raspberry Pi. It has two parts:

- **Dashboard** (`/admin/`): a mobile-friendly web app where club volunteers upload content,
  build playlists, set timings and manage screens.
- **Player** (`/player/?screen=<id>`): the full-screen page each TV shows. On a Pi it runs in a
  Chromium kiosk that starts on boot.

## Features

| Area | What you get |
| --- | --- |
| **Content library** | Drag-and-drop upload of images (JPG/PNG/GIF/WebP/SVG) and videos (MP4/WebM/MOV), plus built-in slide types: **notices** (5 colour themes), **menu boards** (sections, prices, notes, *sold out*), **fixture lists** (past games hide themselves, countdown to the next one) and **web pages**. |
| **Playlists** | Drag to reorder (or up/down on phones), per-item duration, on/off toggle, a scrolling ticker, a clock overlay and a live preview. |
| **Timings** | Per-item start/end dates, days of the week and a daily time window, including windows that run past midnight (e.g. 18:00–01:00). Presets cover Weekdays, Weekends, Lunch, Evenings and Today only. Each item shows a status badge: *Live now*, *Scheduled*, *Off-hours* or *Expired*. |
| **Screens** | Screens register themselves on first connect. From the dashboard you can rename a screen, assign its playlist, rotate it for portrait mounting, see whether it's online and its resolution, flash its name with **Identify**, or **Reload** it remotely. |
| **Live scores** | Fixtures, live scores and results from the built-in [`signage-server`](../signage-server/README.md) sports engine (Premier League, Championship, SPFL, Champions League, NFL, NBA). Choose leagues in **Settings → Sports feeds**, then add **Live scores** slides to any playlist. Scores refresh every minute while matches are live and are pushed straight to screens. The engine's display page, JSON API and MCP endpoint are served at `/feeds`. |
| **Widgets** | From the same engine: **clock** (digital, analogue or countdown to kick-off), **world clocks**, **weather** for your ground (Open-Meteo, no API key), **jokes** with a punchline reveal, club-spirit **phrases**, **Did you know?** trivia and a multiple-choice **quiz** with an answer reveal (both on sport, film & TV, music, geography, culture or a mix), an **emoji quiz** (guess the film, TV show or song), **flags & capitals**, **country of the day**, **on this day** (this day, week or month in sporting or TV/film/music history, optionally with general history from Wikipedia), and **spot the ball**. For spot the ball you mark the ball on your own photo; screens show a grid and a blurred patch, and reveal the answer at the time you choose. The answer isn't sent to screens before then. Everything except weather and Wikipedia is bundled, so it works offline. You can add your own lines, and a fresh selection is picked each day. |
| **Transport hub** | One slide with any mix of: a **live bus tracker** for chosen routes near the ground (anywhere in England, via the Bus Open Data Service with a free key), **train departures** (National Rail Darwin via a Huxley2 proxy), London **bus arrivals**, **tube & rail line status** and **main roads** (TfL), and **planes overhead** (adsb.lol). |
| **More live data** | Sunrise, sunset & moon (calculated), UK bank holidays (GOV.UK), flood warnings (Environment Agency), grid carbon intensity (NESO), earthquakes (USGS), exchange rates (ECB), Wikimedia picture of the day, born on this day (Wikipedia), Open Trivia DB questions, plus **news headlines** from any RSS/Atom feed and **events** from any iCal calendar. Licences and attribution are covered in [`signage-server/DATA_SOURCES.md`](../signage-server/DATA_SOURCES.md). |
| **Languages** | Screens can show built-in labels, dates and times in English, French, Spanish, German, Italian, Portuguese, Polish, Russian, Chinese or Japanese. Set a club default, then override it per screen if needed. Your own content isn't translated. Built-in quiz and joke packs are English. |
| **Guest Wi-Fi** | A captive portal on the Pi's built-in Wi-Fi, with the Pi plugged into the club router by cable. Guests see your branded sign-in page: logo, colour, message, terms of use, and optionally an email box with a separate, unticked consent box. They then get internet for a set session with per-device speed limits. Guests can never reach the club network or the dashboard. Manage it under **Wi-Fi** in the dashboard: live preview, connection counts, CSV export of consented emails. |
| **Backups** | Nightly backups to a USB stick left in the Pi (**Settings → Backups**): the last 30 snapshots of settings, plus each photo and video copied once. After re-imaging a failed card, the first-run screen offers to restore from the stick. **Download backup** and **Restore from file** do the same with a `.tar.gz`. The USB side is a root helper, `bin/backup.js`, run by `pitchtribe-backup@.service`. |
| **Remote access** | **Settings → Remote access** switches SSH on or off and sets its username and password. It needs the dashboard password again. The SSH password is hashed (SHA-512 crypt) before it touches the disk, and a root helper, `bin/remote-access.js`, creates the login and starts SSH. |
| **Live updates** | Changes reach screens within about a second over Server-Sent Events, with a 60 s heartbeat poll as a fallback. |
| **Resilience** | Screens evaluate schedules locally and cache the last playlist, so they keep playing if the server restarts or the network drops. |
| **Security** | One admin password (scrypt), signed HttpOnly SameSite=Strict session cookies, a CSRF header check, login rate limiting and strict CSP. Uploaded files are served sandboxed. |

## Run it

```bash
cd app
npm ci                 # also links ../signage-server
npm start              # http://localhost:8080/admin/  (PORT, HOST, DATA_DIR, MAX_UPLOAD_MB)
                       # HTTPS_PORT=8443 also serves https, with a certificate it makes itself
npm test
```

Open the dashboard and create the admin password; a starter playlist with a welcome notice is
set up for you. Then open `http://<server>:8080/player/?screen=bar-tv` on any screen.
It appears under **Screens**, already playing the default playlist.

## Install on a Raspberry Pi

The easiest way is the ready-made SD card image, or the one-line installer. Both are described in the [setup guide](https://pitchtribe.media/docs/setup). To install by hand on Raspberry Pi OS Trixie or Bookworm (Lite is fine), on a Pi 4 or Pi 5:

```bash
sudo apt-get install -y git
git clone https://github.com/pitchtribe/pitchtribe-display pitchtribe
sudo pitchtribe/deploy/install.sh
```

This installs Node 22, the server as `pitchtribe.service` on port 80 (data in `/var/lib/pitchtribe`),
and `pitchtribe-kiosk.service`, which is Chromium inside the `cage` Wayland kiosk on HDMI.
It also sets up mDNS so the dashboard is at `http://<hostname>.local`. Each Pi's screen id is
its hostname.

Guest Wi-Fi is opt-in: `sudo PITCHTRIBE_PORTAL=1 pitchtribe/deploy/install.sh`. It installs hostapd, dnsmasq and nftables, plus
`pitchtribe-portal.service` (the guest-facing portal on 10.42.0.1:8082, its only privilege `CAP_NET_ADMIN`).
It also installs `pitchtribe-portal-apply`, a root helper that rewrites the access-point and firewall configuration whenever the dashboard saves
Wi-Fi settings. The Pi needs its network cable for the internet; its Wi-Fi becomes the guest network.

Running several screens? Install the full stack on one Pi (the hub). On every other Pi, install
only the kiosk and point it at the hub:

```bash
sudo PITCHTRIBE_SERVER=http://clubhouse.local pitchtribe/deploy/install.sh
```

Use `PITCHTRIBE_NO_KIOSK=1` for a headless server. Re-run the installer to upgrade; your data is kept.

Forgotten the dashboard password? `sudo pitchtribe-reset-password` on the Pi sets a new one and signs everyone out. Content is kept.

## How it works

```
app/
  server.js               entry point
  lib/app.js              Express app: auth, dashboard API, player API, static files
  lib/store.js            JSON-file database (atomic writes) in DATA_DIR/db.json
  lib/hub.js              Server-Sent Events push to screens
  lib/auth.js             password hashing, signed session cookies, login limiter
  lib/tls.js              the self-signed certificate the Pi makes for its own HTTPS
  lib/validate.js         input sanitisers
  public/admin/           dashboard SPA (vanilla JS, no build step)
  public/player/          kiosk player
  public/shared/          schedule + text-format parsers, shared by server, dashboard and player
  lib/feeds.js            embeds ../signage-server (sports + widgets) and mounts it at /feeds
  lib/portal.js           guest Wi-Fi captive portal (run by portal-server.js as its own service)
  lib/portal-page.js      splash / connected pages (server-rendered, no JavaScript)
signage-server/           the engine (sports + widgets): a dependency of app/ (file:../signage-server), also runs standalone
deploy/                   Raspberry Pi installer, systemd units, kiosk launcher
```

Uploads go to `DATA_DIR/media/` under random file names and are cached as immutable.
To back up, copy `DATA_DIR`.

### API overview

| Method & path | Purpose |
| --- | --- |
| `GET /api/player/:screenId/manifest` | Screen's playlist (registers the screen; no login, LAN only) |
| `GET /api/player/:screenId/events` | SSE stream: `changed`, `identify`, `reload` |
| `POST /api/auth/setup` · `login` · `logout` | First-run setup and sessions |
| `GET /api/state` | Everything the dashboard needs |
| `POST /api/assets/upload` | Raw-body media upload (`Content-Type`, `X-Filename`) |
| `POST/PATCH/DELETE /api/assets[/:id]` | Notices, menus, fixtures, web pages, and media settings |
| `POST/PUT/DELETE /api/playlists[/:id]` | Playlists with items and timings |
| `PATCH/DELETE /api/screens/:id`, `POST /api/screens/:id/command` | Screen settings, identify and reload |
| `PUT /api/settings/sports`, `POST /api/sports/refresh` | Sports feed settings and manual refresh |
| `PUT /api/settings/widgets`, `GET /api/geocode?q=` | Weather location, Wikipedia on/off, place search |
| `GET/PUT /api/portal`, `GET /api/portal/preview`, `GET /api/portal/guests.csv`, `DELETE /api/portal/guests` | Guest Wi-Fi settings, stats, splash preview, email export |
| `GET /feeds/display`, `/feeds/api/*`, `/feeds/api/widgets/:kind` · `POST /feeds/mcp` | The engine's routes (POST needs its bearer token or a dashboard session) |

All dashboard calls need the session cookie, and every mutation also needs the `X-PitchTribe: 1` header.
