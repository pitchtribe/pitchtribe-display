# Remote dashboard access — decision record (PIT-223)

**Question:** how do club volunteers reach a Pi-hosted PitchTribe dashboard from off-site?
**Decision:** `cpfa.pitchtribe.co.uk` → Cloudflare Access → Cloudflare Tunnel (outbound from the Pi) → dashboard on `https://localhost:443`.
**Status:** built and independently verified live on 2026-11-26. **No inbound router port was opened.**

---

## Options considered, and why this one

| Option | Verdict |
| --- | --- |
| **Cloudflare Tunnel + Access** | **Chosen.** Browser-only — no client software for volunteers. Outbound connection only. Identity gate in front of the app. |
| Tailscale | Viable and arguably stronger for admin use, but every volunteer device needs a client installed and enrolled. Rejected on volunteer usability, not security. |
| Traefik + Authentik | Does not satisfy "no inbound ports" on its own — still needs a tunnel or VPN in front. Too much to operate for one Pi and one dashboard. |
| Self-hosted WireGuard | No per-user licensing, but needs a reachable endpoint and hands us key, routing, firewall and monitoring work. |
| Router port forwarding | **Rejected.** The app binds all interfaces, no host firewall ships by default, and unauthenticated health/player/display and first-run routes exist. Direct exposure is the one path that risks the device itself. |
| Raspberry Pi Connect Lite | Already shipped, and stays — but it is *time-limited PitchTribe support*, not ongoing owner access. Different job. |

## As-built, verified read-only on 2026-11-26

- Tunnel `pitchtribe-cpfa` (`ca5e80f9-a318-4c73-a607-ceacad3a3fb3`) — **healthy, 4 connections**.
- Ingress: `cpfa.pitchtribe.co.uk` → `https://localhost:443`, plus a **catch-all `http_status:404`** so no other hostname can be handed this Pi.
- Access app `PitchTribe CPFA Dashboard`, `aud` `f26d8779…6d78`, 12h session, **one allow policy: the owner's email**. Anything unmatched is denied.
- **Access enforced twice:** at the Cloudflare edge *and* on the Pi (`originRequest.access.required: true`, `audTag` matching the live app `aud`). A leaked tunnel route alone does not reach the dashboard.
- Unauthenticated probe of `/` and `/healthz` both return **302 to `pitchtribe.cloudflareaccess.com`** with `auth_status: NONE` — the normally-unauthenticated health route is gated too.
- The PitchTribe dashboard login remains in place behind all of this.

## Gotchas that cost real time — keep these

- **Auth domain is `pitchtribe`, not `rough-recipe-b0d0`.** The Access API's `organizations.name` still reports the old value and its JWKS endpoint 404s. With the stale name and `access.required: true`, `cloudflared` cannot fetch a signing key and rejects *every* request **after** a successful sign-in — which looks like an app fault, not a config fault. Treat the edge login redirect as authoritative for this value.
- **The Pi needs the tunnel *connector* token (`eyJ…`), not an API token.** It attaches one machine to one tunnel. An API token is strictly more dangerous: it can rewrite the Access gate itself. Exact least-privilege API scopes, if one is ever needed, are in `DANIEL-ONE-TOUCH-BOOTSTRAP.md`.
- **`noTLSVerify: true` is set and is correct here.** The origin hop is the Pi's own self-signed certificate over loopback; there is no network segment to intercept. Do not copy this to a non-loopback origin.

## Residual limits of the tunnel path

- **Uploads cap at 100 MB** at Cloudflare versus the app's own 1024 MB.
- **Port 8090 (first-run Wi-Fi setup) cannot be tunnelled** — first-run setup stays a trusted-LAN job.
- **Player screens must stay on the club LAN** until `TRUST_PROXY=loopback` ships (PIT-228). All tunnel traffic currently arrives as `127.0.0.1`, and SSE streams are capped per source IP.

## Operating notes

- Whoever controls the Cloudflare account controls the gate. Keep MFA on it and administrators few.
- Adding a volunteer = adding their email to the Access policy. Revoking = removing it. No Pi change either way.
- Emergency shut-off: disable the tunnel route or stop `cloudflared` on the Pi; the hostname stops resolving to anything useful.
- Re-test periodically that a signed-out visitor still gets the 302, especially after adding dashboard routes.
- **Dormant and untouched:** a second tunnel `pitchtribe-admin-box` (created 2026-11-09, `ssh://localhost:22` → `ssh.pitchtribe.media`, down, no connector) pre-dates this work. If it is a leftover, deleting it removes a dormant SSH route from the account. Owner's call.

Detail: `deliverables/pit-227/PI-CLOUDFLARED-RUNBOOK.md` (install, hazards, rollback) · `DANIEL-ONE-TOUCH-BOOTSTRAP.md` (the Pi step, now complete) · reviews PIT-224 / PIT-225 / PIT-226.
