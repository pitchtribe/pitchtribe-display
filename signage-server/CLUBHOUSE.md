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

## The six-metre test, measured

The design law is that everything survives a two-second glance from six metres across a
loud room, and the brief asks for it photographed rather than asserted. A photograph needs
a television. The arithmetic does not, and it catches what a photograph catches first:
type too small for the room.

```
node scripts/six-metre.js            # a plain 43" set at six metres
node scripts/six-metre.js 55 6       # a 55" set at six metres
```

[src/legibility.js](src/legibility.js) reads the stylesheet the page actually ships, works
out the **cap height** of every piece of text in millimetres and in arcminutes, and holds
each one to the tier it belongs in. Angular size is the only figure that matters: a 43-inch
screen at four metres and a 65-inch screen at six are the same reading task.

| Tier | Floor | What it is |
| --- | --- | --- |
| **idea** | 25′ | The one thing the slide says. The trade rule of an inch of letter per ten feet is 29′; this is a little under it, for a glance rather than a read. |
| **fact** | 12′ | Something the room relies on — the date (trust rule 1), which of the club's sides played. The outer limit of the same trade rule. |
| **fine** | none | Provenance. Deliberately the smallest thing on the wall. |

Measured on a **43-inch** set at **six metres**, which is the pessimistic case:

| Slide | Its one idea | Cap height | Reads at a glance |
| --- | --- | --- | --- |
| Saturday's result | the score, 30vh | 112 mm / 64′ | to 15.5 m |
| Countdown | the number, 34vh | 127 mm / 73′ | to 17.5 m |
| Club identity | the club's name | 49 mm / 28′ | to 6.7 m |
| Result to follow · called off · next Saturday | the words, 12vh | 45 mm / 26′ | to 6.2 m |
| Form | five W/D/L tiles | 45 mm / 26′ | to 6.2 m |
| The table | five rows, 8vh | 30 mm / 17′ | to 4.1 m — 63-inch set at six metres |
| Around the division | four results, 8vh | 30 mm / 17′ | to 4.1 m — 63-inch set at six metres |
| This week | up to four lines, 8vh | 30 mm / 17′ | to 4.1 m — 63-inch set at six metres |

So the install number: **the heartbeat slides read at a glance on any set from 43 inches
up; the three list-shaped slides need a 65-inch set to do the same at six metres.** On a
smaller screen they are still well clear of the fact floor — they are a look rather than a
glance, and what a glance gets from them is the shape: our row is the lit one, so "third"
arrives as a position on the screen rather than as reading.

Those three are recorded as **named exceptions** in `legibility.js`, each with its reason,
because the brief asks for a five-row table *and* for no small text and on a 43-inch screen
those two wishes do not both fit. A decision with the number in front of it is fine; silence
is not. The outage banner is the fourth exception, at 10′: it shares the screen with a slide
rather than replacing it, and the thing it asks for happens at the router.

[test/legibility.test.js](test/legibility.test.js) fails the build if any of this slips —
including if someone adds text to a slide and never says which tier it is in, because
unmeasured text is not passing text.

What this does **not** do is replace the photograph. It cannot see glare off the window
behind the bar, a dirty screen, the angle people actually stand at, or a set with its
sharpness turned up. Those still want five minutes with a camera.

> Keep `rhythm` lines short — four lines of about forty characters is the budget at 8vh.
> Longer ones wrap, and four wrapped lines will not fit the slide.

## Seven days, simulated

The other physical criterion is seven days unattended. The loop is a pure function of the
clock, so [test/soak.test.js](test/soak.test.js) runs the clock forward a week in a second
and checks every page it would have shown — 673 of them, one every fifteen minutes:

- Not one throws, and no page contains `undefined`, `NaN` or an invalid date.
- Every result on screen carries a date inside its window, on every page of the week.
- **By day eight, with no new data, the heartbeat goes quiet rather than stale**: last
  Saturday's results stop being shown instead of starting to read as this week's. The
  table, the countdown, the club's name and the photographs carry on.
- The blackout keeps the week's schedule, cross-checked against a second, deliberately
  naive implementation of opening hours. Nothing is lit on a closed day.
- The countdown shows seven different faces in seven days.
- The photographs are stable within each local day and different from the day before —
  the Wednesday test, run for a week.
- The six-metre measurement holds on all eight days, not just on the fullest page.

It is **not** the unattended soak, and it is not evidence for it. It cannot see a corrupted
SD card, a browser that leaks over six days, a router that drops at 3am, or hours typed in
wrong. It means that when the card is left for a week, what is left to go wrong is the
hardware and the wiring rather than the pages.

## The two tests that are still owed

Both are physical, and nothing in this repo can stand in for them:

- **The six-metre test, photographed.** Every slide type, on the real set, in the real
  room. The arithmetic above says the type is big enough; a camera says the room can
  read it.
- **Seven days unattended**, with an unannounced power cut and a pulled network cable
  somewhere in the middle.

[scripts/preview.js](scripts/preview.js) writes the whole loop to one static HTML file for
anyone who wants to see it without a Raspberry Pi.
