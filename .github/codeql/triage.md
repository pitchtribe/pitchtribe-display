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

So the Security tab shows **9 open alerts, and that is the intended steady
state** — not a backlog. The `Analyse JavaScript` check on `main` is green
regardless, because open alerts do not fail the check. Re-check the live set
against the table below with:

```sh
gh api "repos/pitchtribe/pitchtribe-display/code-scanning/alerts?state=open" \
  --jq '[.[].number] | sort'   # expect [1,2,7,9,10,12,22,34,35]
```

A number appearing that is *not* in that list is a new finding and wants
triage; it is not covered by this file.

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

## Left open deliberately (9)

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

## A note on suppression comments

`// codeql[rule-id]` and `// lgtm[rule-id]` comments do **not** suppress
anything on GitHub code scanning by default. They only take effect if the
uploaded SARIF carries a `suppressions[]` entry, which is produced by a
language's `AlertSuppression.ql` — and that query is not part of the
`security-extended` or `security-and-quality` suites. Adding such comments here
would look like a control while suppressing nothing. Use this file plus the
config instead.
