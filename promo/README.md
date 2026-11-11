# Promo capture kit

Builds the **Ashworth Rovers FC** demo content on a PitchTribe instance and
records the player and dashboard for the promotional video (PIT-30). Every
slide in the film is a real PitchTribe content type played by the real player,
so the captures can be redone after any product change.

Ashworth Rovers FC is invented for this film. Opponents, prices, times, the
crest and the Wi-Fi network are all made up. The crest in `crest/` was drawn
for this project and is free to use.

## What is here

| Path | Purpose |
|---|---|
| `seed.js` | Creates the content library, the "Promo reel" and "Clubhouse TV" playlists, two screens, sports feeds, weather, buses and the guest Wi-Fi branding, through the dashboard API. Idempotent. |
| `capture.js` | Records every shot with Playwright and ffmpeg. Deterministic: the browser clock is stepped one frame at a time, so slide changes land on the same frame every run. |
| `crest/ashworth-rovers-crest.svg` | The club crest, green and white shield. |
| `tools/fetch-chromium-libs.js` | For machines without root: unpacks the Debian libraries Chromium needs into a local sysroot. |
| `out/` | Generated: `seed.json` (ids the capture needs) and the renders. Not committed. |

## Re-running the capture

```bash
# 1. A throwaway PitchTribe instance on its own port and data directory
cd app && npm ci && DATA_DIR=/tmp/promo-data PORT=8090 npm start

# 2. Seed it (first run creates the dashboard with password promo-reel-2026)
cd promo && npm ci && npx playwright install chromium
node seed.js

# 3. Record. Each shot can be run on its own: loop, hero, vertical, dashboard, wifi
node capture.js
```

Renders land in `out/`:

| File | What it is |
|---|---|
| `loop-full-1080p.webm` | The "Promo reel" playlist, one 30 s pass plus 1 s, 1920x1080, 60 fps. The Silent loop. |
| `hero-05-notice.webm` … `hero-09c-widget-quiz.webm` | 6 s per slide type for the Hero cut, plus a `.png` poster of each. |
| `vertical-full-1080x1920.webm` | The reel from the portrait screen (Rotation: Portrait 90°), turned upright. |
| `act4-dashboard-390x844.webm` | Phone dashboard: drag a notice above the menu, change 10 to 15 s, Save, Preview. |
| `wifi-splash-390x844.webm` and `.png` | The guest Wi-Fi splash page from the Wi-Fi tab's live preview. |

Options: `FPS=30` for quicker test renders, `LOOP_SECONDS=9` to shorten the
reel, `KEEP_LOGOS=1` to leave team logos on the Live scores slide (hidden by
default so no third-party crests appear in the film), `BASE`, `PASSWORD`,
`OUT`.

On a machine where `npx playwright install-deps` is not possible:

```bash
node tools/fetch-chromium-libs.js        # unpacks into promo/.sysroot
SYSROOT=.sysroot node capture.js
```

## How the capture stays deterministic

`capture.js` pauses Chromium's virtual time (CDP `Emulation.setVirtualTimePolicy`),
then for each frame advances it by 1/60 s and takes a screenshot, piping the
PNGs into ffmpeg (VP9, `-crf 24`). Timers, `Date.now()`, CSS animations and
transitions all follow the stepped clock, so the ticker speed, fade length and
slide durations in the file match the playlist exactly regardless of how fast
the machine is. Network fetches (scores, weather, buses) pause the clock until
they settle; a feed that never answers is logged and skipped after 20 s.

The dashboard shot drives real pointer input between frames. HTML5
drag-and-drop does not always complete under synthetic input, so if the order
has not changed after the drag the script fires the product's own drop handler
so the screen shows the real result.

## Backup

Settings → Backups → **Download backup** in the dashboard, or
`GET /api/backup/download` while signed in, exports the whole instance as a
`.tar.gz` that any PitchTribe can import from its first-run screen.
