# PIT-231 — the connector-token storage contract, and what is verified behind it

**Status:** verification record and rationale. Written while PIT-231 was blocked on PIT-230,
then implemented once PIT-230 landed — the code described here is in the tree, and
`deploy/setup/COMMISSIONING.md` is the authoritative copy of the storage contract that PIT-236
targets. This document is the evidence behind each line of it.

This answers the three constraints the parent put on requirement 5, in order, and corrects
three things that were assumed rather than checked — including one of my own earlier notes.
Everything below was verified before any of it was built.

---

## 0. The version everything below is verified against

`cloudflared 2026.11.2`.

That is not a guess about what PIT-230 installs; it is the version PIT-230's installer would
fetch today. Two independent checks, both run from this workspace:

| What | Result |
| --- | --- |
| `pkg.cloudflare.com/cloudflared dists/any/main/binary-arm64/Packages` | `Package: cloudflared` / `Version: 2026.11.2` / `Architecture: arm64` |
| `github.com/cloudflare/cloudflared` latest release | tag `2026.11.2`, published 2026-11-23 |

`deploy/install.sh` installs `cloudflared` from that apt repo unpinned (and falls back to
`releases/latest/download/cloudflared-linux-arm64.deb`), so the apt-published version *is* the
version a freshly built card gets. All source line references below are from the `2026.11.2`
source tree, which matches that published package.

**Consequence of being unpinned:** a card flashed in six months gets a later cloudflared, and a
card flashed today and never updated keeps this one. Everything in §1 is upstream's documented
interface rather than an accident of this release, but the unit must not *depend* on a version —
see the startup self-check in §3.

---

## 1. Parent point 3 — does `TUNNEL_TOKEN` work for a remotely-managed tunnel? **Yes. Verified.**

Four things had to be true. All four are, in `2026.11.2`:

1. **`tunnel run` accepts a token from the environment.**
   `cmd/cloudflared/tunnel/subcommands.go:127-131` defines the `--token` flag with
   `EnvVars: []string{"TUNNEL_TOKEN"}`, and `subcommands.go:714-726` (`buildRunCommand`) puts
   that flag in `run`'s own flag set. So `cloudflared tunnel run` with `TUNNEL_TOKEN` in the
   environment and **no token on the command line** is a supported invocation, not a shortcut.
   (`--token-file` / `TUNNEL_TOKEN_FILE` exists too — see §2.)

2. **A token taken that way goes down the remotely-managed path.**
   `subcommands.go:769-791` (`runCommand`): it reads the token, `ParseToken`s it, and on success
   returns `sc.runWithCredentials(token.Credentials())` — the credentials come out of the token
   itself, and nothing reads a local config file. It only falls back to the tunnel-ID /
   credentials-file path when the token is empty. This is the same code path
   `cloudflared service install <TOKEN>` ends up on; only the delivery of the token differs.

3. **No local `config.yml` is involved.** Confirms the doctrine recorded in PIT-227/PIT-223:
   `cmd.go:339-340` only *logs* differently for locally-configured tunnels
   (`config.GetConfiguration().Source() == "" && c.String(TunnelTokenFlag) == ""`). Ingress and
   hostname stay in the Zero Trust account. A club entering a token gets exactly what the
   account already serves — the token alone publishes nothing.

4. **cloudflared redacts `TUNNEL_TOKEN` in its own logs.** This matters because the connector's
   journal is ours to produce evidence about (requirement 7). `configuration.go:41-46` lists the
   token flag in `secretFlags` *and* `secretEnvFlags`; `logClientOptions`
   (`configuration.go:63-94`) prints every `TUNNEL_*` environment variable it finds at startup —
   `Environmental variables map[...]` — but passes each name through `isSecretEnvVar`
   (`configuration.go:106-114`) and substitutes `*****` for ours. So the one upstream log line
   that would otherwise dump our credential into journald is already redacted at this version.
   Requirement 7 still has to *demonstrate* this on a Pi; it is no longer a hope.

