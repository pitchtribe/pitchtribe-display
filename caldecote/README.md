# The Caldecote line

**You are on a club line, not on the base system.** This branch carries one club's build — Caldecote
FC, The Pavilion, Harvey Close, Upper Caldecote — on top of PitchTribe, and is released on its own
numbering. The current version is **caldecote 0.0.1** (`caldecote/release.json`).

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
`src/sources/manual.js` is a defect in the base system — it is reaching ESPN installs too — and
fixing it only here means every other club keeps the bug. **Those go to `main` as their own pull
request, and arrive back here on the next merge forward.**

Two such fixes currently live only on this line, and are owed to the base:

- **`sortEvents` went `NaN` on an unrecognised status.** `STATUS_ORDER[a.status] -
  STATUS_ORDER[b.status]` against a four-key map makes one `undefined - number` enough to render the
  comparator inconsistent and the whole display order meaningless. On the ESPN path as well as this
  one.
- **`normalizeStatus` read a whole phrase as `scheduled`.** A league that writes *"Postponed — pitch
  unplayable"* in one cell matched no single word, and an unmatched status fell through to
  `scheduled` — which decides whether a published score is shown. `manual` is a base source, so this
  is a base bug.

## What this line is made of

Base system, plus the PIT-45 work in this order:

1. **#35** — `fix/espn-fixture-clock`. Already a base fix and already aimed at `main`; it is only
   listed here because the branches below contain it.
2. **#33 → #34 → #36** — the Full-Time route decision (`signage-server/FULL_TIME.md`), the clubhouse
   wall, and the `fulltime` source adapter. These stack: **#36 contains #33 and #34**, so merging #36
   delivers all three.
3. **#37** — the soak instrument (`deploy/soak-watch.sh`, `deploy/SOAK.md`), stacked on #34.

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

**Actions → Release (Caldecote line) → Run workflow**, version `0.0.1`.

It tags this branch `caldecote-0.0.1`, refuses the run if `caldecote/release.json` disagrees with the
version typed in, publishes the release and builds this line's own SD card image — about fifteen
minutes.

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
