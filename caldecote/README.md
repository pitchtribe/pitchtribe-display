# The Caldecote line

**You are on a club line, not on the base system.** This branch carries one club's build — Caldecote
FC, The Pavilion, Harvey Close, Upper Caldecote — on top of PitchTribe, and is released on its own
numbering. The current version is **caldecote 0.0.3** (`caldecote/release.json`), published as the
prerelease tag [`caldecote-0.0.3`](https://github.com/pitchtribe/pitchtribe-display/releases/tag/caldecote-0.0.3)
with a flashable SD-card image. **It is the first club image where flashing it is the whole job** —
`0.0.1` and `0.0.2` are superseded and must not be flashed.

It exists so that work for one building cannot destabilise the system everybody else downloads. The
base system is at `v0.4.2` and is happy there; the clubhouse wall, the Full-Time feed and the soak
instrument are all new, all unproven on real hardware, and all for one village. None of that belongs
in a public release yet.

---

## The rule, in one sentence

**If the next club would want it, it belongs on `main`. If only Caldecote wants it, it belongs here.**

That line is not always obvious, so it is worth writing down where it currently falls:

| On `main` — the base system | On this line — the Caldecote build |
| --- | --- |
| the dashboard, the player, the guest portal, the installer, the image build | `GET /clubhouse` and everything it renders |
| the feeds engine and its existing sources (`espn`, `manual`) | the `fulltime` source adapter |
| device hardening, support access, backups, CodeQL decisions | the six-metre legibility measurement and the soak instrument |
| the website in `html/` and its release/download path | Caldecote's own config and content (`clubhouse.json`, the badge, the photo pool) |
| **bug fixes in shared code, even when found doing club work** | slide design, type sizes, opening hours, the countdown |

The last row is the one people get wrong. A defect in `signage-server/src/store.js` or
`src/sources/manual.js` is a defect in the base system, and fixing it only here means every other
club keeps the bug. **Those go to `main` as their own pull request, and arrive back here on the next
merge forward.**

Two such fixes currently live only on this line. Their severity is not the same, and the difference
is worth stating rather than lumping them together as "bugs owed to the base":

- **`sortEvents` goes `NaN` on an unrecognised status — latent on `main`, not live.**
  `STATUS_ORDER[a.status] - STATUS_ORDER[b.status]` against a four-key map makes one
  `undefined - number` enough to render the comparator inconsistent and the whole display order
  meaningless. On `main` it cannot actually fire: `espn.js`'s `mapStatus` and `main`'s `manual.js`
  are both total functions onto those four values, so nothing can reach the comparator with a fifth.
  It is one new source away from being live, which is why the fix here makes the comparator total.
  Worth back-porting as hardening; do not describe it to anyone as a defect in a shipped install.
- **An unrecognised status silently becomes `scheduled` — live on `main`.** This line reads the whole
  phrase: a league that writes *"Postponed — pitch unplayable"* in one cell matched no single word
  and fell through to `scheduled`, which is what decides whether a published score is shown — so the
  best slide in the brief came out as a plain fixture with the explanation discarded. `main`'s
  `manual.js` has the same shape of trap (`STATUSES.has(ev.status) ? ev.status : 'scheduled'`), and
  there it is genuinely live: a club hand-editing its own JSON gets a silent `scheduled` for anything
  but the four exact lowercase words. That is a trust-rule-1 failure in the base system today.

The second one is deliberately **not** fixed on `main` yet. Porting this line's richer
`normalizeStatus` into the base would guarantee a merge-forward conflict in that file, for a source
only a hand-edited install uses — so it is recorded as a known base defect and PIT-45 holds the
decision on when to fix it there.

## Putting it on the card

**Nothing.** A card flashed from this line's image comes up as Caldecote on its first boot,
with no keyboard and no commands typed on the Pi. That is the whole point of a club line, and
it is worth saying what it replaced: until `0.0.3` this section listed four commands to type
on the Pi after flashing, and a card flashed and switched on *without* them served the wall
correctly with **our** name on it — the right page, the wrong club, HTTP 200, invisible in a
screenshot. `caldecote-0.0.1` and `0.0.2` both shipped exactly that.

How it works now:

| In this directory | Goes to | Why |
| --- | --- | --- |
| `card/*` | the data directory, `/var/lib/pitchtribe` | `clubhouse.json` is what the app reads to turn the wall on; `season.json` and `photos/` sit beside it because its relative paths resolve against it |
| `card.env` | merged into `/etc/default/pitchtribe-kiosk` | points the kiosk at `/feeds/clubhouse`. Without it the card serves the wall and *opens* `/player`, which on a card with no playlist is an empty screen |

`.pitchtribe-club` at the top of the checkout holds one word — `caldecote` — and is how
`deploy/install.sh` and `image/build.sh` know this checkout is a club line at all. **There is no
such file on `main`**, which is why none of this touches the system everybody downloads, and why
no workflow needed changing: a club line's image build is just a checkout that carries its own
marker. The mechanism itself (`deploy/club-content.sh`) is base code and lives on `main`; this
line only supplies the content and the marker.

Two rules the script **enforces** rather than documents, both of which matter here:

- **A file already in the data directory is never overwritten.** Upgrading a working Caldecote
  card must not throw away the season somebody typed in on a Saturday evening, the photographs
  they finally handed over, or opening hours that have since been corrected. The empty
  `season.json` in this directory is for a *fresh* card and will not replace a filled-in one.
- **A club directory that is named but missing or empty fails the install.** A club card that
  quietly installs as a playlist player is the failure above, so it is an error, not a no-op.

On a card that is already running, the same job by hand is one command:

```bash
sudo deploy/club-content.sh caldecote
```

`signage-server/CLUBHOUSE.md` has the long version of what the wall reads.

**Three things in `clubhouse.json` are placeholders and the file says so in its own
`_unconfirmed` field.** None can be settled from this side of the keyboard:

| Placeholder | Why it is not filled in | What it costs if it ships as-is |
| --- | --- | --- |
| **Opening hours** | Only Saturday is established by the brief ("16+, Saturdays", a bar and people waiting for a pint). Every other day is deliberately **closed** rather than guessed. | A dark screen on a night the bar is open. Chosen over the other way round: a screen lit during a committee meeting is how installations get unplugged. |
| **Colours** | Nobody has told us Caldecote's. Omitted, so the engine's defaults apply. | A wall in somebody else's blue. Harmless but not theirs, and it is their screen. |
| **Badge** | There isn't one on file. Omitted; the slide drops the image and keeps the name. | The identity slide is type-only. |

`season.json` is **empty on purpose.** It is where the week's results are typed in, and a
made-up fixture list would put football on a clubhouse wall that nobody played. Until it is
filled in the wall shows the club's name, the countdown and the photographs — which is v1
behaving correctly, not v1 broken.

## What this line is made of

Base system, plus the PIT-45 work in this order:

1. **#35** — `fix/espn-fixture-clock`. Already a base fix and already aimed at `main`; it is only
   listed here because the branches below contain it.
2. **#33 → #34 → #36** — the Full-Time route decision (`signage-server/FULL_TIME.md`), the clubhouse
   wall, and the `fulltime` source adapter. These stack: **#36 contains #33 and #34**, so merging #36
   delivers all three.
3. **#37** — the soak instrument (`deploy/soak-watch.sh`, `deploy/SOAK.md`), stacked on #34.
4. **#43** — the wall on a card. Everything above configured the engine **directly**; an installed
   Pi does not. It runs the app, which embeds the engine under `/feeds`, so the wall is at
   `/feeds/clubhouse` and nothing passed it a club config. `caldecote-0.0.1` was published with
   that in it: the right page, with our name on it and no football.
5. **#46** (on `main`) **and the `card/` layout here** — the club's content on the card *before*
   its first boot. #43 made a club file work once it was on the Pi; it did not put it there, and
   the documented route was four commands typed on the Pi after flashing. So `caldecote-0.0.2`'s
   image still could not show the club unless somebody did that by hand — the same class of fault
   as #43, one step further out. The mechanism is base code on `main`; what is on this line is
   `card/`, `card.env` and `.pitchtribe-club`.

The pattern across #43 and #46 is worth naming, because it is the one this line keeps hitting:
**each was a test that proved the wall worked at a seam no card actually uses.** The engine
configured directly, then the app handed a club file directly. The fix both times was to test the
documented install path instead of the convenient one.

### The one hunk of base code this line owns

**`app/lib/feeds.js` and the `clubFile` line in `app/lib/app.js` are club-line changes inside base
files.** That is a merge-forward conflict surface, and it is the only one, so it is worth knowing
about before February rather than during it.

By the rule above this belongs on `main` — the next club wants a card that can serve its own wall
too. It cannot go there yet: **`main` has no clubhouse page at all** (it arrived on this line in
#34), so config threading for a wall that does not exist would be dead code in the base system. When
the wall itself graduates to `main`, this goes with it and the conflict surface disappears. Until
then, a base change to `feeds.js` merges forward into a file this line has edited, and the resolution
is always the same: keep both, because the club file reading is additive to everything the dashboard
does.

One smaller thing stays here, and one has since gone home:

- **`soak-watch.sh` watched `/api/health`**, which is behind the dashboard login and answers 401 on
  every properly set-up card — a week-long outage that never happened. The instrument is club-line,
  so this one stays here.
- **The deploy-script CI check named eight scripts by hand** and had stopped covering the ninth.
  That is now on `main` (#46) and has arrived back here on the merge forward, which is the rule in
  the table working as intended. It cost one conflict in `.github/workflows/app.yml` — both lines
  had written the same `find` with different comments above it — resolved in favour of the base
  system's wording, because the club line's version named `deploy/soak-watch.sh`, a file `main`
  does not have. **Prefer the base wording in base files on a merge forward**; it is how the
  conflict stops recurring.

What v1 does and does not do is in `signage-server/CLUBHOUSE.md`, including the one line of the brief
it knowingly does not meet: while the wall runs on the `manual` source, somebody types in the week's
results on a Saturday evening. Switching to `fulltime` is a config line, not a rewrite.

## Keeping up with the base system

**Merge forward, never back.** `main` → `caldecote` only:

```bash
git checkout caldecote
git merge origin/main            # after a base release, or whenever main moves
# then bump the "base*" fields in caldecote/release.json to say what you are standing on
```

Nothing on this line should ever be merged into `main` wholesale. Base-worthy fixes travel as their
own small pull requests against `main`, as above — that is the whole point of the split.

`caldecote/release.json` and this file are owned entirely by this line and are never edited on
`main`, so a merge forward cannot conflict on the version. That is deliberate: the base version stays
in `app/package.json` and this line leaves it alone.

## Releasing

**Actions → Release (Caldecote line) → Run workflow**, version `0.0.3` — whatever
`caldecote/release.json` currently says.

It tags this branch `caldecote-<version>`, refuses the run if `caldecote/release.json` disagrees
with the version typed in, publishes the release and builds this line's own SD card image — about
fifteen minutes.

`caldecote-0.0.3` was published this way on 17 November 2026, tagged on this branch at `5afd947`.
The next cut bumps `caldecote/release.json` first; the workflow will refuse the version otherwise,
which is the point of that check.

**0.0.1 and 0.0.2 are superseded and must not be flashed.** Neither can show the club: 0.0.1 served
the wall with our name on it, and 0.0.2 fixed that but still needed four commands typed on the Pi
that nobody carrying a card to a pavilion was going to type. 0.0.3 is the first image where
flashing it is the whole job. Both older tags stay published rather than deleted — deleting a tag
somebody may have written down is worse than marking it replaced.

**The release is always a prerelease, and that is not cosmetic.** The website's download button
resolves `/releases/latest`, which GitHub omits prereleases from. Without the flag, publishing
Caldecote's build would move the link every stranger on `pitchtribe.co.uk` clicks. Both
`release-caldecote.yml` and `image.yml` enforce it.

## Two things that will trip you

**Branch names:** use `caldecote-<thing>`, with a hyphen. Git cannot hold a branch called `caldecote`
and a branch called `caldecote/fix-x` at the same time — the first is a file where the second needs a
directory — so the natural slash name is refused. Tags are unaffected (`caldecote-0.0.1` is fine).

**CI only knows the branch names it was told.** Every workflow in this repository is filtered by
branch, and `caldecote` had to be added to `app.yml`, `codeql.yml` and `image.yml` by hand. A future
club line gets no tests and no CodeQL until the same edit is made for it — which is the quietest way
imaginable for a branch that ships to a real building to stop working. Pull requests stacked on
*another* club-line branch (rather than on `caldecote` itself) still get no checks; retarget them at
`caldecote` once their base has merged.