**No fallback to a token on the command line is needed, and none will be written.**

---

## 2. Correction to requirement 5 as written: `--no-autoupdate` goes *before* `tunnel`

Requirement 5 says the unit runs `cloudflared tunnel run --no-autoupdate`. That form does not
parse. `--no-autoupdate` is registered in `configureCloudflaredFlags` (`cmd.go:903`, flag at
`cmd.go:923-929`), which is reached via `tunnelFlags` (`cmd.go:655-658`) and attached to the
**`tunnel`** command (`cmd.go:188-222`, `Flags: tunnelFlags(false)`). It is *not* in
`buildRunCommand`'s flag list (`subcommands.go:714-726`), and urfave/cli v2 rejects an unknown
flag after the subcommand name. A unit built from the literal wording would fail to start.

Upstream agrees on placement: its own generated unit is
`ExecStart={{ .Path }} --no-autoupdate ... tunnel run ...` (`cmd/cloudflared/linux_service.go:84`,
`:417`) — the flag precedes `tunnel`.

So: **`/usr/bin/cloudflared --no-autoupdate tunnel run`**. (`NO_AUTOUPDATE=true` in the
environment is equivalent — `cmd.go:923-929` — but the flag is clearer in the unit.)

**On `TUNNEL_TOKEN_FILE`:** `2026.11.2` also supports `--token-file` / `TUNNEL_TOKEN_FILE`
(`subcommands.go:132-137`, read at `subcommands.go:771-779`), which would keep the credential out
of the process environment entirely. Requirement 5 specifies `TUNNEL_TOKEN` in an
`EnvironmentFile`, and that is what this contract uses — it satisfies the threat model
(nothing in `ExecStart`, nothing in `/proc/<pid>/cmdline`) and it is the variant cloudflared
actively redacts in its own logs, whereas `TUNNEL_TOKEN_FILE` is not in `secretEnvFlags` (only
the *path* would be logged, which is harmless). Recorded here as a known, tighter alternative
for Security to weigh in review; it is a one-line change if they prefer it, and it does not
change the storage contract below (same file, same mode, same owner).

---

## 3. The unit — `pitchtribe-tunnel.service`, honouring the parent's three constraints

Not `cloudflared.service`: PIT-230's image assertion requires that name to be absent on a
flashed card (`image/build.sh:233-237`), which is what proves upstream's `service install` was
never run. Two names, two assertions, neither weakened. PIT-230 extends its assertion block to
cover ours with its own expected state: **present, not enabled, EnvironmentFile absent.**

