# How we read Full-Time

**Decision:** we read grassroots results through the **Full-Time code-snippet feed the club's own
league issues to it**, server-side, once a week, cached. **We do not scrape the public Full-Time
pages.**

**Status:** decided 14 November 2026, and **built the same day**: `src/sources/fulltime.js`, registered
in `SOURCES` as `fulltime`. **Switched on nowhere.** v1 ships on the [`manual` source](CLUBHOUSE.md) —
the club's own file on the card — and the board's answer that afternoon was to **go and ask the league
for the snippet codes after all**, so the feed is the route out of somebody typing the results in.

Two things stand between the adapter and being trusted, and both are one email away:

1. **Snippet codes** — about four for Caldecote, generated once from a Full-Time login. See
   [What to ask the league for](#what-to-ask-the-league-for).
2. **One capture of one real feed response**, because nothing here has met a real feed.
   `npm run fulltime:capture -- --code=<lrcode>` is that capture. Run it the hour a code arrives.

Until that capture exists, treat the request URL and the payload parsing as **documented guesses** —
see [What is still a guess](#what-is-still-a-guess). Everything else in the adapter is tested.
**Context:** first trial site is Caldecote FC, Bedfordshire County League. ESPN (see
[DATA_SOURCES.md](DATA_SOURCES.md)) covers professional leagues only and has never heard of a county
league side, so this is a genuinely new source, not a config change.

---

## The two routes

The FA's Full-Time (`fulltime.thefa.com`) is where almost every English grassroots league publishes
its fixtures, results and tables. There are two ways to get data out of it.

1. **The sanctioned feed.** Full-Time has a *Feeds* facility: a logged-in team or league
   administrator goes to **Media → Code snippets**, picks a feed type, a division and a season, and
   is given an embed code. Six types exist: Table, Recent Results, Upcoming Fixtures, Team
   Fixtures/Results, Club Fixtures, Club Results. The embed code is a small piece of JavaScript that
   sets a numeric snippet id and loads a loader script from the Full-Time feed host — in the form
   `var lrcode = '<numeric id>'` plus a `<script>` pointing at
   `fulltime-league.thefa.com/client/api/cs1.js`. The id is the credential; it identifies which
   division or team's data the feed returns.
2. **Scraping the public pages.** Fetch the HTML of the league's public fixtures/results/table pages
   and parse them.

## Why the sanctioned feed wins

**1. The site operator has said, in as many words, that scraping is the problem.** The FA's own
support article explains why the snippets were moved out of the public pages and behind an admin
login: *"the Full-Time site has had its performance severely affected by unlicensed websites trying
to pull data."* Scraping is not a grey area we get to interpret here — the operator has named it, and
named it as harm to a service that volunteers depend on. Our brief's politeness requirement is not
satisfied by doing the thing the operator asked people to stop doing.

**2. The public pages are behind bot management, so scraping means defeating an access control.**
Checked from a server on 14 November 2026: `https://fulltime.thefa.com/` answers **HTTP 403** with a
Cloudflare `Attention Required!` interstitial to an ordinary server-side request. So does
`/robots.txt` — we cannot even read the file that would tell us what crawling is permitted. A scraper
would therefore have to present itself as a browser to get past a layer that exists to stop exactly
that. That is not "the brute-force route"; it is circumvention, and it is not something this project
is going to ship in a public repository under the club's name.

**3. There is no third option. We checked.** An official Full-Time API has been requested and is
**deferred** — the FA's answer on its own support forum is *"an idea that we will investigate further
in the future."* The FA's stated workaround in that same thread is the one we have chosen: *"Your
league can give you a code snippet."* So the snippet feed is not a convenient alternative to an API;
it **is** the sanctioned programmatic route, and it is the only one.

**4. It survives a redesign; a scraper does not.** A snippet feed returns data for a stable id. A
page scraper breaks the next time somebody changes a template — silently, at the worst possible
moment, in February, when half the fixtures are weather and the screen matters most. The brief is
right that the gentle route is also the durable one.

**And the cost of being wrong is asymmetric.** If the scraper route gets us blocked, we lose the
feed, the club's screen goes stale, and PitchTribe is the company that got a volunteer league's
website throttled. There is no version of that worth a fortnight of saved effort.

## What this costs us

One thing, and it is worth naming rather than hiding: **the snippet is issued by a human, once.**
Somebody with a Full-Time login has to generate the codes. That is a dependency on a person, which is
exactly the class of thing the brief spent four dead mechanisms learning to avoid.

The difference — and the reason this is still the right call — is **when** the dependency bites. CEC,
the Facebook group and the booking diary each needed somebody else's permission *continuously, at
runtime*. This needs it **once, at install, from the club we are installing for**, and the same
people who are saying yes to the screen hold the login. After that the feed is read weekly with
nobody at the club doing anything, ever — which is in-scope requirement 1, intact.

## What this means in code

The adapter is `signage-server/src/sources/fulltime.js`, registered in `SOURCES` in `src/store.js`
alongside `espn` and `manual`, returning the documented `{ key, name, events }` shape plus
`standings`. The existing caching, serving, display and offline-fallback plumbing comes for free.

Config is a list of snippet codes with what each one is:

```json
{
  "key": "club",
  "source": "fulltime",
  "name": "Bedfordshire County League",
  "club": { "name": "Caldecote FC", "aliases": ["Caldecote"] },
  "refreshHours": 168,
  "feeds": [
    { "code": "123456", "kind": "table",   "competition": "Premier Division" },
    { "code": "123457", "kind": "results", "competition": "Premier Division", "team": "First XI" },
    { "code": "123458", "kind": "results", "competition": "Division One",     "team": "Reserves" },
    { "code": "123459", "kind": "results", "competition": "Premier Division" }
  ]
}
```

A feed with no `team` is division-wide — that is what fills "around the division". A feed with a
`team` says which of the club's sides it is about, because the feed itself does not say.

Three things differ from `espn.js` and are worth knowing before you read the adapter:

- **Config carries snippet ids, not a league path.** An `lrcode` is scoped to one division or one
  team, so a club with a First XI, Reserves and an 'A' team needs several, plus one for the table.
  Config shape is therefore a list of codes with what each one is, not a single `path`.
- **It fetches weekly, not every ten minutes.** Grassroots results land Saturday evening and the
  league secretary is a volunteer, so midweek there is nothing new to collect. `refreshMinutes` is
  tuned for live professional scores and is far too eager for this; the adapter must not inherit it.
  Politeness here is a feature, and it is also the thing that keeps us welcome.
- **Season-long history, not a `daysBack` window.** The table and the last-five form slide need more
  than `daysBack: 3`. Note that the window trim lives *inside* `espn.js`, not in the store, so a
  Full-Time adapter can keep a whole season without changing ESPN's behaviour.

## What is still a guess

Nobody has handed us a real `lrcode`, so **two things in the adapter are assumptions rather than
observations**, and both are deliberately confined to one place each so that a wrong guess is cheap:

| Unknown | Where it lives | What a wrong guess costs |
| --- | --- | --- |
| The request URL | `feedUrl()` — driven by `endpoint`, `codeParam`, `urlTemplate` in config | A config line, not a release |
| The payload format | `parsePayload()` — accepts bare JSON, JSONP/assignment, or table markup | Nothing is half-read: an unrecognised body is **refused**, the store keeps the last good data and the error is logged |

A third unknown is not ours to fix from here: whether the feed host answers from the clubhouse.
`fulltime-league.thefa.com` resolves, but did not answer from our build sandbox — which is most
likely our own egress rather than theirs. The capture answers that too, because it is run from a real
network.

**One capture closes all three.** `npm run fulltime:capture -- --code=<lrcode>` saves the raw body,
says which of the three branches it took, and prints the matches or the table rows the adapter made of
it. Then commit the capture under `test/fixtures/`, pin a test to it, and delete the two branches that
turned out to be fiction.

## What to ask the league for

A club or league administrator generates these from a Full-Time login in a few minutes:
**Media → Code snippets**, pick the feed type, division and season, and copy the numeric `lrcode` out
of the embed code it gives back. Caldecote needs roughly four:

| What | Feed type | Scope |
| --- | --- | --- |
| The table | Table | Bedfordshire County League **Premier Division** |
| First XI results & fixtures | Team Fixtures/Results (or Recent Results + Upcoming Fixtures) | Caldecote FC **First XI** |
| Reserves results & fixtures | Team Fixtures/Results | Caldecote FC **Reserves**, Division One |
| Around the division | Recent Results | Premier Division, **whole division** |

Send the numeric id of each and which of those four it is — the id alone is not self-describing, and a
mislabelled code shows the Reserves' results under the First XI's name.

**The courtesy to the league was the board's to handle and the board has it covered** (14 November
2026). For the record, the thing worth them knowing: the snippet grant plainly intends the FA's widget
markup on a club web page, and we show the club's own data on the club's own television in our own
layout, because the FA widget is a dense table and our slides must read in two seconds from six metres.
One read a week is also gentler on their servers than the embed it replaces, which is one read per page
view.

## How it degrades

Per the trust rules, and these are requirements, not nice-to-haves:

- **A failed or revoked feed never invents data.** The store already keeps the last good payload and
  records the error; the slide must then say when it was last read. Reportedly, snippet codes left
  unused are deleted after about 30 days — verify that in the admin area — so an expired code is a
  real, expected failure mode, not a freak event.
- **Every result carries its date**, because stale-but-dated is trustworthy and stale-but-undated
  teaches the room to disbelieve the screen.
- **Grassroots states survive the trip.** Postponed, abandoned, waterlogged, walkover, points
  deducted. "Postponed — pitch unplayable" is a good slide; a blank 0–0 is a lie. Carry the league's
  own words in `statusText` and never mangle them into a score.

  This one had a real bug in it, found while testing the adapter and fixed in `manual.js` where both
  sources share the status table: a league that writes *the whole phrase* in the status cell matched
  no single word, and an unmatched status read as `scheduled` — so the exact phrasing the brief holds
  up as a good slide came out as a plain fixture with the explanation discarded. A phrase is now read
  word by word, the word that says something happened to the match wins, and the league's wording is
  kept verbatim. Wording we still cannot place is logged with the phrase in it, which is how we find
  out what a real league actually writes.

## Attribution

Every source in this repo shows the credit its licence asks for, and this one is the club's league's
data on the club's wall. Full-Time slides carry a small **"Results from The FA Full-Time"** line.

## What would make us revisit this

- The FA ships the deferred API. Then we move to it; this document is the reason we were not already
  depending on something we had to sneak.
- A league declines to issue codes. Then the fallback is **not** a scraper — it is the existing
  `manual` source, a human typing the week's results into a JSON file, which is honest about what it
  is. Slower, and still not circumvention.

## Where v1 actually went

That fallback is where v1 went, by choice rather than by refusal: **the screen did not wait for
codes.** The manual source now reads a whole season, a league table and the league's own wording, and
the clubhouse wall is built on it — see [CLUBHOUSE.md](CLUBHOUSE.md).

What that costs, stated where it cannot be mistaken for a win: somebody types in the week's results
on a Saturday evening. In-scope requirement 1 — *"nobody at the club does anything, ever"* — is the
one part of the brief v1 does not meet, and the Full-Time feed above is how it gets met. Everything
the feed would change is already behind one source adapter, so switching is a new file in
`src/sources/` and a config line, not a rebuild.
