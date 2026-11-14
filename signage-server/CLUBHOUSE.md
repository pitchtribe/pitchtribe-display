# The clubhouse wall

One television in one clubhouse, showing one club's football and one club's photographs.
`GET /clubhouse`.

This is a different thing from [`/display`](README.md). `/display` is a multi-league
pamphlet for a sports centre: dense, tabular, read from a few feet away. The clubhouse
wall is for a loud bar, six metres away, at an angle, while somebody waits for a pint. It
shows **one idea per slide** and nothing else.

```
 club file (JSON on the card) ─► store (cache, change-detect) ─┐
 photo folder on the card ────────────────────────────────────►├─► GET /clubhouse
 opening hours in config ─────────────────────────────────────►┘    (slides, hours, countdown
                                                                     kept by the card itself)
```

## Quick start

```bash
cd signage-server
SIGNAGE_CONFIG=clubhouse.example.json npm start   # http://localhost:8090/clubhouse
```

Then copy `clubhouse.example.json` to `config.json`, point it at the club's own file and
photographs, and edit the hours.

## What it shows

| Slide | Where it comes from | Notes |
| --- | --- | --- |
| **Saturday's result** | club file | One per side. Always carries its date. |
| **Result to follow** | club file | A played match the league hasn't published. A feature, not a gap. |
| **Called off** | club file | In the league's own words: "Postponed — pitch unplayable". |
| **Next Saturday** | club file | Opponent, home or away, kick-off, and the ground if away. One per side. |
| **The table** | club file | The club's row plus two above and two below. Five rows, never twenty. |
| **Form** | club file | Last five as W/D/L, per side, from the whole season in the file. |
| **Around the division** | club file | Everyone else's results, four to a slide — the only new thing midweek. |
| **The club** | config | Name, badge, colours, strapline. It is their screen. |
| **This week** | config | Training nights, quiz night, bar hours. Typed in once at install. |
| **Countdown to Saturday** | the card's clock | Changes face every day because the date does. |
| **Photographs** | a folder on the card | A dozen a day from the pool, reshuffled daily, woven between the football. |

Nothing is ever interpolated. A result that is not in the file does not appear, and a match
with no score is shown as "Result to follow" rather than a 0–0.

## The club file

The club's results, fixtures and table live in one JSON file on the card, read by the
[`manual` source](src/sources/manual.js). `data/club-season.example.json` is a full,
working example — a season of results, a table, two sides, a postponed match and an
unpublished one. The format is documented at the top of `src/sources/manual.js`.

Three things are worth knowing before you write one:

- **`start` is required on every event.** Every result carries its date on screen, so a
  row without a readable date is skipped and the reason is written to the log. It is the
  one field with no sensible default.
- **Grassroots wording survives.** `status` may be `final`, `scheduled`, `live`,
  `postponed`, `awaiting`, or any of the words a league secretary actually writes —
  `abandoned`, `waterlogged`, `called off`, `walkover`, `cancelled`, `result to follow`.
  They map onto the four statuses the display sorts on, and whatever you put in
  `statusText` is what the room reads.
- **Keep the whole season in the file.** The table and the last-five form slide need more
  than the last few days, and the `manual` source applies no date window. Results older
  than nine days stop appearing as *news* on their own slides, which is deliberate: a
  result on screen without that limit reads as this week's.

### Who types it in

As of 14 November 2026, **v1 ships on this file** — a board decision, taken with the
alternative written down. The sanctioned Full-Time feed is the route we chose and recorded
in [FULL_TIME.md](FULL_TIME.md), and it stays the plan; it needs snippet codes that a human
with a Full-Time login generates once, and those have not been asked for yet.