```ini
[Unit]
Description=PitchTribe remote access (Cloudflare Tunnel)
# Inert on an unprovisioned card: even an explicit `systemctl start` is a no-op
# rather than a crash loop with a confusing journal.
ConditionPathExists=/etc/pitchtribe/tunnel.env
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/pitchtribe/tunnel.env
ExecStart=/usr/bin/cloudflared --no-autoupdate --metrics 127.0.0.1:20241 tunnel run
# Load-bearing, not boilerplate: a token is accepted before the Pi has Wi-Fi
# (requirement 2), so the connector's own retry is what establishes the link later.
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Three notes on that:

- **`--metrics 127.0.0.1:20241` is deliberate, and brings a hazard with it.** cloudflared starts
  an unauthenticated loopback HTTP server whether or not we ask: with the flag absent it binds
  `localhost:20241`, then `:20242`…`:20245`, then a random port
  (`metrics/metrics.go:150-168`). That server carries `/debug/pprof/` including `heap`
  (`metrics/metrics.go:113-124`). On a card with a kiosk UID and other local identities by
  design, a heap profile is a plausible route to a credential in process memory. Pinning the
  port makes it deterministic so one rule can cover it: mirror the existing kiosk rule in
  `deploy/setup/wifi-http-firewall.sh` with `tcp dport 20241 meta skuid != 0 reject`, so only
  root — i.e. the broker doing the health check — can reach it. Flag for Security.
- **Version self-check instead of a version assumption.** Because cloudflared is unpinned, the
  provision action verifies the binary accepts the environment route before it writes anything:
  `cloudflared tunnel run --help` must list `--token`. If it does not, refuse, write nothing,
  and tell the club remote access is unavailable on this card. No command-line fallback.
- **A revoked token cannot take down the LAN dashboard or the player.** It is a separate unit
  with no dependency on `pitchtribe.service`, and `Restart=always` only reacts to the connector
  process dying. See §5: cloudflared retries an `Unauthorized` registration internally rather
  than exiting, so there is no restart storm either.

---

## 4. The storage contract (this is the interface PIT-236 targets)

| | |
| --- | --- |
| Credential path | `/etc/pitchtribe/tunnel.env` |
| Contents | exactly one line, `TUNNEL_TOKEN=<connector token>` |
| Mode / owner | `0600 cloudflared:cloudflared`, directory `0755 root:root` |
| Unit | `pitchtribe-tunnel.service` |
| Written by | the root broker (`deploy/setup/wifi-privileged.py`) only — never a web process, never the dashboard directly |
| Provision (enable) | write credential atomically → `systemctl enable --now pitchtribe-tunnel.service` |
| De-provision (disable) | `systemctl disable --now pitchtribe-tunnel.service` → remove the credential file. In that order: the unit must stop before the credential disappears, or `ConditionPathExists` makes the stop look like a condition failure |
| Re-provision (replace) | **atomic replace, never truncate-in-place** |
| Status (for both front doors) | `systemctl is-active`/`is-enabled` + `GET http://127.0.0.1:20241/ready` (§5) |

**Atomic replace, concretely.** `os.open(..., O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` — the pattern
already used for a secret at `wifi-privileged.py:85` — cannot overwrite by design, so a second
token is: create `tunnel.env.<random>` in the **same directory** with the same flags and mode,
write, `flush`, `fsync`, `os.replace` onto `tunnel.env`, then `systemctl restart`. Never
`O_TRUNC` the live `EnvironmentFile`: that leaves a window in which the connector can read a
partial credential. On any failure, unlink the temp file and leave the previous state untouched —
mirroring the rollback discipline at `wifi-privileged.py:93-99`.

Both front doors — the commissioning page (PIT-231) and dashboard Settings → Remote access
(PIT-236) — call the **same broker action** with the same validation. PIT-236 builds no second
scheme and writes no file of its own. When this contract lands in
`deploy/setup/COMMISSIONING.md` (requirement 10), that document is authoritative and this one
becomes the evidence behind it.

---

## 5. Health, and telling the three honest outcomes apart (requirement 6)

`systemctl start` returning 0 proves nothing. There are two machine-readable signals, and
between them they separate the outcomes requirement 6 has to distinguish:

- **`GET http://127.0.0.1:20241/ready`** — `200` with `{"status":200,"readyConnections":N,
  "connectorId":"…"}` once at least one edge connection is active, `503` with
  `readyConnections:0` otherwise (`metrics/readiness.go:37-60`). No token in that body. This is
  the registration check; a bounded poll of it replaces counting journal lines.
- **`journalctl -u pitchtribe-tunnel`** (root-only) — a revoked or wrong token produces an
  `Unauthorized` registration error, and `supervisor/supervisor.go:328-333` treats
  `Unauthorized` as **retryable**: the connector keeps looping instead of exiting.

So:

| Observation | What the page says |
| --- | --- |
| `/ready` 200 within the wait | remote access is on |
| `/ready` 503 + no network yet | "saved — it will connect when the venue network is up" |
| `/ready` 503 + `Unauthorized` in the journal | "this token is no longer valid — ask PitchTribe for a new one" |

