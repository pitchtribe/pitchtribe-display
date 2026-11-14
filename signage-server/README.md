# PitchTribe signage server

This server collects sports fixtures, live scores and results on a schedule, and serves content for screen widgets (see [Widgets](#widgets) and [DATA_SOURCES.md](DATA_SOURCES.md)). It shows them as a
full-screen, auto-rotating display page for club screens. It also pushes the data to other
signage systems through **webhooks**, a **JSON API** and **MCP**.

For one club's own screen there is a second page, **`/clubhouse`** — single-idea slides, the
club's own photographs, and its own opening hours. See [CLUBHOUSE.md](CLUBHOUSE.md).

It has no dependencies and needs Node 20 or later. It runs on a Raspberry Pi 5.

```
 ESPN scoreboard feeds ─┐                   ┌─► GET /display     (screens in kiosk mode, live-updating)
 the club's own file ───┼─► store (cache) ──┼─► GET /clubhouse   (one club's wall — CLUBHOUSE.md)
   every 10 min,        │   change-detect   ├─► GET /api/*       (JSON for any CMS / app)
   every 60 s when live ┘                   ├─► webhook push     (POST JSON or HTML to your signage system)
                                            └─► MCP              (stdio, or POST /mcp)
```

## Two ways to run it

- **Inside the PitchTribe app (recommended).** `app/` depends on this package (`file:../signage-server`).
  It runs the engine in the same process and serves every route below under **`/feeds`**, for example
  `/feeds/display`, `/feeds/api/snapshot`, `/feeds/api/widgets/weather` and `/feeds/mcp`. Leagues are chosen in the dashboard
  (**Settings → Sports feeds**). Screens show scores as **Live scores** slides in normal playlists.
  POST routes need the dashboard's sports API token, shown on that settings page. `deploy/install.sh`
  installs both packages together.
- **Standalone**, as described in the rest of this file: `npm start` on its own port, configured with
  `config.json`.

As a library, `import { createSportsService, resolveConfig } from 'pitchtribe-signage-server'` returns
the store, the MCP handler and an HTTP `handler(req, res)` you can mount anywhere.

## Widgets

The server also provides content for screen widgets:

| Widget | Source | Notes |
| --- | --- | --- |
| `weather` | [Open-Meteo](https://open-meteo.com) (no API key) | Current conditions and a 7-day forecast for `config.weather` (`place`, `latitude`, `longitude`, `windUnit`). Cached for 15 minutes. |
| `joke`, `phrase`, `trivia`, `quiz` | `data/widgets/*.json` (bundled) | A day-stable random selection of 20. Pass `extra` (your own lines) and `only`. Quiz lines use `Question \| right \| wrong \| wrong \| wrong`. `trivia` and `quiz` take `topic=sport\|film-tv\|music\|geography\|culture\|mixed`. |
| `emoji` | `data/widgets/emoji.json` | Guess the film, TV show or song. `category=Film\|TV\|Song`. Extra lines use `emojis \| answer \| category`. |
| `geoquiz` | `data/widgets/countries.json` | Generated flag and capital-city questions. `mode=flags\|capitals\|mixed`. |
| `country` | `data/widgets/countries.json` | Flag, capital, continent and currency. |
| `history` | `data/widgets/sporting-history.json`, `entertainment-history.json` + Wikipedia "On this day" | `scope=day\|week\|month`, `topic=sport\|entertainment\|all`. Widens automatically if the day has no entry. `general=true` adds Wikipedia's selected events (`config.widgets.wikipedia`). |
| `clock`, `worldclock` | — | Drawn by the screen. |
| `transport`, `bankholiday`, `floods`, `carbon`, `quakes`, `currency`, `potd`, `births`, `sky`, `headlines`, `events` | See [DATA_SOURCES.md](DATA_SOURCES.md) | Live sources, cached, with credit lines. Weather defaults to MET Norway (`weather.provider: "metno" \| "openmeteo"`). Train and bus keys go in `widgets.trains` / `widgets.bods`. |

- `GET /api/widgets` lists them, and `GET /api/widgets/:kind?…` returns the data.
- `GET /api/geocode?q=` searches for places.
- The MCP tool `get_widget` returns the same data.
- Live sources fall back to the last good data, or to a clear message, when offline.
- In code: `createWidgets({ config }).peek(kind, opts)` (sync, cached) or `.get(kind, opts)` (async).

## Quick start

```bash
cd signage-server
cp config.example.json config.json   # edit leagues, title, timezone, push targets
npm start                            # http://localhost:8090/display
npm test
```

For a club wall there are two more:

```bash
npm run six-metre                    # is the type big enough for the room? (CLUBHOUSE.md)
npm run preview -- wall.html         # the whole loop as one static file, no Pi needed
```

Docker: `docker build -t pitchtribe-signage . && docker run -p 8090:8090 -v $PWD/config.json:/app/config.json pitchtribe-signage`
Raspberry Pi service: see `pitchtribe-signage.service`.

## Putting it on screens

**Option A: point the screen at the page (simplest).** Open `http://<server>:8090/display` in the
Pi's Chromium kiosk, or add it as a *web page / URL* asset in Xibo, Anthias/Screenly, Yodeck and
similar systems. The page rotates through leagues and reloads itself when a score changes
(Server-Sent Events).

| Query param | Example | Effect |
| --- | --- | --- |
| `leagues` | `eng.1,ucl` | Only these leagues |
| `theme` | `light` | Light theme (default `dark`) |
| `rotate` | `10` | Seconds per page |
| `rows` | `8` | Matches per page |
| `title` | `Clubhouse` | Header text |

**Option B: push.** Add entries to `pushTargets`. Each change in scores sends a POST to every target:

```json
{ "name": "bar-tv", "url": "https://cms.example/api/content", "format": "json",
  "leagues": ["eng.1"], "headers": { "Authorization": "Bearer …" } }
```

- `format: "json"` sends `{ title, updatedAt, displayUrl, leagues: [{ key, name, events: [...] }] }`.
- `format: "html"` sends the rendered page as a static HTML document.
- You can also trigger a push by hand with `POST /api/push`.

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/display` | Signage page |
| GET | `/clubhouse` | One club's wall: single-idea slides, own hours, own photographs ([CLUBHOUSE.md](CLUBHOUSE.md)) |
| GET | `/photos/:name` | One photograph from `clubhouse.photosDir` |
| GET | `/badge` | The club badge (`clubhouse.badge`) |
| GET | `/api/events` | `?league=eng.1&status=live,final,scheduled,postponed&team=arsenal&limit=20` |
| GET | `/api/snapshot` | All leagues with their events |
| GET | `/api/leagues` | League list, event counts, last fetch, errors |
| GET | `/api/stream` | SSE stream; sends an `update` event when data changes |
| GET | `/api/health` | Health check |
| POST | `/api/refresh` | Re-fetch now (`{"league":"eng.1"}` optional) 🔒 |
| POST | `/api/push` | Push to all targets now 🔒 |
| POST | `/mcp` | MCP (Streamable HTTP, stateless JSON) 🔒 |

🔒 If you set `apiToken` (or the `API_TOKEN` env var), these routes need `Authorization: Bearer <token>`.
**Set a token** if the server can be reached from outside the club network.

Event shape:

```json
{ "id": "eng.1:1001", "league": "eng.1", "leagueName": "Premier League",
  "start": "2026-11-01T16:30Z", "status": "final", "statusText": "FT",
  "home": { "name": "Arsenal", "short": "Arsenal", "abbr": "ARS", "logo": "…", "score": 2 },
  "away": { "name": "Chelsea", "short": "Chelsea", "abbr": "CHE", "logo": "…", "score": 1 },
  "venue": "Emirates Stadium" }
```

## MCP

Tools: `list_leagues`, `get_fixtures`, `get_live_scores`, `get_results`, `refresh`,
`push_to_displays`, `get_display_url`.

**stdio (Claude Desktop / Claude Code):**

```json
{ "mcpServers": { "pitchtribe-signage": {
    "command": "node", "args": ["/opt/pitchtribe/signage-server/src/mcp-stdio.js"] } } }
```

or `claude mcp add pitchtribe-signage -- node /opt/pitchtribe/signage-server/src/mcp-stdio.js`.

**HTTP:** while `npm start` is running, connect an MCP client to `http://<server>:8090/mcp`
with the bearer token.

## Data sources

| `source` | Config | Covers |
| --- | --- | --- |
| `espn` | `"path": "soccer/eng.1"` | ESPN's public scoreboard JSON. No key needed. Football leagues worldwide (`soccer/esp.1`, `soccer/uefa.champions`, `soccer/sco.1`, …), `football/nfl`, `basketball/nba`, `hockey/nhl`, `baseball/mlb`, and more |
| `manual` | `"file": "data/club-fixtures.json"` | Your club's own teams, results and league table — grassroots sides no public feed covers. Edit the file and the next refresh picks it up. Format at the top of [src/sources/manual.js](src/sources/manual.js); a full example in [data/club-season.example.json](data/club-season.example.json) |

Each ESPN refresh asks for a whole calendar month per league (`?dates=YYYYMM`) and then trims the
result to `daysBack`/`daysAhead` — normally one request per league, two when the window crosses a
month end. ESPN answers `HTTP 400` to the day-range form (`?dates=YYYYMMDD-YYYYMMDD`).

The ESPN feed is unofficial and undocumented. It is widely used, but it can change without notice
and it is meant for personal and non-commercial use. Check the terms before you use it on paid
signage. If a source fails, the screen keeps showing the last good data and the error appears in
`/api/leagues`. To add another provider, write a module in `src/sources/` that returns
`{ key, name, events }` and register it in `SOURCES` in `src/store.js`.
