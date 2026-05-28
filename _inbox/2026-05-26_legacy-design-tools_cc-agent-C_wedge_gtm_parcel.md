# cc-agent-C — Property Brief wedge backend (GTM + parcel layers)

**Date:** 2026-05-26  
**Workstation:** `cente` / `P:\legacy-design-tools`  
**Orchestrator:** Nick merges after CI green.

---

## TRACK 1 — GTM observation layer (P0)

| Item | Value |
|------|--------|
| Branch | `cortex/gtm-observation-layer` |
| PR | https://github.com/empressaioemail-tech/legacy-design-tools/pull/130 |
| Commits | `c95c67a` GTM routes + schema; `ac093a1` test fixture `gtm_*` tables + GET consent param fix |

### Delivered
- Migration `lib/db/drizzle/0028_gtm_observation_layer.sql` (`gtm_consent`, `gtm_events`)
- Routes: `POST/GET /api/brokerage/v1/gtm/consent`, `POST /events`, `GET /digest`
- `recordGtmEvent` on `/brief` and `/research/chat` when `X-Hauska-Install-Id` present
- `lib/db` schema fixture updated for drift CI

### Local vitest (brokerageGtm + brokerageBrief)
**Blocked:** `DATABASE_URL` not set in agent shell (no `.env.local` on this workstation). CI Test job is the gate.

```powershell
# Operator / Nick — from repo root with Neon test URL:
$env:DATABASE_URL = '<neon-test-url>'
cd artifacts/api-server
pnpm vitest run src/__tests__/brokerageGtm.test.ts src/__tests__/brokerageBrief.test.ts
```

### Nick deploy (after merge)
1. Migrations `0026_brokerage_brief_runs.sql` + `0028_gtm_observation_layer.sql`
2. Deploy `cortex-api`; shift traffic to new revision
3. Reload extension **v0.4.3** at `P:\hauska-brief-extension`

---

## TRACK 2 — Parcel / site context layers (P0)

| Item | Value |
|------|--------|
| Branch | `cortex/brokerage-site-context` (stacks on GTM branch) |
| PR | https://github.com/empressaioemail-tech/legacy-design-tools/pull/131 |
| Commit | `e964fc8` `brokerageSiteContext.ts` + brief/LLM wiring + tests |

### Delivered
- `fetchBrokerageSiteContext` — FEMA NFHL + Regrid parcel/zoning via `@workspace/adapters` runner
- `POST /brief` response includes `siteContext.layers`
- Grok prompts (`generateReasoningSummary`, `generateResearchChat`) receive site-context summaries
- Tests: `brokerageSiteContext.test.ts` (mocked `runAdapters`); `brokerageBrief.test.ts` updated

### Acceptance (prod / staging)
`POST /api/brokerage/v1/brief` with Bastrop pilot address returns layers when **`REGRID_API_KEY`** is mounted on Cloud Run (code uses `REGRID_API_KEY`, not `REGRID_API_TOKEN`).

### Local vitest (no DB for site-context unit tests)
```powershell
cd artifacts/api-server
pnpm vitest run src/__tests__/brokerageSiteContext.test.ts
```

---

## Merge order for Nick
1. **#130** GTM observation layer → `main`
2. Rebase **#131** onto `main` if needed (or merge after #130 if GitHub allows stacked diff)
3. **#131** site context layers → `main`

## Out of scope (this mission)
Stripe, share cards, SkySlope.

## CI status
Awaiting GitHub Actions on #130 and #131 (agent cannot fetch CI logs per `AGENTS.md`).
