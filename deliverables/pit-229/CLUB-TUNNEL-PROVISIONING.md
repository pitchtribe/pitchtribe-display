# Provisioning a club's tunnel — one per club, in our Zero Trust account

**Status:** procedure, verified against the live account 2026-11-26. Owner: Chief of Staff.
**Board decision this implements (PIT-227 thread, 2026-11-26):** *"We pre-create one tunnel per club in our Zero Trust account."* The club never signs in to Cloudflare, never creates a tunnel, never sees an API token. They receive one string: their connector token.

This document is the other half of PIT-231 / PIT-236. Those issues build the box the token is typed into; this is where the token comes from, what it may contain, and how it is taken away again.

## Why it is done centrally, and what that buys

The tunnel is **remotely managed** (`config_src: "cloudflare"` on both existing tunnels — verified). There is no `config.yml` on the Pi. Ingress rules, the public hostname and the Access policy all live in our account.

That is the whole safety argument for putting a credential box in a commissioning UI: **a connector token alone publishes nothing.** It lets a card *offer* itself to our tunnel; what the world can then reach through it is whatever we configured, behind whatever Access policy we set. A club that pastes their token cannot accidentally publish their dashboard to the open internet, because they do not control the ingress and cannot create one.

If anything ever puts a local ingress config on the card, this argument dies and the feature should be pulled. PIT-232 is asked to verify it.

## Live state at time of writing

| | |
|---|---|
| Account | `ad7861717c55f5e2f439ca07d7402f35` |
| Zone for club hostnames | `pitchtribe.co.uk` — `3698281358c72493f943f18739cc5e6b` (active) |
| Zero Trust team (auth domain) | `pitchtribe` → `https://pitchtribe.cloudflareaccess.com` |
| Existing club tunnel | `pitchtribe-cpfa` `ca5e80f9-a318-4c73-a607-ceacad3a3fb3` — healthy, 4 conns |
| Existing Access app | `PitchTribe CPFA Dashboard`, `cpfa.pitchtribe.co.uk`, aud `f26d8779…` |
| Other tunnel, unrelated | `pitchtribe-admin-box` — down, 0 conns (PIT-26) |

`pitchtribe-cpfa` is the worked example: everything below is what was actually done for CPFA, generalised. Also note `pitchtribe.media` is in the same account — club hostnames go under `pitchtribe.co.uk` unless the board says otherwise.

**The team name is `pitchtribe`, not `rough-recipe-b0d0`.** The API still reports the latter under `organizations.name`; it is dead. `https://rough-recipe-b0d0.cloudflareaccess.com/cdn-cgi/access/certs` → 404, `https://pitchtribe.cloudflareaccess.com/...` → 200. Put the stale one in a tunnel's `originRequest.access` and cloudflared cannot fetch a signing key, so it rejects **every** request *after* a successful sign-in — a 403 that reads like a permissions bug. The edge login redirect is authoritative for this value; the API field is not.

## Per-club procedure

Naming, so the account stays legible at twenty clubs: tunnel `pitchtribe-<club>`, hostname `<club>.pitchtribe.co.uk`, Access app `PitchTribe <CLUB> Dashboard`. `<club>` is the short lowercase club slug.

**1. Create the tunnel.** `POST /accounts/{account}/cfd_tunnel` with `{ name: "pitchtribe-<club>", config_src: "cloudflare" }`. `config_src` is not optional — omit it and you get a locally-configured tunnel, which breaks the invariant above.

**2. Create the Access app first, before any ingress.** `POST /accounts/{account}/access/apps` — `type: "self_hosted"`, `domain: "<club>.pitchtribe.co.uk"`, session duration `12h`. Then one `allow` policy naming the club's admin email(s) and nothing else; everything not matched is implicitly denied. Keep the returned **`aud`** — step 4 needs it. No bypass policy, no service token, ever.

**3. DNS.** Proxied `CNAME` `<club>` → `<tunnel-id>.cfargotunnel.com` in zone `pitchtribe.co.uk`. Proxied is what makes the tunnel reachable at all; grey-cloud it and the hostname is dead.