So be honest about what this costs while it lasts: **somebody types in the week's results
on a Saturday evening.** That is a person in the loop every week, which is exactly the
class of dependency the project set out to avoid — in-scope requirement 1 ("nobody at the
club does anything, ever") is the one part of the brief this does not yet meet. Everything
else on the card already does.

Editing the file is the whole job: no dashboard, no login, no CMS. Drop the new file in
place and the next refresh picks it up — within `refreshMinutes`, or immediately with
`POST /api/refresh`.

## The photographs

A folder on the card: `clubhouse.photosDir`. See
[data/photos/README.md](data/photos/README.md). Twelve photographs and four hundred run
the same code; the pool is reshuffled once a day, so Wednesday's wall is visibly different
from Sunday's, and the deeper the pool the longer that holds.

## Opening hours, kept by the card

```json
"openingHours": {
  "tue": [["18:30", "23:00"]],
  "sat": [["12:00", "01:00"]],
  "sun": [["12:00", "18:00"]]
}
```

Local times, in `config.timezone`. A window may run past midnight. A day with no window is
closed all day. **No `openingHours` at all means always on**, which is right for a test
bench and wrong for a clubhouse — a screen that lights up during a committee meeting is
annoying, and annoying is how installations get unplugged.

Outside its hours the card blacks out **its own picture**, in the page, on the browser's
own clock. It never tries to control the television: no CEC, no handshake, nothing that
depends on which set the next club owns. If a timer plug switches the television at
closing time, it switches the television only — the card stays powered, because a Pi
pulled at the mains every night corrupts its SD card eventually.

## What it does when things go wrong

| Condition | What the wall does |
| --- | --- |
| No internet | Carries on. Nothing on this page is fetched from the internet — no fonts, no CDN, no icons. |
| The club file is unreadable | Keeps the last good copy on screen, with its date, and records the error. |
| The card can't reach its own server | After three missed checks (about three minutes): *"No internet connection — unplug the white cable, wait ten seconds, plug it back in."* Plus how old the data is. Never a stack trace, never a browser error page. |
| A photograph won't load | That slide is skipped mid-loop, not shown empty. |
| Nothing to show at all | The club's own name and the countdown. Never a blank screen. |
| Power cut | systemd brings the service back and the browser reopens the page; the loop resumes where it left off. |

The page only ever reloads itself **after** checking the server answers, because a reload
into a dead server is a browser error page on the clubhouse wall — worse than yesterday's
table.

## Configuration

Everything lives under `clubhouse` in the config file (see `clubhouse.example.json`).
Omit the whole block and the clubhouse routes stay inert: `/` still goes to `/display`.

| Key | Meaning |
| --- | --- |
| `league` | Which `leagues[]` key is the club's own source. Defaults to the first league. |
| `club`, `aliases` | Which side is "us". `"Our Club"` matches "Our Club 1st XI", "Our Club Reserves" and "Our Club 'A'"; add `aliases` for anything that doesn't share the name. Falls back to `club` in the club file. |
| `name`, `strapline` | What the identity slide says. |
| `badge` | Path to the club badge (SVG, PNG or JPEG). Served at `/badge`. |
| `colours` | `primary` (the wall), `ink` (the type), `accent` (points and the countdown). |
| `photosDir`, `photosPerLoop` | The photo pool and how many per loop (default 12). |
| `rhythm` | Up to four lines for the "This week" slide. Omit it and there is no such slide. |
| `rotateSeconds` | Seconds per slide (default 12, minimum 5). `?rotate=` overrides it for one screen. |
| `openingHours` | Above. |

`refreshMinutes` is worth turning down for a club card: there is nothing live to collect,
so 30 minutes is plenty and a weekly file needs no more.

## The two tests that decide whether this is finished

Both are physical, and neither can be asserted in code:

- **The six-metre test.** Photograph a slide, stand six metres back, glance for two
  seconds, look away, and say what it said. Every slide type, photographed and checked.
- **The Wednesday test.** A photograph of the screen on Wednesday is visibly different
  from Sunday's.

The automated tests in [test/clubhouse.test.js](test/clubhouse.test.js) cover the rules
behind them — one idea per slide, five table rows, a dated result, a daily reshuffle — but
they cannot tell you whether the room can read it.
