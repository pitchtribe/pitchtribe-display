# One-touch Pi bootstrap — `daniel` (PIT-223 / PIT-227)

Chosen path (board decision, 2026-11-25): **Daniel runs this once on the Pi; an agent takes over through the tunnel afterwards.** Pi login user: `daniel`. Pi: `pitchtribe.local` = `192.168.1.55`.

This card is the short path. Full detail, hazards and rollback: `deliverables/pit-227/PI-CLOUDFLARED-RUNBOOK.md` (sections A–G).

---

## 0. Get in over SSH

`Too many authentication failures` is the client offering more keys than the Pi's `MaxAuthTries` (6) accepts before it hangs up — it never reached a credential that would work. Force one credential:

Password login (simplest):

```
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password -l daniel 192.168.1.55
```

Or one specific key:

```
ssh -o IdentitiesOnly=yes -i ~/.ssh/<the-right-key> daniel@192.168.1.55
```

The `SSH may not work until a valid user has been set up` line is the stock Raspberry Pi OS pre-auth banner, not a verdict on the account.

---

## 1. Copy the connector token (do not paste it anywhere but the Pi)

Cloudflare dashboard → **Zero Trust → Networking → Tunnels → `pitchtribe-cpfa` → Install and run a connector**. Copy the long `eyJ...` string out of the shown command.

The token can attach a machine to the tunnel. Never put it in the Paperclip thread, a commit, a chat message or a screenshot. If it is exposed, rotate it (runbook B4).

## 2. Install the connector

```
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
sudo cloudflared service install <PASTE_TOKEN_HERE>
```

No local `config.yml` is created or wanted — this tunnel is remotely managed, so routing lives in Cloudflare.

## 3. Prove it is healthy and report the origin

```
cloudflared --version
sudo systemctl is-active cloudflared; sudo systemctl is-enabled cloudflared
sudo journalctl -u cloudflared -n 30 --no-pager | grep -c 'Registered tunnel connection'
sudo systemctl show -p Environment pitchtribe.service
sudo ss -tlnp | grep -E ':80|:443|:8080'
curl -ksS -o /dev/null -w '%{http_code}\n' https://localhost:443/healthz
```

Expected: `active` + `enabled`, about **4** registered connections, `HTTPS_PORT=443` in the environment, a `node` process listening on `:443`, and `200` from `/healthz`.

If `HTTPS_PORT` is not 443, or `/healthz` is not 200 — **stop and paste the output**. The route gets built against the port this Pi really uses; publishing `https://localhost:443` with nothing listening there returns 502 on every request.

Paste back (no token, ever):

```
cloudflared active/enabled:
registered connection count:
HTTPS_PORT:
listening on :443?  yes / no
/healthz:
```

---

## 4. Then it is hands-off

Once the connector is healthy I finish from here, no further trips to the Pi:

1. Publish the route `cpfa.pitchtribe.co.uk` → `https://localhost:443` with `noTLSVerify` and `access.required` (exact JSON in runbook F).
2. Create the proxied CNAME `cpfa` → `ca5e80f9-a318-4c73-a607-ceacad3a3fb3.cfargotunnel.com`.
3. Validate: one-time-PIN sign-in, public TLS chain, `/admin`, authenticated `/api/*`, SSE heartbeat, and a **denied-access test** from a signed-out session and a non-owner address.

**Agent takeover — verified feasible, not yet built.** The agent runner has outbound internet and `cloudflared 2026.11.2` runs there from a plain downloaded binary (no sudo), so `cloudflared access ssh` as a `ProxyCommand` works. It still needs an SSH route on the tunnel plus a scoped Access **service token**, which I will only create on your say-so — it is a credential that grants an agent a shell on the Pi. Say the word after step 3 and I will build and scope it.

For reference, this account already contains an unrelated, idle tunnel `pitchtribe-admin-box` (created 2026-11-09, `ssh://localhost:22` → `ssh.pitchtribe.media`, down, no connector). Not part of this work; left untouched.

**Nothing is published today:** no `cpfa` DNS record, no tunnel route, no inbound port, no change on the Pi.
