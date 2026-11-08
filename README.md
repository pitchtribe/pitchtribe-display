# PitchTribe — website

[![Deploy to Cloudflare Pages](https://github.com/pitchtribe/pitchtribe-display/actions/workflows/deploy.yml/badge.svg)](https://github.com/pitchtribe/pitchtribe-display/actions/workflows/deploy.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-2ce6a8.svg)](LICENSE)

The marketing site for **PitchTribe** — open-source digital signage for sports and social clubs,
running on a Raspberry Pi 5. Noticeboards, fixtures, bar menus and a guest Wi-Fi portal, managed
from any device on the club's own network.

**Live at [pitchtribe.media](https://pitchtribe.media).**

This repository contains the website and the signage software, which installs on a Pi as one package
with `deploy/install.sh`:

- [`app/`](app/README.md): the signage app. A Node.js server with a management dashboard and a kiosk
  player. It hosts the sports engine below at `/sports`.
- [`signage-server/`](signage-server/README.md): the sports engine. It collects fixtures, live scores and
  results (display page, JSON API, webhook push, MCP). The app uses it as a library, and it can also run on its own.

## Hosting

| Hostname | Behaviour |
| --- | --- |
| `pitchtribe.media` | Canonical. Served by Cloudflare Pages via a custom domain. |
| `www.pitchtribe.media` | 301 → `pitchtribe.media` |
| `pitchtribe.co.uk` | 301 → `pitchtribe.media` |
| `www.pitchtribe.co.uk` | 301 → `pitchtribe.media` |
| `pitchtribe-website.pages.dev` | Pages default domain; serves the same build. |

The three redirects are Cloudflare **Single Redirect** rules in each zone's
`http_request_dynamic_redirect` phase, not DNS changes — they fire at the edge, so each zone keeps
its own apex record and its email routing (MX/SPF/DKIM) untouched.

## Repository layout

| Path | Purpose |
| --- | --- |
| `html/` | Static root, copied verbatim into `dist/`. Add a page here. |
| `html/index.html` | Landing page |
| `html/buy.html` | `/buy` — parts list, ready-built units, installation |
| `docs/` | `/docs/` — the user documentation (setup guide, dashboard, troubleshooting…). Built by `scripts/docs-build.mjs`; see [Documentation](#documentation) |
| `image/build.sh` | Builds the ready-to-flash SD card image (Raspberry Pi OS Lite + PitchTribe); `.github/workflows/image.yml` runs it |
| `html/_headers` | Cloudflare Pages response headers (CSP and cache policy) |
| `src/styles.css` | Tailwind v4 entry point: design tokens, component classes |
| `scripts/fingerprint.mjs` | Content-hashes built assets and rewrites HTML references |
| `scripts/i18n-build.mjs`, `i18n/` | Builds `/fr/`, `/es/`, `/de/`, `/it/`, `/pt/`, `/pl/`, `/ru/`, `/zh/`, `/ja/` from the English pages and `i18n/<lang>.json`, plus hreflang tags and the sitemap |
| `wrangler.toml` | Pages project config (`pages_build_output_dir = "./dist"`) |
| `.github/workflows/deploy.yml` | CI: build on pull requests, build and deploy on push to `main` |
| `signage-server/` | Sports fixtures/scores server: display page, JSON API, webhook push, MCP. Not part of the site build |
| `dist/` | Build output (git-ignored) |
| `app/` | Signage app: dashboard, player and server — see [`app/README.md`](app/README.md) |
| `deploy/` | Raspberry Pi installer, systemd units and kiosk launcher for the app |
| `deploy/ssh/` | sshd drop-in that hardens remote access — see [Device hardening](#device-hardening) |
| `.github/workflows/app.yml` | CI: tests the signage app when `app/` or `deploy/` change |

## Languages

The English pages in `html/` are the single source of truth. At build time `scripts/i18n-build.mjs` generates a copy of each page in nine more languages:

- `i18n/source.json` lists every translatable English string: text, `alt`, `aria-label`, `title` and meta descriptions.
- `i18n/<lang>.json` maps a string's position in that list to its translation.
- A string with no translation shows in English, so the site never breaks.

After editing English text:

```bash
npm run i18n:update   # append new English strings to i18n/source.json (positions never shift)
npm run i18n:check    # list what still needs translating, per language
```

Translations are inserted as plain text: no HTML tags, and `&` must be written as `&amp;`. The build rejects anything else.
The header has a language switcher that works without JavaScript. Every page gets hreflang alternates, and the sitemap lists all languages.

## Documentation

The docs at [pitchtribe.media/docs](https://pitchtribe.media/docs/) are written for club volunteers, not developers, and live in `docs/`:

- `docs/_layout.html` is the page shell (header, sidebar, footer).
- `docs/<slug>.html` is one page's content. It starts with a front-matter comment: `<!-- {"title": "…", "description": "…"} -->`.
- `docs/img/` holds pictures, served at `/docs/img/`.

To add a page, create the file and add it to `NAV` in `scripts/docs-build.mjs`, which sets the sidebar order. The build writes `dist/docs/<slug>.html`, which Pages serves at `/docs/<slug>`. It adds the pages to the sitemap, and it fails if a `/docs/` link points at a page that doesn't exist. Code blocks written as `<pre data-copy>` get a Copy button.

The docs are English only for now. Screenshots of the dashboard come from the real app, so retake them when its screens change.

## Local development

Requires Node 22 (see `.nvmrc`).

```bash
npm ci
npm run build     # clean → copy html/ → compile Tailwind → fingerprint assets
npm run dev       # build, then watch and recompile CSS on change
npm run preview   # build, then serve dist/ on Cloudflare's runtime at http://localhost:8788
```

`docker compose up` also serves a built `dist/` with nginx at http://localhost:8088.

> Changes to `html/*.html` only reach `dist/` through a build — `npm run dev` watches CSS, not markup.

### What the build does

1. **clean** — removes `dist/`.
2. **copy** — copies `html/` into `dist/` unchanged.
3. **build:css** — compiles `src/styles.css` into `dist/assets/app.css`, minified.
4. **fingerprint** — renames each asset to include a content hash (`app.248da1c0.css`) and rewrites
   every reference in the built HTML, then fails the build if an unhashed reference survives.

Step 4 exists because `_headers` caches `/assets/*` for a year while HTML is `must-revalidate`. With
stable filenames a returning visitor could hold last week's stylesheet alongside today's markup and
see the page render half-styled. Hashing the filename makes every build a new URL, so the long cache
is safe and changes land immediately.

## Deployment

Pushing to `main` builds the site and runs:

```
wrangler pages deploy dist --project-name=pitchtribe-website --branch=main
```

The Pages project uses **Direct Upload** rather than a Git integration — CI owns the build, and a
Git integration would build the site a second time and fight it.

The deploy job runs in the **`cloudflare_api`** GitHub environment, because that is where
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are scoped. A job can only read repository-level
secrets plus secrets scoped to its own environment, so moving those secrets to repository level
means changing `environment:` in `deploy.yml` to match. The job fails fast and names the missing
variable if either secret resolves empty.

The API token needs the **Cloudflare Pages: Edit** permission and nothing more.

A deploy can also be run manually with `workflow_dispatch`, or from a workstation with
`npx wrangler login && npm run deploy`.

## Device hardening

A club Pi sits on a shared network, often in a public room, and nobody administers it. The
hardening lives in the code that provisions the card — `deploy/*.service`, `deploy/ssh/`,
`deploy/install.sh` and `image/build.sh` — not in a separate configuration-management layer, so
flashing a card and running the installer give the same result. `app/test/hardening.test.js`
pins the decisions below, and runs in CI with the rest of the app tests.

**The dashboard** (`deploy/pitchtribe.service`) runs as the unprivileged `pitchtribe` user under a
systemd sandbox: `ProtectSystem=strict` with `/var/lib/pitchtribe` as the only writable path, so a
flaw in the dashboard cannot rewrite the code that serves it; a `@system-service` syscall filter;
`RestrictAddressFamilies`, `RestrictNamespaces`, `ProtectProc=invisible` and `UMask=0077`.

**The boot configuration** (`image/build.sh`) disables the serial console (`enable_uart=0`, which is
otherwise a root shell for anyone who can reach the board) and the Bluetooth radio, and boots
quietly so the screen shows nothing before the kiosk.

The quiet boot is `image/harden-cmdline.sh`, and the part that does the work is moving the kernel
console to `tty3`. On a stock card it is `tty1` — the HDMI output — and the first boot writes to it
for a while (the card resizes its own filesystem and reboots, then cloud-init runs) before the kiosk
takes the screen; `quiet` alone leaves a club TV showing boot text. `getty@tty1` is already off
(`deploy/install.sh`), so once the console moves, nothing writes to the screen the room can see. The
trade-off: if the kiosk never starts, the TV now stays black instead of showing the boot log — a
keyboard and **Alt+F3** still bring it up, and `journalctl -b` over SSH is the better route anyway.
Re-enabling the serial console for debugging means putting back both `enable_uart=1` in `config.txt`
and `console=serial0,115200` in `cmdline.txt`.

**SSH** (`deploy/ssh/10-pitchtribe-hardening.conf`) is off until someone switches it on in
**Settings → Remote access**. The drop-in refuses root logins and empty passwords, and limits
authentication attempts, sessions and the login grace time.

Four things are deliberately **not** done, each because it breaks the product:

| Not done | Why |
| --- | --- |
| Empty `CapabilityBoundingSet` on the dashboard | It serves port 80 as a non-root user and needs `CAP_NET_BIND_SERVICE`. Emptying the set stops it starting at all. |
| `MemoryDenyWriteExecute` | V8 maps its JIT pages write-then-execute; Node exits on start. |
| OverlayFS read-only root | The club's whole configuration — database, media, backups — lives in `/var/lib/pitchtribe` on the root filesystem, so an overlay root discards it on every reboot. |
| A UFW firewall | The guest Wi-Fi portal runs its own nftables ruleset (`deploy/portal/portal-apply.sh`) and the two would fight over the same tables. A deny-incoming default also needs holes for mDNS, DHCP and DNS or it breaks `http://pitchtribe.local` and the portal. |

`PasswordAuthentication` stays enabled and SSH stays on port 22 for the same reason: Remote access
works by setting a password for the login, and the setup docs tell people to use the default port.

### Guest Wi-Fi on the card

The dashboard offers **Guest Wi-Fi** on every card, so the card has to be able to carry it out:
`image/build.sh` installs the portal by default (`PITCHTRIBE_PORTAL=0` leaves it out). Without it the
club switches guest Wi-Fi on, is told the network "updates in a few seconds", and no network ever
appears — which is exactly what happened to the first v0.4.0 card. The dashboard now also reports
whether the helper is present (`installed` in `GET /api/portal`) and says so on the page rather than
reporting success.

Installing it changes nothing until someone switches guest Wi-Fi on. `pitchtribe-portal-apply` is
the only thing that starts these, from the saved settings, so `deploy/install.sh` keeps all three out
of the boot sequence: `dnsmasq` is disabled (its stock configuration would answer DHCP and DNS on
every interface — a second, unasked-for DHCP server on the club's network), `hostapd` stays masked
as Debian ships it, and `pitchtribe-portal.service` is not enabled because it binds the guest bridge
address `10.42.0.1`, which only exists while guest Wi-Fi is on.

The one-line installer still leaves guest Wi-Fi out unless asked
(`curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_PORTAL=1 bash`), because a Pi
installed by hand is not necessarily the club's signage box.

## Releases

A release is a tag on `main` plus the SD card image attached to it, which the website's download links fetch from the latest release.

- **To release:** open **Actions → Release → Run workflow** and enter the version (e.g. `v0.2.0`, matching `app/package.json`). The workflow tags `main`, creates the release and builds the image. That build runs `.github/workflows/image.yml` as a reusable workflow, and takes about 15 minutes.
- **To redo a release that went wrong** (for example one whose tag points at the wrong commit): run it again with **replace** ticked. It deletes the old release and tag first.

Publishing a release by hand on GitHub still works too: the tag push starts the same image build.

## Conventions worth knowing

These are the three things that have caused real defects here.

**Tailwind scans `html/` and nothing else.** `src/styles.css` imports Tailwind with `source(none)`
and an explicit `@source "../html"`. Without that, Tailwind's automatic content detection scans
every non-ignored file in the repo and harvests ordinary prose as class names — `README.md`,
`package.json` and a workflow step name were each contributing phantom utilities (`.visible`,
`.contents`, `.inline`, `.static`). Prose inside `html/` can still do this, so diff the generated
CSS after a copy change and confirm the class set only gained utilities the markup actually uses.

**The inline script is pinned by hash.** `html/_headers` sets a strict CSP, and the one inline
script in each page is allow-listed by its SHA-256. Change that script and the CSP must be
regenerated, or the `js` class is never added and every progressive enhancement silently stops:

```bash
printf "%s" "document.documentElement.classList.add('js')" | openssl dgst -sha256 -binary | base64
```

**Prices on the site carry a date.** The hardware costs in the FAQ and on `/buy` are a dated
snapshot, because Raspberry Pi board prices moved three times during 2026. Re-check them when
touching that copy, and keep the date stamp honest.

## Licence

[MIT](LICENSE) — © 2026 Daniel Newbury, trading as PitchTribe.

## About

PitchTribe is a UK sole trader, registered and covered by public liability insurance.

- **Address:** 2 Jubilee Place, Shefford, Bedfordshire, SG17 5JP, United Kingdom
- **Sales and installation enquiries:** sales@pitchtribe.media
- **Press:** press@pitchtribe.media

Ready-built units and on-site installation are quoted per job — see
[pitchtribe.media/buy](https://pitchtribe.media/buy). The software itself is MIT-licensed and free,
and building it yourself from the published parts list is a first-class option.

Raspberry Pi is a trademark of Raspberry Pi Ltd. PitchTribe is not affiliated with Raspberry Pi Ltd.
