# How we get the club's photographs

**Decision:** the archive-wall pool comes from **Caldecote Football Club's own Facebook Page, handed
over by a Page admin** — either as a Page content export or through one short-lived Page access
token. **We do not scrape the Page**, and not only for politeness: the photographs are not in the
public page at all. See [Why scraping is not a fallback here](#why-scraping-is-not-a-fallback-here).

**Status:** route decided 18 November 2026. **The count is not done, and it cannot be done from
here.** One two-minute job by a club admin produces both the count and the pool; until then there is
no honest number to put on PIT-42. The instrument that turns that one click into the
number is built and tested: `npm run photos:count`.

**Consent is outstanding and blocks the wall, not the count.** See
[Consent](#consent-outstanding).

---

## The Page

| | |
| --- | --- |
| Name | Caldecote Football Club |
| URL | `https://www.facebook.com/p/Caldecote-Football-Club-100054578283967/` |
| Numeric id | `100054578283967` |
| Followers | 710, 76 talking about it (read 18 Nov 2026) |
| Kind | A **Page**, not a personal profile — it carries a Page Transparency section |

That last row matters more than it looks. A personal profile has no Page export and no Page token,
and the Graph API cannot read one at all; had the club been running its football account as somebody's
profile, both sanctioned routes would have been shut and this document would have had a different
ending. It is a Page, so both routes are open.

## Deliverable 1, the count: what we know and what we cannot know

The brief is right that the number is worth more than the code — four hundred usable photographs is a
screen that looks different every day for a season, twelve is wallpaper by Thursday, and the archive
pool is most of what the wall shows from Sunday to Friday. So the count was attempted first, properly,
before anything was built.

**Every door that does not involve the club is shut.** Checked from a server, 18 November 2026:

| What we asked | What came back |
| --- | --- |
| `GET graph.facebook.com/v21.0/100054578283967` | HTTP 400, `code 104` — *"An access token is required to request this resource."* |
| `GET .../100054578283967/photos` | HTTP 400, `code 104` — same |
| `GET .../100054578283967/albums` | HTTP 400, `code 104` — same |
| `GET .../100054578283967/picture` | **HTTP 200** — the one unauthenticated edge. This is how we know the id is real |
| `GET www.facebook.com/p/Caldecote-Football-Club-100054578283967/` | HTTP 200, 527 KB of HTML containing **exactly one image**: the profile picture |
| `GET www.facebook.com/100054578283967/photos` (the Photos tab) | HTTP 200, correct `<title>`, and **zero images** |
| `GET mbasic.facebook.com/profile.php?id=…&v=photos` | HTTP 200, `<title>Content not found</title>` |
| `GET m.facebook.com/profile.php?id=…` | HTTP 200, `<title>Content not found</title>` |

So the honest answer to "how many usable photographs are on that Page" today is **not a number, it is
a dependency**: nobody outside the club can see the photographs to count them. The logged-out Page is
a JavaScript shell; the images arrive only after a session hydrates it.

**What the count is *not*:** it is not an estimate. We could multiply 710 followers by a guess about
village clubs and produce a confident-looking figure, and it would be worth nothing — the whole point
of this deliverable is that nobody has ever counted, and a fabricated number would leave that exactly
as true while sounding as though it had been fixed. The brief asks for the cheapest bad news
available; the cheapest bad news available is *this is one click away and here is the click*.

### The one click, and what it returns

Either route below gives the count in minutes. The counting is already written, so the hour a token or
a zip arrives:

```
npm run photos:count -- --dir=~/caldecote-export        # the export route
npm run photos:count -- --token=<page token>            # the Graph route, metadata only
```

It reports the pool in three bands by what the screen can actually do with a 16:9 crop
(`full` ≥ 1920px, `soft` 1280–1919px, `small` below), breaks it down by album, and says plainly
whether the result is under the brief's sixty-photograph floor. In `--token` mode it downloads **no
image data at all** — Graph reports each photograph's dimensions in the listing, so the arithmetic
runs on metadata and the count costs the club's Page nothing.

**The number it prints is an upper bound, and it says so.** Two of the brief's three usability tests
are arithmetic — landscape or croppable to landscape, big enough not to look soft at 1080p — and they
run with no eyes. The third is not: no measurement distinguishes a team photograph from a fixture
list, a sponsor board, a meme or a league result card, and those are usually large and landscape too.
What the tool buys is that the human eye-pass starts from the images that could possibly qualify,
sorted by album, with design-tool canvas sizes flagged. *Sponsors* and *Fixtures* get dismissed
wholesale, and the job goes from an afternoon to a few minutes.

One sharp edge worth knowing before reading the output, because it was a surprise: **a 1080×1080
square crops to 1080×607.** The square fixture card that looks fine on a phone is not a 1080p slide.
Square-ish images fail on size even when they are perfectly good photographs, and counting them as
usable would inflate the pool by exactly the images that look worst on a television.

## The two sanctioned routes

Both are things Meta intends. Ask for the first; the second is the fallback.

### Route A — a Page content export *(preferred)*

A Page admin exports the Page's own content and hands us a zip. In Meta's current account settings
this is *Accounts Centre → Your information and permissions → Export your information*, scoped to the
Page, with **Photos and videos** ticked and **media quality set to High**. The export can be
downloaded as a zip or transferred to Google Photos or Dropbox.

Why this one wins:

1. **Picture quality, which is the whole point of the archive wall.** The export at High quality is
   the closest thing to what the club originally uploaded. Everything else in the chain is
   re-encoded and downscaled by Meta for rendering, and the brief is buying a 1080p television, not a
   phone screen.
2. **No credential ever touches us.** There is no token to store, expire, rotate or leak, and nothing
   in this repository ever needs a Meta secret. For a project whose card is meant to phone nobody,
   that is not a small thing.
3. **It is a bulk one-off, which is what this actually is.** The archive pool is imported once and
   reshuffled forever. It is not a feed.

The cost, stated rather than hidden: it is a human job, it takes some clicking, and the export takes
a while to build on Meta's side. And **Meta moves these menus constantly** — the exact path above
should be treated as the shape of the job rather than a script to follow blindly; a Page admin
looking at the screen will find it faster than we can describe it.

### Route B — one short-lived Page access token

If the export is awkward, `GET /{page-id}/photos?type=uploaded` returns the Page's uploaded
photographs with their dimensions and album names.

| | |
| --- | --- |
| Permissions | `pages_read_engagement`, `pages_show_list` |
| Token | A **Page access token** from an account that can perform the `MODERATE` task on the Page |
| App Review | **Not needed** — see below |

**The reason this is cheap is worth spelling out.** Meta's *Page Public Content Access* feature — the
one that needs App Review and takes weeks — is required only when the caller *cannot* moderate the
Page. A club admin reading the club's own Page is inside the permission, so there is no review, no
business verification and no waiting on Meta. That is the difference between a two-minute favour and a
project.

And because the import is a one-off, **a short-lived token is sufficient**. The default one or two
hours is plenty for one harvest. Nothing long-lived needs issuing, nothing needs storing, and whatever
is used is dead by the evening. If a token is handed over, it goes in a command line and never into
this repository, a config file or a commit.

`type=uploaded` is not optional, and it is the one way to get a wrong number that looks right: the
endpoint's **default is `type=profile`**, which returns the Page's current and previous profile
pictures and nothing else — a handful of images, plausibly small, and completely the wrong answer.

## Why scraping is not a fallback here

The brief anticipated that the fallback would cost us terms risk, image quality and fragility, and
asked for those costs recorded rather than quietly paid. Having looked, the finding is stronger than
that, and it changes the question rather than answering it:

**1. There is nothing to scrape.** This is the finding that settles it. The logged-out Page returns
527 KB of HTML containing one image — the profile picture — and the Photos tab returns zero. A
scraper would therefore not be reading a public page badly; it would have to **present a logged-in
session** to see a single photograph. That means using some real person's Facebook account as a robot.
That is defeating an access control, it puts a club volunteer's personal account at risk of being
disabled, and it is not something this project is going to ship in a public repository under the
club's name.

**2. The site operator has said so, in the file that exists to say so.** `facebook.com/robots.txt`
opens with: *"Notice: Collection of data on Facebook through automated means is prohibited unless you
have express written permission from Facebook."* It then sets `User-agent: *` → `Disallow: /`. There
is no interpretation left to do, and no corner of the Page carved out as crawlable.

**3. Picture quality runs the wrong way.** Even if the photographs were in the public HTML, the
renditions served to a page view are re-encoded and downscaled for a browser viewport. The archive
wall exists to put photographs on a 1080p television across a loud room; starting from Meta's
web-sized copies when the club holds the originals is paying a terms risk for a worse picture.

**4. It would break, silently, in February.** A page scraper lasts until somebody changes a template.
The export and the Graph call both answer for a stable id.

This mirrors the conclusion in [FULL_TIME.md](FULL_TIME.md), and for the same underlying reason: in
both cases the sanctioned route is not the polite alternative to the effective one, **it is the only
one that works**, and the gentle route turned out to be the durable route as well.

**Per the brief, this is a question and not a decision we have taken.** The user chose the Facebook
route and that choice stands — nothing here walks it back. What is recorded here is that the *route
within* Facebook has to be the admin one, because the un-sanctioned version of the Facebook route
does not exist. If the club cannot or will not produce either an export or a token, that is not a
problem to solve with a cleverer fetch; it goes back to PIT-42 as a question, with the
honest alternatives being a shallower pool, the scanned-photographs route the brief rules out, or a
different slide mix for version one.

## What to ask the club for

A Page admin — somebody who already posts to the Page — does one of these. Both are the same category
of job as the CEC menu check.

> **Preferred.** In Facebook, go to your account settings → *Your information and permissions* →
> *Export your information*. Choose the **Caldecote Football Club** Page, tick **Photos and videos**,
> set media quality to **High**, and pick the whole date range. Facebook builds a zip and emails you
> when it is ready. Send us the zip, or share it from Google Drive or Dropbox.
>
> **Or, if that is awkward.** Generate a **Page access token** for the Page with
> `pages_read_engagement` and `pages_show_list`, and send it to us. One hour's validity is enough — we
> read the photographs once and the token expires on its own. We never store it.

Two things to say back to the admin when asking, because they are the questions a sensible volunteer
will have:

- **We are reading, never posting.** Nothing is written to the Page, nothing is posted, nothing is
  changed, and no comments or messages are read. This is the club's photographs, going on the club's
  own television, in the club's own bar.
- **Nothing leaves the Pavilion.** Not to a website, not to promotional material, not to us. See
  below.

## Consent (outstanding)

**This is flagged here so it cannot be forgotten, and it is the user's to get, not ours.**

These are a real club's photographs of real people, going on a screen in that club's own bar.
*Publicly visible on their Page* is not the same as *cleared for display*. Before the pool goes on a
wall there needs to be a one-line yes from the club.

- **The count does not need consent.** Counting is not displaying, and the count is what decides
  version one's slide mix. The two asks can travel together but they do not block each other.
- **The pool does.** No harvested photograph goes on the wall until that yes exists.
- **Nothing from this pool goes anywhere outside the Pavilion, ever.** No website, no promotional
  material, no telemetry, no analytics, no copy leaving the card. The display reads the pool off local
  disk and phones nobody — which is the same rule the rest of this repository already keeps, so there
  is no new mechanism to trust here, only the existing one.
- Worth putting to the club in the same breath: **a way to say "not that one."** Somebody in a photo
  from 2014 may not want it on the bar wall, and the answer is a folder you can take a file out of
  rather than a moderation queue. That is already how the pool works.

## What this means in code

Counting lives in two files and touches nothing that serves the screen:

| File | What it is |
| --- | --- |
| `src/photo-triage.js` | The usability arithmetic: largest 16:9 crop, the three bands, album rollup, and header readers for JPEG/PNG/GIF/WebP/AVIF so an export can be counted with no network and no dependencies |
| `scripts/photos-count.js` | `npm run photos:count` — the instrument. Reads an export directory or the Graph API, writes nothing, modifies nothing |
| `test/photo-triage.test.js` | The arithmetic pinned, including the phone-portrait and square-crop cases that a careless rule gets wrong in the reassuring direction |

The display half already does its share, and did before this issue: `pickPhotos` in
`src/clubhouse.js` takes a dozen from the pool with a date-seeded shuffle, so the wall is visibly
different on Wednesday from Sunday, and `src/photos.js` streams them off local disk. Twelve
photographs and four hundred run the same code. See
[data/photos/README.md](data/photos/README.md).

**The harvest is deliberately not built yet.** De-duplication and the one-time downscale into
`data/photos/` are the remaining work, and the brief sequences them after the count on purpose: if the
pool is under sixty, version one's slide mix changes rather than the code, and a harvest pipeline
would be a pipeline for nothing. Two things are known about it already and are worth recording before
they are rediscovered:

- **De-duplication needs pixels, not metadata.** Facebook albums repeat the same shot, and the
  repeats have different ids, different filenames and often different byte sizes after re-encoding.
  Dimensions will not catch them.
- **The downscale needs an image decoder, and this package has zero dependencies.** Nothing in
  `signage-server` has a dependency today and no image tooling is present on the build box, so the
  one-time resize is a real decision — a build-time dependency used by a script that never runs on
  the card, a system tool, or downscaling on the machine that unpacks the export. It is a decision
  for the harvest, not something to settle in a counting tool.

## How it degrades

- **The pool is local, always.** The display never fetches an image from Meta at render time. No
  internet is a normal condition in a village pavilion, not an error, and a wall that goes blank when
  the broadband does is not a wall.
- **An empty pool is not a broken screen.** `listPhotos` already answers "no photographs" for a
  missing or unreadable directory, and the loop simply has no photo slides in it.
- **The import is a one-off, so there is nothing to keep working.** There is no token to expire, no
  feed to go stale and no scheduled job to fail at the worst moment. Once the pool is on the card it
  is as durable as the card.

## What would make us revisit this

- **The club says no, or cannot produce either artefact.** Then the pool is not coming from Facebook,
  and that goes back to PIT-42 as a question about version one's slide mix — not to a
  scraper.
- **The count comes back under about sixty.** Then the archive wall is not the backbone of the
  Sunday-to-Friday loop and something else has to be, which is a board decision and not a build.
- **The club wants new photographs to keep arriving.** This document covers a one-time import on
  purpose. A standing sync is a different thing with different costs — a stored long-lived token, a
  scheduled job, and a card that phones Meta — and none of those are things we should acquire without
  being asked.
