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

1. **A Pi with a card flashed from this repo**, on a real network, pointed at a real television —
   `PITCHTRIBE_URL` ending `/clubhouse`, not `/player`.
2. **Nine days**, not seven: one to set up and confirm the loop, seven untouched, one to report.
3. **The club file filled in** (`manual` source) — the wall renders without it, but then the soak is
   only testing the countdown and the blackout. The example file is enough if real data is not.
4. **Two physical events, mid-week, and I cannot do either from a terminal:**
   - **the mains pulled** at the wall, unannounced, ideally at night;
   - **the network cable pulled** and left out for an hour or two.

   A **£10 smart plug on the test Pi** turns the first one into something I can do myself, at an hour
   nobody chose, and repeat. On a real install the card gets permanent power — this is a test rig, and
   that is the one place a switchable socket earns its keep. The cable still wants a human hand, or a
   second smart plug on the router.
5. **Photographs for the pool**, if the Wednesday test is to mean anything. Twelve is wallpaper by
   Thursday; this has not moved since the brief said so, and it is still nobody's job.

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
under-voltage and thermal throttling flags, whether `/api/health` answers, **how old the data it
would show is**, whether `/clubhouse` actually renders, and whether the broadband is up.

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
| Never a blank screen | every sample got HTTP 200 from `/clubhouse` | any sample that did not |
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
