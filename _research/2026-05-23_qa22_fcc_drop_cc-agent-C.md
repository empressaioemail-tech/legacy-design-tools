---
title: QA-22 SCOPE B closeout — drop FCC adapter (cc-agent-C)
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: durable HR-11 committed copy. Inbox drop at
  doc_repo/_inbox/2026-05-23_legacy-design-tools_cc-agent-C_qa22_fcc_drop.md
  (file-only, not committed to doc_repo).
dispatch: 2026-05-23_cc-agent-C_qa22_fcc_drop
related: [43_cortex_qa_backlog, 2026-05-23_qa22_fcc_recon_cc-agent-C]
---

# QA-22 SCOPE B closeout — drop FCC adapter

PR #96 confirmed `broadbandmap.fcc.gov` is Akamai-WAF-gated
(server RSTs at 19s or holds 60s with 0 bytes for any client UA,
from both Cloud Run and a workstation curl). PR #94's 90s
timeout + cache can't help — no successful response ever arrives.

Operator decision 2026-05-23: drop the FCC adapter.

| Item | PR | Branch |
|---|---|---|
| FCC adapter gated off by default | #102 | `cortex/qa22-fcc-drop` |

## Implementation (6 files, ~180 lines, half test updates)

- `registry.ts`: new `isFccEnabled(env = process.env)` (strict
  literal-`"true"` gate); `FEDERAL_ADAPTERS` spreads in FCC only
  when enabled.
- `fcc-broadband.ts`: top-of-file docstring on the gate + WAF
  root cause + re-enable mechanic + link to recon session.
- `SiteContextTab.tsx`: two hardcoded copy strings updated to
  name the three federal layers that actually fire (FEMA / USGS
  / EPA).
- `registry.test.ts` (NEW): 7 cases pinning gate semantics +
  default-off invariant + no-regression guards.
- `eligibility.test.ts`: 4 assertions updated (lists that
  hardcoded `"fcc:broadband"`).
- `pilotJurisdictions.test.ts`: `FEDERAL_PILOT_LAYER_KINDS` test
  renamed + updated to assert FEMA + USGS + EPA present AND
  `fcc-broadband-availability` NOT present.

## Out of scope (not touched)

- E2E specs (test render path via seeded fixtures, not registry).
- Generate-layers integration test (fake adapters, independent
  of real registry).
- `runner.ts` (no changes needed — gating happens upstream).
- FCC-specific unit tests in `federalAdapters.test.ts` (import
  the binding directly).

## How the pill goes silent without pill-rendering changes

Gate FCC out of `FEDERAL_ADAPTERS` → runner sees no FCC adapter
→ runner produces no FCC outcome → renderer renders no FCC pill.
`no-coverage` doesn't trigger either: that's emitted by the
runner when `appliesTo` returns false for an adapter THAT IS IN
THE LIST. With FCC not in the list, the runner never asks
`appliesTo`.

## Re-enabling

Set `FCC_ENABLED=true` on the Cloud Run service env. No code
redeploy. Operator should also re-add FCC clauses to the two
SiteContextTab copy strings (in-line comments document the
exact sites).

## Verification

- `pnpm --filter @workspace/adapters test` — 234/234 passing.
- `pnpm run typecheck` workspace-wide — 7 artifacts + scripts
  green.
- Branch off `origin/main` HEAD `4aa3d2a` in isolated worktree
  per workspace-hygiene memory.
- Win32 native-deps workaround applied for install + verify,
  then reverted.

## Acceptance (operator side)

- Force-refresh Redd Generate Layers post-deploy: FCC no longer
  in the failed-layer list (no pill at all).
- 4 of 5 federal+local layers ok (FEMA/USGS/EPA succeed; Grand
  County still fails per QA-22 SCOPE C until Regrid SCOPE B
  lands).
- 234+ existing adapter tests pass with the env-gated updates.

## Out of scope (held)

- Regrid SCOPE B (cc-agent-C2 territory).
- 2D-site-context (cc-agent-C2 territory).
- EPA EJScreen successor (operator-greenlit Path 1a dig pending
  separate dispatch).
- Grand County GIS (operator infra; deprecating-as-baseline via
  Regrid).
- Phase 3 features (deferred behind 2D-site-context).
