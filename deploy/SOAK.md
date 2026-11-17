# The seven-day soak, and who can do which half of it

Two of the brief's five "done" criteria are physical: **seven days unattended on a test
television**, and **the six-metre test photographed rather than asserted**. The board's answer on
PIT-45 was *"give me reach into a test Pi and I'll run and monitor the soak"* — so this document is
the half that can be done over that reach, the half that cannot, and the access it needs.

It also says plainly what the soak **cannot** prove, because a green report on a card nobody left
alone for a week is worth less than no report at all.

---

## What I need, concretely

The product already has two sanctioned ways in, so nothing new has to be built or opened:

| Route | What it is | What to send me |
| --- | --- | --- |
| **Raspberry Pi Connect support session** | Settings → Remote access in the dashboard; sessions expire by themselves (`pitchtribe-support-expire.timer`) | the session, renewed when it lapses |
| **SSH** | the same panel's SSH toggle, hardened by `deploy/ssh/10-pitchtribe-hardening.conf` | hostname or IP, an account, and my key added |

Either is enough. Alongside it:

1. **A Pi with a card flashed from the base system's latest release**, on a real network, pointed at
   a real television, **with the club's file placed and the kiosk pointed at the wall** (three
   commands, below). `PITCHTRIBE_URL` must end **`/feeds/clubhouse`**, not `/player`.
   (The card runs the app, which embeds the feed engine under `/feeds`; the bare `/clubhouse` is the
   standalone server's path and is not served on a card. `soak-watch.sh` reads the URL from the
   kiosk's own environment file rather than guessing, so a card pointed at the wrong page shows up in
   the report instead of looking like an outage.)
2. **Nine days**, not seven: one to set up and confirm the loop, seven untouched, one to report.
3. **Results in the season file**, `/var/lib/pitchtribe/season.json`. An empty season means the soak
   is only exercising the countdown, the blackout and the photographs. A week of real results, or
   `signage-server/data/club-season.example.json` copied over it, is what makes the heartbeat slides
   part of the test. **Editing it on the card is safe across an upgrade**: `club-content.sh` never
   overwrites a file already in the data directory.
4. **Two physical events, mid-week, and I cannot do either from a terminal:**
   - **the mains pulled** at the wall, unannounced, ideally at night;
   - **the network cable pulled** and left out for an hour or two.

   A **£10 smart plug on the test Pi** turns the first one into something I can do myself, at an hour
   nobody chose, and repeat. On a real install the card gets permanent power — this is a test rig, and
   that is the one place a switchable socket earns its keep. The cable still wants a human hand, or a
   second smart plug on the router.
5. **Photographs for the pool**, if the Wednesday test is to mean anything. Twelve is wallpaper by
   Thursday; this has not moved since the brief said so, and it is still nobody's job.

## The rig the board offered, identified — and a correction

The board named `192.168.1.194` on PIT-45. That box was written off at the time as *"not the
clubhouse display we built — our server serves `/clubhouse`, `/player` and `/api/health`, this one
redirects `/` to `/admin/`."* **That was wrong, and the way it was wrong is worth keeping.**

`app/lib/app.js` ends with `app.get('/', (req, res) => res.redirect('/admin/'))`. Redirecting `/` to
`/admin/` is not evidence against it being one of ours — **it is the single most distinctive thing a
PitchTribe card does.** The comparison was made against `signage-server`'s routes, which is the
engine, not the thing an installed card runs. Same mistake as the bug in #43, made about the same
boundary a day apart: reasoning about the engine's seams instead of the card's.

What it actually answers, asked rather than assumed:

| Request | Answer | What that means |
| --- | --- | --- |
| `GET /healthz` | `{"ok":true,"version":"0.4.2"}` | **a PitchTribe card, running the base system at v0.4.2** |
| `GET /` | `302` → `/admin/` | `app/lib/app.js`, verified on both `:80` and `:443` |
| `GET /api/health` | `401` | behind the dashboard login, exactly as #43 found |
| `GET /player` | `301` | the base playlist screen is there |
| `GET /feeds/` | `302` | the feed engine **is** mounted |
| `GET /feeds/clubhouse` | `404` | v0.4.2 predates the wall; the next base release carries it |

So the rig exists, it is reachable, and `tcp/22` is open. It is **not a blank Pi waiting for an
image**: it is a working v0.4.2 card.

### The route the board chose: a second card

**Asked whether to upgrade `194` in place or flash a second card, the board chose the second card.**
Flashing also keeps `194` as the thing it already is — a working v0.4.2 card to compare against, and
the control for any question of the form *"did this break it, or was it always like that?"*.

```
Raspberry Pi Imager → Choose OS → Use custom → pitchtribe-rpi-arm64.img.xz
  from the latest release, then Imager's own customisation for hostname,
  Wi-Fi and SSH. Write, boot, point the television at it.
```

A base card boots as a **playlist player**. Three commands over SSH turn it into the club's wall, and
they are the same three on a flashed card and on `194`:

```bash
# 1. the club's own file, in the data directory. Start from
#    signage-server/clubhouse.example.json and fill in the club's values.
sudo install -o pitchtribe -g pitchtribe -m 0644 clubhouse.json /var/lib/pitchtribe/clubhouse.json
# 2. point the kiosk at the wall rather than at /player
sudo sed -i 's#^PITCHTRIBE_URL=.*#PITCHTRIBE_URL=http://localhost/feeds/clubhouse#' \
  /etc/default/pitchtribe-kiosk
# 3. pick both up
sudo systemctl restart pitchtribe pitchtribe-kiosk
```

