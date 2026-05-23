---
title: cc-agent-C QA-22 FCC recon — three-step report
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: durable HR-11 committed copy. Inbox drop at
  doc_repo/_inbox/2026-05-23_legacy-design-tools_cc-agent-C_qa22_fcc_recon.md
  (file-only, not committed to doc_repo).
dispatch: 2026-05-23_cc-agent-C_qa22_fcc_recon
related: [43_cortex_qa_backlog, 2026-05-23_cc-agent-C_qa22_upstream_probe]
---

# QA-22 SCOPE B follow-up — FCC three-step recon

PR #94 (90s timeout + 15-min in-mem cache) shipped on
cortex-api-00023-6l4, but operator reproduced on Redd: 3
force-refreshes, all failed with `did not respond in time during
attempt 1`. Three-step recon, no fix yet (held for operator
follow-up dispatch).

| Step | Status | Output |
|---|---|---|
| 1. Identify exact adapter URL | ✅ | `https://broadbandmap.fcc.gov/nbm/map/api/published/location/availability?lat=38.5733&lng=-109.5498` |
| 2. Add structured logging | ✅ | PR #96 |
| 3. Workstation curl | ✅ | Zero bytes in 3 attempts; not a slow upstream; pattern fits Akamai WAF / bot mitigation |

## STEP 1 — exact URL

Hardcoded in [`fcc-broadband.ts:27-28`](lib/adapters/src/federal/fcc-broadband.ts#L27-L28):

```
https://broadbandmap.fcc.gov/nbm/map/api/published/location/availability
```

For Redd lat/lng, query string adds `?lat=38.5733&lng=-109.5498`.
Headers: adapter UA + `Accept: application/json, */*;q=0.1`.

## STEP 2 — structured logging (PR #96)

Three JSON-line events:

- `fcc:broadband request start` (info) — url, lat, lng, timeout_ms
- `fcc:broadband request ok` (info) — http_status, attempts,
  duration_ms, response_size_bytes (Content-Length when set),
  provider_count
- `fcc:broadband request failed` (warn) — error_type
  (`network`/`status`/`parse`), http_status (when known),
  attempts, duration_ms, plus throw_excerpt (PR #92) or
  body_excerpt (PR #88) — whichever applies

Implementation: small `fccLogEvent(level, msg, fields)` helper
emitting `console.info` / `console.warn` with JSON-stringified
field bag. Adapters package stays IO-free (no logger dep);
Cloud Run parses JSON stdout as structured entries either way.

## STEP 3 — workstation curl

Three variants, same FCC endpoint:

| Variant | Result | Duration |
|---|---|---|
| Adapter UA + Accept | `curl 56` (RST), 0 bytes | 19.4s |
| Browser UA + Referer + Accept-Language | `curl 28` (timeout), 0 bytes | 60s |
| FCC homepage `/` HEAD with adapter UA | `curl 28` (timeout), 0 bytes | 30s |

All 3: DNS/TCP/TLS handshakes complete in <500ms (remote IP
`23.209.15.124` — Akamai edge). Hang is on `time_starttransfer`
— server never sends first byte.

### Interpretation

**Not a slow upstream.** A slow upstream would eventually
respond. This is the server **silently holding or RST-ing**
after a configurable interval — Akamai bot-mitigation signature:

- Default UA → RST at ~19s (automation pattern detected, tear
  down).
- Browser UA + Referer → hold-without-response for full timeout
  (waiting on JS challenge token client never produces).
- Homepage with default UA → same hold pattern (WAF gates the
  whole host, not just the API endpoint).

Reconciling with the dispatch's hypotheses:

| Hypothesis | Verdict |
|---|---|
| (a) FCC API takes >90s | ❌ Server actively RSTs at 19s |
| (b) Stale/wrong API URL | ✅ Most likely — endpoint rotated, OR Akamai WAF blocks our request shape |
| (c) FCC throttling Cloud Run IPs | ❌ My workstation gets same behavior |
| (d) Adapter failing fast, runner mis-reports as timeout | ❌ PR #92's throwExcerpt would have caught a real network throw |

## Recommended next dispatch

1. **Identify current FCC BDC v2 endpoint** — check FCC's
   published API docs at
   `https://broadbandmap.fcc.gov/data-download/nationwide-data`
   for an updated URL or API-key requirement.
2. **Or accept BDC v2 is no longer programmatically accessible**:
   - Switch to BDC bulk-download CSV path.
   - Drop FCC adapter entirely (perma-`no-coverage` row).
3. PR #94's 90s timeout + 15-min cache stay correct against
   whatever the new endpoint is.

## Held / not touched

- Any fix to fcc-broadband.ts beyond the recon logging — per
  dispatch "no fix yet, hold for the next dispatch."
- QA-33 / QA-35 (closed).
- QA-22 SCOPE A EPA (operator decision).
- QA-22 SCOPE C Grand County (operator infra).
- 2D-site-context (cc-agent-C2 territory).

## Verification

- Branch off `origin/main` HEAD = `79b5208` in isolated worktree
  `p:/tmp/qa22-fcc-recon` per the workspace-hygiene memory.
- 227/227 adapter tests pass. Workspace typecheck clean.
- Workspace YAML + lockfile reverted per
  `project_windows_test_natives` workaround.