**4. Ingress.** `PUT /accounts/{account}/cfd_tunnel/{tunnel}/configurations`:

```json
{ "config": { "ingress": [
  { "hostname": "<club>.pitchtribe.co.uk",
    "service": "https://localhost:443",
    "originRequest": { "noTLSVerify": true,
      "access": { "required": true, "teamName": "pitchtribe", "audTag": ["<aud from step 2>"] } } },
  { "service": "http_status:404" } ] } }
```

- **`https://localhost:443`** — the installer sets `HTTPS_PORT=443` and the dashboard binds `0.0.0.0`, but both are per-Pi overridable, so **confirm the origin on the device** before publishing. Never guess it. A wrong origin is a 502 on every request.
- **`noTLSVerify: true`** is required because the Pi's cert is self-signed with no public CA in the chain — *not* because the name fails: `app/lib/tls.js:37` puts `localhost` in the SAN list, so the name check passes. The hop is loopback inside the Pi; nothing of that cert is visible to clients.
- **`access.required: true`** makes cloudflared on the Pi validate the Access JWT itself, so the origin is protected even if someone reaches the tunnel another way — edge enforcement alone is not enough.
- The trailing **`http_status:404`** catch-all means no other hostname can ever be quietly handed this club's Pi.

**5. Hand over the token.** `GET /accounts/{account}/cfd_tunnel/{tunnel}/token` returns the connector token — a base64url blob decoding to JSON with `a` (account), `t` (tunnel ID) and `s` (tunnel secret). That shape is what PIT-231's validator checks for, and it is what tells a mistaken paste (a `cert.pem`, an API token, an account-wide credential) apart from the real thing.

**Handling rules, not suggestions.** It is a bearer credential for that club's tunnel: anyone holding it can attach a connector. Send it to the club admin over a channel the club admin controls. **Never** paste it into a Paperclip thread, a GitHub issue, a commit, a log, or a screenshot. Never fetch it into an agent transcript "just to check the shape" — the shape is documented above, which is why this paragraph exists.

**6. Verify before telling the club it is ready.** Tunnel status `healthy` with ≥1 connection; `audTag` in the ingress equals the Access app's `aud`; the CNAME is proxied; and unauthenticated `curl` of `/`, `/admin`, `/healthz`, `/api/status` and `/static/*` all `302` to the Access login. Probe `/healthz` and `/static/*` specifically — a health endpoint or asset prefix left outside the app is the classic open window.

## Re-check after any edit to the Access app

Recreating or replacing an app mints a **new `aud`**. A stale `audTag` in the ingress denies everyone, with the same misleading symptom as the dead team name: clean sign-in, then 403. Any time the Access app is touched, re-read its `aud` and re-`PUT` the ingress.

## Revocation, and what the card must survive

Revoking is ours and central: rotate the tunnel secret, or delete the tunnel. Either invalidates the token already on the club's card — there is nothing to uninstall and no need for shell access. Deleting the DNS record takes the hostname dark while leaving the connector intact.

This is why PIT-231 and PIT-236 are both required to handle a **revoked** token as its own honest outcome ("no longer valid — ask PitchTribe for a new one"), distinct from "no network yet", and why a revoked token must never affect the LAN dashboard or the player. Nothing on the card needs a revoke feature; the card only needs to fail politely.

## Standing limits per club, inherited from PIT-227

- **Uploads over the tunnel cap at 100 MB** (Cloudflare free plan) against the app's own 1024 MB. Large video uploads stay on the club LAN.
- **Player screens stay on the club LAN.** SSE is capped at 12 streams per source IP (`app/lib/hub.js:12`) and all tunnelled traffic arrives as one address — `127.0.0.1` until `TRUST_PROXY=loopback` ships (PIT-228), and one edge address after. The tunnel is for one or two admins, not for screens.
- **Port 8090 (the commissioning page) cannot be tunnelled** and must not be: the kiosk-UID nftables reject in `deploy/setup/wifi-http-firewall.sh` drops non-kiosk traffic to it by design.