**Say the cost of this out loud:** a flashed card is not the club until somebody types those three
lines. A retired club line could flash a card that came up as the club with nothing typed on it, and
giving that up is a real loss for the install in the pavilion — where the person holding the card is
a volunteer, not whoever wrote this. For the soak it costs nothing, because the soak is run over a
terminal anyway. For the install it is the open question, and the mechanism to close it again is
still here: `deploy/club-content.sh` plus a club directory, built into an image with
`PITCHTRIBE_CLUB_DIR`, needs no branch of its own.

### Flashing it and seeing a black screen is the expected result

**A card commissioned outside the club's opening hours blacks out its own picture, and that is the
card working.** It is also indistinguishable from a card that did not boot, which is how the first
real flash of this was reported as *"it didn't load"*. Caldecote's hours are Saturday only, so six
days a week a correct card shows nothing at all.

Two things follow, and the first one is now in the code:

- From this version a closed card keeps a **dim standby line** — the club's name and when it next
  opens — instead of going to pure black. Walk up to the television and the card tells you it is
  alive. From six metres in a lit room it is invisible, so a committee meeting still gets a dark
  screen. `signage-server/src/clubhouse-render.js`, and `test/clubhouse.test.js` pins it.
- When commissioning, **check the wall by asking for it rather than by looking at the television**:
  `curl -s localhost/feeds/clubhouse | head -40` answers whatever the hour, and
  `soak-watch.sh report` says what the screen is doing and why.

### The access that is still missing

SSH is open on the rig but nothing of ours is trusted on it. The key half of that is done — a
dedicated keypair for this soak exists outside the repo, so this is one line pasted on the Pi rather
than a credential sent anywhere:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII+OQGVXDMMyhGiw10fJAXGwkCMrfgt7BqKpBlR7nvvM pitchtribe-soak-pit-45
```

`ssh-copy-id` or one append to `~/.ssh/authorized_keys`, plus **which account** it went on. Nothing
of the board's is shared, and the key is scoped to this one job: when the soak is done, delete that
line and the access is gone.

## What I do with it

```bash
# once, at the start
sudo install -m 755 deploy/soak-watch.sh /usr/local/bin/pitchtribe-soak-watch
sudo install -m 644 deploy/pitchtribe-soak.service deploy/pitchtribe-soak.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pitchtribe-soak.timer

# every day, and this is the whole of my involvement
pitchtribe-soak-watch report

# when a human does something to the rig
pitchtribe-soak-watch event "mains pulled at the wall"
```

A sample a minute: uptime, service restart counts, Chromium's RSS, memory, SoC temperature,
under-voltage and thermal throttling flags, whether `/healthz` answers, **how old the data it
would show is**, whether the wall itself actually renders, and whether the broadband is up.

The three addresses it watches are printed at the top of every report, because every figure in one
is about them. The wall's URL is **read from the kiosk's own environment file**, not guessed: a soak
that watches a different page from the one on the television can report a healthy week about a page
nobody is looking at.

**The write path is deliberate, because SD-card wear is a constraint of this project and not a
worry I invented.** The minute-by-minute samples live in tmpfs and are capped. The card itself gets
one line an hour, one line per state change, and one line per human event — about 200 lines for the
whole week. A soak instrument that wore out the card it was watching would be a joke at this
project's expense.

Nothing phones home. The only outbound request is one 204 to check the broadband; the card is no
more reachable with this installed than without it.

## What the report answers, and in whose words

`report` prints a verdict per criterion rather than a wall of numbers, because the question is
"did it pass", not "what was the temperature on Tuesday":

| Criterion | What makes it a pass | What would fail it |
| --- | --- | --- |
| Seven days unattended | a full week of samples with no unexplained gaps | a gap nobody has an event line for |
| Recovers on its own | back to a rendering wall within five minutes of every reboot | a reboot that needed a keyboard |
| Never a blank screen | every sample got HTTP 200 from the kiosk's own wall URL | any sample that did not |
| Stale but dated | worst data age is explainable (a week, with the feed off, is correct) | a date that stops moving while the screen claims otherwise |
| Not leaking | Chromium's RSS flat across the week | a trend, not a peak — a peak on day one is fine |
| Power, not software | no under-voltage or throttling flag | a flag, which means buy a better supply before blaming the code |

The restart count is the one I would look at first. **A Pi that has quietly restarted every six
hours looks exactly like a Pi that has been fine**, and systemd knows the difference even when the
screen does not.

## What this does not prove, stated before anyone quotes it

- **It is not the six-metre test.** `grim` over SSH can grab the framebuffer and prove what was on
  the screen at 3am — it cannot see glare off the window behind the bar, a dirty screen, the angle
  people actually stand at, or a set with its sharpness turned up. The type sizes are measured
  (`npm run six-metre`); whether the *room* can read them needs a camera and somebody standing in it.
- **It is not the Wednesday test** until there are photographs in the pool. With an empty pool there
  are no photo slides to be different from Sunday's.
- **Killing a service over SSH is not a power cut.** It skips the part most likely to break: an
  interrupted write to the SD card. Only the plug tests that, which is why the plug is on the list.
- **One week on one Pi is one data point.** It catches a leak, a restart loop and a corrupt-on-boot
  card. It does not catch the thing that goes wrong in February.

## Afterwards

The timer and the script come off the test card — `systemctl disable --now pitchtribe-soak.timer` —
and `soak.log` is worth keeping with the install notes. It is the only durable record that the week
happened, and the first thing I would want if the screen in the pavilion ever misbehaves.