The third row is why a bare "failed" is not good enough, and why the credential is *kept* in the
second row but offered for re-entry in the third. A revoked token never exits the process, so
there is no crash loop and nothing for the player or the LAN dashboard to notice.

---

## 6. The validator, with the token's actual shape measured

`ParseToken` (`subcommands.go:801-812`) is `base64.StdEncoding.DecodeString` →
`json.Unmarshal` into `connection.TunnelToken` (`connection/connection.go:81-86`):

```go
AccountTag   string    `json:"a"`
TunnelSecret []byte    `json:"s"`
TunnelID     uuid.UUID `json:"t"`
Endpoint     string    `json:"e,omitempty"`
```

So requirement 3's decode check is exactly right, and the field names are **`a` / `t` / `s`**
(plus optional `e`), not the capitalised names in a credentials JSON file. `t` must parse as a
UUID and `s` as base64 — both are enforced by cloudflared and should be enforced at our boundary
too, so a wrong paste fails on the page rather than in the connector.

**Charset — `StdEncoding`, and base64url is nonetheless safe here.** cloudflared uses standard
base64 (`+`/`/`), not base64url, so requirement 3's "base64url plus `=`" wording looked like it
could reject valid tokens. It cannot, and the reason is structural rather than lucky: a `+` or
`/` requires a 6-bit group of value 62 or 63, which for all-ASCII input can only arise from the
final group of a 3-byte block when that third byte is `>`, `?`, `~` or DEL. None of those occur
in the token's JSON (hex, a UUID, base64, and `{}":,`). Measured: 2000 synthetic tokens of the
real shape, **0 containing `+` or `/`**. The validator can therefore accept the stricter
`[A-Za-z0-9]` plus trailing `=` padding, which also rejects a base64url-mangled (`-`/`_`) paste
with a club-readable message — something cloudflared would fail on anyway.

Also free, and worth enforcing: `len(token) % 4 == 0`. `StdEncoding` requires padding, so an
unpadded string fails in cloudflared; better to catch it on the page.

Keep the `eyJ` prefix check as the cheap first gate (the precedent is
`deliverables/pit-227/pi-connector-install.sh:40-43`): base64 of a JSON object beginning `{"`
always starts `eyJ`. A `cert.pem` (`-----BEGIN`), an API token, or an account-wide credential
all fail it immediately and get told what was expected.

**Sizes, measured — and a correction to my own earlier note.** Synthetic tokens of the real
shape (16-byte account tag hex, UUID, 32- or 64-byte secret, with and without `e`):

| | token | `{"token":"…"}` web body | broker frame + `\n` |
| --- | --- | --- | --- |
| 32-byte secret | 180–192 | 192–204 | 221–233 |
| 64-byte secret | 240–252 | 252–264 | 281–293 |

- Web route: `0 < Content-Length <= 1024`. Roughly 4× the 264-byte worst case, justified by the
  table, and `/connect`'s 512 is left exactly as it is.
- Broker: **the existing `readline(1025)` / `> 1024` cap at `wifi-privileged.py:104-106` needs no
  change.** My carry-over note on this issue said that cap "will reject a connector token" and
  should be raised; that was wrong, and the measurement above is why — the worst framed case is
  ~293 bytes, about 3.5× inside the cap. Nothing to raise, and nothing that would silently
  truncate a credential. The standing rule holds regardless: never truncate a credential; reject
  it.

**Keep the JSON POST style for the new route.** The page already posts
`Content-Type: application/json` with `JSON.stringify` (`wifi-startup.py:54`). That is worth
preserving deliberately and not just by habit: in a `form-urlencoded` body a `+` decodes to a
space, which would corrupt a credential in a way that reads to a volunteer like a typo. (Per the
charset analysis above a real token has no `+` — but the new route should not depend on that to
be correct.) The new route also keeps the existing response headers at `wifi-startup.py:69-71`
(`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`),
and the field is `type="password"`, `autocomplete="off"`, never pre-filled, never echoed back.

