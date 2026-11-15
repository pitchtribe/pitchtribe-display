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

The release image is the base system plus the wall's **code**. It carries no club content —
that is the boundary in the table above — so a freshly flashed card boots as a playlist
player until Caldecote's own files are on it. Two commands:

```bash
# On the Pi, from a checkout or a copied caldecote/ folder:
sudo install -o pitchtribe -g pitchtribe -m 0644 caldecote/clubhouse.json /var/lib/pitchtribe/clubhouse.json
sudo install -o pitchtribe -g pitchtribe -m 0644 caldecote/season.json    /var/lib/pitchtribe/season.json
sudo install -d -o pitchtribe -g pitchtribe -m 0755 /var/lib/pitchtribe/photos
sudo systemctl restart pitchtribe
```

Then point `PITCHTRIBE_URL` in `/etc/default/pitchtribe-kiosk` at `/feeds/clubhouse` and
restart `pitchtribe-kiosk`. `signage-server/CLUBHOUSE.md` has the long version.

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

Two smaller things are owed to `main` as hardening rather than fixes, and neither is live there:

- **The deploy-script CI check named eight scripts by hand** and had stopped covering the ninth. On
  this line the ninth is `deploy/soak-watch.sh`; on `main` that file does not exist, so the list is
  still complete there and nothing is going unchecked. The glob is the durable version regardless.
- **`soak-watch.sh` watched `/api/health`**, which is behind the dashboard login and answers 401 on
  every properly set-up card — a week-long outage that never happened. The instrument is club-line,
  so this one stays here.

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
