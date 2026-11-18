# CodeQL triage — standing decisions

Why the exclusions in `codeql-config.yml` are there, and which alerts are
deliberately left open in the Security tab.

Baseline: the first full-tree analysis of `main` (2026-11-10) reported **37**
open alerts — 30 high, 7 medium. None was exploitable. Tracked in PIT-41.

| Disposition | Count |
|---|---|
| Fixed in code ([#30](https://github.com/pitchtribe/pitchtribe-display/pull/30)) | 2 |
| Suppressed by `paths-ignore` | 13 |
| Suppressed by `query-filters` | 13 |
| Left **open** in the Security tab, assessed here | 9 |

One further alert has been assessed and left open since that baseline — **#41**,
added by [#52](https://github.com/pitchtribe/pitchtribe-display/pull/52) — so
the Security tab now shows **10 open alerts, and that is the intended steady
state** — not a backlog. The `Analyse JavaScript` check on `main` is green
regardless, because open alerts do not fail the check. Re-check the live set
against the table below with:

```sh
gh api "repos/pitchtribe/pitchtribe-display/code-scanning/alerts?state=open" \
  --jq '[.[].number] | sort'   # expect [1,2,7,9,10,12,22,34,35,41]
```

A number appearing that is *not* in that list is a new finding and wants
triage; it is not covered by this file.

### On a pull request, a deliberate finding still shows red

Worth knowing before you try to "fix" it. Open alerts do not fail
`Analyse JavaScript`, but a *newly introduced* one does fail the separate
`CodeQL` check that code scanning posts on a pull request — the one with no
workflow name beside it. #41 is why #52 merged with that check red while
`Analyse JavaScript` was green.

There is no way to make it green and keep the rule: dismissal needs
`security_events: write`, which this installation does not hold (verified again
on 2026-11-18 — `PATCH /code-scanning/alerts/41` returns 403 `Resource not
accessible by integration`), `query-filters` would switch the rule off repo-wide,
and suppression comments do nothing here (see the note at the foot of this file).
So the check stays red on the PR that introduces the finding, deliberately, and
goes green again on the next PR. `main` is unprotected, so this blocks nothing —
but if branch protection is ever turned on, do **not** add the `CodeQL` check as
required without first deciding what should happen to an assessed finding.

## Fixed in code

- **`js/file-system-race`** — `app/lib/backup-crypto.js`. `openEncrypted` sized
  the file with `statSync(from).size` and *then* `openSync(from)`. A swap in
  between read the GCM tag at the wrong offset, so a good backup was reported
  as damaged. Now `fstat`s the descriptor it is about to read.
- **`js/regex/missing-regexp-anchor`** — `app/bin/remote-access.js`. `people()`
  filtered shells with `/nologin|false$/`. Alternation binds looser than `$`,
  so this is `(nologin)|(false$)` and `nologin` matched *anywhere* in the path:
  a real login account with a shell under `/opt/nologin-helper/` silently
  dropped out of the list of accounts support access may be started as. Fixed
  with `/(?:nologin|false)$/`, with a regression test that fails on the old
  regex. This was the one genuine bug in the set.

## Left open deliberately (10)

These are single-location false positives or accepted risks under rules that
stay **on**, so they keep guarding code nobody has written yet. A
`query-filters` entry can only switch a rule off repo-wide, which would trade
real coverage for a tidier list — so do not add these to `query-filters`.

**These alerts are deliberately left open rather than dismissed.** The repo
owner decided this on 2026-11-11 (PIT-41): a per-alert dismissal needs
`security_events: write`, which the Paperclip app installation does not hold,
and the reasoning below was judged a better record than nine clicks. **This
file is the dismissal record.** If you later dismiss them in the UI, the
"Assessment" column is the reason to select, and the counts above become stale.

| # | Rule | Location | Assessment | Reason |
|---|---|---|---|---|
| [2](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/2) | `js/biased-cryptographic-random` | `app/lib/backup-crypto.js` | False positive | `ALPHABET` is 32 unique Crockford base32 characters and `256 % 32 === 0`, so `b % 32` is uniform. Verified by evaluating the constant, not by trusting the comment. |
| [12](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/12) | `js/reflected-xss` | `app/lib/app.js` | False positive | `themeCss()` tests `accent` against `/^#[0-9a-f]{6}$/i` and falls back to the default, so nothing user-supplied reaches the CSS. CodeQL does not track the sanitiser across the function boundary. |
| [34](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/34) | `js/remote-property-injection` | `app/lib/auth.js` | False positive | `parseCookies` assigns only strings, so `out['__proto__'] = str` is swallowed by the setter. Verified: no own property created, prototype unpolluted, `pt_session` lookup unaffected. |
| [35](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/35) | `js/log-injection` | `signage-server/src/http.js` | False positive | `route` is built from `url.pathname`, which keeps `%0A` percent-encoded. No literal newline reaches the log, so entries cannot be forged. |
| [22](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/22) | `js/client-side-request-forgery` | `app/public/admin/admin.js` | False positive | Same-origin relative `fetch('/api' + url)`; `url` comes from app code, not page input. The custom `x-pitchtribe` header also forces a preflight. |
| [1](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/1) | `js/polynomial-redos` | `signage-server/src/sources.js` | Won't fix | Input is `trainsCfg.url`, the operator's Huxley base URL from the local config file — not fetched feed content. Reduces to an operator slowing their own server with a pathological config. |
| [10](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/10) | `js/polynomial-redos` | `signage-server/src/config.js` | Won't fix | Input is `publicUrl` from env / local config. Operator-supplied; no untrusted source drives the backtracking. |
| [7](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/7) | `js/file-system-race` | `app/lib/portal.js` | Won't fix | `statSync`/`readFileSync` of the portal's own `settings.json`, written by the dashboard. Worst case is a stale cache entry or a caught-and-logged parse error. Not guest-reachable. |
| [9](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/9) | `js/http-to-file-access` | `app/lib/portal.js` | Won't fix | Guest email is regex-validated (no quotes, angle brackets or whitespace), capped at 200 chars, `JSON.stringify`-escaped so it cannot inject a JSONL line, and rate-limited to 10/min/IP. The CSV export already neutralises spreadsheet formulas. |
| [41](https://github.com/pitchtribe/pitchtribe-display/security/code-scanning/41) | `js/disabling-certificate-validation` | `scripts/health-probe.mjs:135` | False positive | Verification is **replaced, not removed**. The card's certificate is self-signed, so there is no authority to validate a chain against — chain checking cannot succeed and its failure would carry no information. The probe instead pins `fingerprint256` and rejects on mismatch, which is the stronger check: it also detects a **reimaged or swapped card**, because a new card generates a new key. Reviewed and approved by Security on PIT-56. |

### #41 in full: what is actually accepted, and what must stay true

Two caveats behind that one-line assessment, because "we pin the fingerprint" is
not by itself enough to make `rejectUnauthorized = false` safe.

**The pin is checked after the handshake, not during it.** Node hands the
response to the callback once the request line and headers are already on the
wire, so by the time `getPeerCertificate()` is compared, something presenting a
bogus certificate has already received the request. That is accepted only
because the probe is a **credential-free `GET` of an open route**: its headers
are `accept` and `user-agent`, and it holds no cookie, token or password to
leak. The *response* is safe in the stronger sense — on mismatch the handler
`res.destroy()`s and rejects before a single `data` event is read, so no
attacker-supplied body is ever parsed or acted on.

This is the condition to protect. **If this probe ever grows a credential — an
`Authorization` header, a session cookie, a token for an authenticated
endpoint — the assessment above expires.** Pinning after the headers are sent
would then leak that credential to anyone who can answer on the address, and
the fix is to pin inside the handshake via a `secureContext` / `ca` with
`checkServerIdentity`, not to keep this pattern.

**The rule stays on repo-wide, on purpose.** A future
`rejectUnauthorized = false` with no pin after it is exactly what
`js/disabling-certificate-validation` should catch, and it would be a real
finding. That is why #41 is left open and assessed here rather than added to
`query-filters` — switching the rule off to tidy one line would discard the
coverage that makes the next one visible. The probe also **fails closed**: it
refuses to start over HTTPS without a fingerprint unless explicitly given
`--insecure`, so it cannot decay into a probe that trusts anything.

## A note on suppression comments

`// codeql[rule-id]` and `// lgtm[rule-id]` comments do **not** suppress
anything on GitHub code scanning by default. They only take effect if the
uploaded SARIF carries a `suppressions[]` entry, which is produced by a
language's `AlertSuppression.ql` — and that query is not part of the
`security-extended` or `security-and-quality` suites. Adding such comments here
would look like a control while suppressing nothing. Use this file plus the
config instead.