---

## 7. Requirement 9 — the authorization boundary, confirmed rather than assumed

`deploy/setup/wifi-http-firewall.sh` installs exactly one rule:

```
add rule inet pitchtribe_wifi_http output tcp dport 8090 meta skuid != $KIOSK_UID reject
```

It matches on `tcp dport` and `meta skuid` only. nftables has no notion of an HTTP path, so the
rule cannot distinguish `/connect` from a new route — **any** route added to the listener on
8090 inherits the same kiosk-UID-only restriction, with no action needed. Confirmed by reading
the rule, as requirement 9 asked. The new route still gets its own non-kiosk-denial step in
`deploy/setup/STARTUP-HTTP-AUTHORIZATION.md`, in that checklist's existing format.

The one genuinely new listener is cloudflared's metrics/pprof port — see §3. That one is *not*
covered by the existing rule and needs its own.

---

## 8. What is verified, and what still needs a Pi

**Verified here, from source and the apt index** (no device): the `TUNNEL_TOKEN` environment
route exists and is remotely-managed at `2026.11.2`; `--no-autoupdate` placement; upstream's own
redaction of `TUNNEL_TOKEN`; the token's decoded field shape and charset; realistic token and
framing sizes against both caps; the `/ready` contract; `Unauthorized` being retried rather than
fatal; the metrics/pprof listener's default binding; and that the port-8090 nftables rule is
path-agnostic.

**Not verifiable without hardware, and not claimed:** that `systemctl show -p Environment` does
not surface `EnvironmentFile` contents on the shipped systemd (expected, must be demonstrated —
it is one line of the requirement 7 evidence set); the actual journal of a successful provision
and of a revoked token on a card; `ConditionPathExists` making an explicit `systemctl start`
inert in practice; and the bounded-wait timing that makes the on-screen outcome honest on a real
venue network.

The requirement 7 evidence set is now a numbered bench step in
`deploy/setup/COMMISSIONING.md` ("Remote access token"), with the six greps written out as
runnable commands: after a successful provision, the token must produce no output from
`systemctl cat`, `systemctl show -p Environment`, `ps aux`, `/proc/<pid>/cmdline`,
`journalctl -u` for the connector **and both setup units**, and it must not appear in an HTTP
response body. A hit on any line fails the check and the credential path does not ship.

---

## 9. What landed

| File | Change |
| --- | --- |
| `deploy/setup/wifi-startup.py` | `validate_token`, the secondary **Remote access (optional)** section on `/`, the same section on an ungated `/remote`, `GET /remote-status`, `POST /remote-access`, `POST /remote-access/off`. `/connect` untouched, including its 512-byte cap |
| `deploy/setup/wifi-privileged.py` | `tunnel-status` / `tunnel-enable` / `tunnel-disable`, the same `validate_token` repeated at the privileged boundary, atomic replace, rollback to the previous credential, `/ready` health with a bounded wait, `Unauthorized` classification |
| `deploy/setup/pitchtribe-tunnel.service` | new unit, per §3 |
| `deploy/install.sh` | installs the unit and `/etc/pitchtribe`, leaves both disabled and empty |
| `deploy/setup/wifi-http-firewall.sh` | root-only reject rule for the readiness/pprof port |
| `image/build.sh` | asserts the unit is present, not enabled, with no credential; the content sweep now also catches a baked `TUNNEL_TOKEN=ey…` |
| `app/test/tunnel-token.test.js` | 19 cases through both copies of the validator, and a drift check between them |
| `app/test/remote-access-route.test.js` | the routes over real HTTP against a stubbed broker, including the no-echo evidence |
| `deploy/setup/COMMISSIONING.md` | where the code comes from, that it is optional and re-enterable, how to turn it off, the storage contract table, and the bench steps |
| `deploy/setup/STARTUP-HTTP-AUTHORIZATION.md` | non-kiosk denial for the new routes, and the root-only readiness port |
