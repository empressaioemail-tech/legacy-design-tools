# QA-22 SCOPE A — CalEPA EJScreen mirror opt-in

**Date:** 2026-05-23
**Agent:** cc-agent-C
**Branch:** cortex/qa22-epa-dig (continuing from the dead-end-ledger commit; adds opt-in commits on top — one combined PR at the end)
**Decision record:** [doc_repo/_decisions/2026-05-23_epa_calepa_mirror_opt_in.md](../../doc_repo/_decisions/2026-05-23_epa_calepa_mirror_opt_in.md)
**Prior session:** [_research/2026-05-23_qa22_epa_path1a_cc-agent-C.md](2026-05-23_qa22_epa_path1a_cc-agent-C.md)

## What this dispatch landed

Re-enabled the `epa:ejscreen` adapter against the CalEPA-hosted
`EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb` Feature Server.
Three policy deltas (third-party host, state vs US percentiles, 2022→2023
demographic-index methodology shift) are explicitly surfaced in the
persisted provider attribution + payload fields + UI labels so a reader
cannot silently misread the data. EPA pill should flip from red to
green after operator merge + redeploy, with the state-percentile
disclosure visible in the briefing-source-row body and the dataset
vintage in the row footer.

## Files changed

### Adapter

- [lib/adapters/src/federal/epa-ejscreen.ts](../lib/adapters/src/federal/epa-ejscreen.ts) — full rewrite. New constants `EPA_EJSCREEN_FEATURESERVER` (CalEPA URL), `EPA_EJSCREEN_LABEL` ("EJScreen (CalEPA mirror)" for failure pills), `EPA_EJSCREEN_PROVIDER_LABEL` (the visible attribution string), `EPA_EJSCREEN_DATASET_VERSION` (frozen-snapshot vintage). `run()` rewritten to call `arcgisPointQuery` directly (no more bespoke broker-URL builder). Freshness threshold bumped 18 → 24 months. `timeoutMs` override removed (CalEPA mirror answers in ~300-600ms, well inside the runner default). Docstring keeps the dead-end ledger and adds the opt-in landing notes + reversal path the decision record prescribes.
- [lib/adapters/src/__fixtures__/federalFixtures.ts](../lib/adapters/src/__fixtures__/federalFixtures.ts) — `ejscreenBlockGroup` and `ejscreenEmpty` rebuilt around the ArcGIS Feature Server response shape (one feature per intersecting block-group polygon, attributes keyed by EJScreen 2023 field names). The recorded values mirror the live Moab UT recon (BG 490190002004) from the dead-end-ledger session note so the fixture and the on-ground data agree.

### Briefing UI surface

- [lib/adapters/src/federal/summaries.ts](../lib/adapters/src/federal/summaries.ts) — `summarizeEpaEjscreenPayload` reads `payload.percentileBasis` and renders the chip suffix as `state-pctile` when the basis is `"state"` (falls back to the bare `pctile` wording when the basis is missing or US-relative, so a future swap back to a US-percentile source needs no chip work). `FEDERAL_PAYLOAD_FIELDS["epa-ejscreen-blockgroup"]` labels updated to `"EJ Index (state %ile)"` + `"PM2.5 (state %ile)"` so the rerun-delta table discloses the basis the same way the inline chip does.
- [lib/portal-ui/src/components/BriefingSourceDetails.tsx](../lib/portal-ui/src/components/BriefingSourceDetails.tsx) — `EpaEjscreenSummary` reads `payload.percentileBasis` and renders KvRow labels as `"<indicator> state percentile"`. New dataset-vintage footer (italic, muted) renders `"Dataset: EJScreen 2023 (CalEPA mirror, published 2024-01-29)"` beneath the percentile rows when `payload.upstreamDatasetVersion` is set. The dataset footer is independent of the `snapshotDate` provenance footer above it (which measures cache age, not data publication time) — both must surface for the disclosure to be honest.

### Tests

- [lib/adapters/src/__tests__/federalAdapters.test.ts](../lib/adapters/src/__tests__/federalAdapters.test.ts) — EJScreen describe block rewritten end-to-end. **5 new test cases** beyond the dispatch's 4-case floor:
  1. Normalized indicator payload via the new ArcGIS shape (all 5 indicators + supplemental + block-group ID + state name)
  2. Targets the CalEPA FeatureServer URL with explicit negative assertion against the dead `ejscreen.epa.gov` host
  3. ArcGIS point-intersects query shape (geometryType, spatialRel, inSR, returnGeometry, outFields all present + geometry coords match parcel lat/lng)
  4. Empty features → no-coverage failed outcome
  5. ArcGIS error envelope → upstream-error
  6. Transient HTTP 503 retry
  7. State-percentile disclosure (`percentileBasis: "state"` on payload)
  8. Source attribution (provider names CalEPA mirror + EPA-retirement context; negative regression guard against bare `"EPA EJScreen"`)
  9. Dataset-version disclosure (`upstreamDatasetVersion` on payload includes the 2024-01-29 publish date)
  10. Freshness threshold pinned to 24 months
  Plus the QA-22 timeout-floor describe-block updated to assert EPA dropped the slow-upstream override (CalEPA mirror is fast).
- [lib/adapters/src/__tests__/federalSummaries.test.ts](../lib/adapters/src/__tests__/federalSummaries.test.ts) — `summarizeEpaEjscreenPayload` describe block reworked for the state-basis chip wording. New test asserts the chip falls back to bare `"pctile"` when `percentileBasis` is absent or `"us"` (forward-compat with a future EPA v2 swap-back). `diffFederalPayload` EJScreen test updated for the new `"EJ Index (state %ile)"` label.
- [lib/portal-ui/src/components/__tests__/BriefingSourceHistoryPanel.test.tsx](../lib/portal-ui/src/components/__tests__/BriefingSourceHistoryPanel.test.tsx) — Task #224 EJScreen rerun-reveal test updated for the new label + provider string + `percentileBasis: "state"` payload field.

### e2e fixtures (no test logic changes)

- [artifacts/design-tools/e2e/federal-layers-render.spec.ts](../artifacts/design-tools/e2e/federal-layers-render.spec.ts) — seeded EPA fixture's `provider` string updated to the CalEPA attribution; payload gains `percentileBasis: "state"` + `upstreamDatasetVersion`. `raw` field key renamed `RAW_D_POP` → `ACSTOTPOP` to match the new schema. `summaryAssertions` now looks for `"PM2.5 state percentile"` so the e2e confirms the state-pctile disclosure renders in the row body.
- [artifacts/design-tools/e2e/federal-summary-chips.spec.ts](../artifacts/design-tools/e2e/federal-summary-chips.spec.ts) — same `provider` + payload updates. `expectedChip` updated to `"EJ Index 65th state-pctile · PM2.5 72nd state-pctile"`.

## Design decisions

### Why `percentileBasis: "state"` lives on the payload (not on the row)

The chip + KvRow + diff label + markdown digest all need to know the basis. Putting it on the payload means every consumer reads it from the same place rather than a side-channel attribute, and the forward-compat path is clean: when the adapter swaps back to a US-percentile source, flip the value to `"us"` and every surface renders correctly without further code.

### Why the freshness threshold is 24 months (up from 18)

The original 18-month threshold assumed an annual EPA refresh cycle. The CalEPA mirror is intentionally a frozen 2023 snapshot republished 2024-01-29 with no published refresh cadence. Setting the threshold below the mirror's current staleness (~16 months) would cry wolf on every read; setting it too high masks a future case where CalEPA also goes dark. 24 months gives ~8 months of headroom past current staleness while still firing for engagements opened years apart. The docstring is transparent about the limitation: `snapshotDate` measures fetch time, not data vintage; the badge therefore measures cache age, not the underlying EJScreen 2023 freshness. A separate `getUpstreamFreshness` probe could measure CalEPA's refresh cycle directly (the FEMA NFHL adapter has one); that was not in this dispatch's deliverables and is left for a follow-up if/when CalEPA stops refreshing.

### Why the `timeoutMs` override was removed

The original adapter carried `SLOW_UPSTREAM_TIMEOUT_MS` (45s) because the EJScreen broker routinely answered slower than the 15s runner default. The CalEPA Feature Server answers in 0.3-0.6s per the operator-workstation recon recorded in the 2026-05-23 dispatch context — well inside the default. Keeping the wider budget would be safety theater; it would also mask a genuine CalEPA latency regression by allowing the request to hang for 45s before the row fails. Drop the override; if CalEPA starts misbehaving, add it back with evidence.

### Why source attribution uses em-dashes, not parens

The `generateLayers.ts` route packs the persisted provider as `${adapterKey} (${provider})`. Putting parens inside the provider label would yield `"epa:ejscreen (EJScreen 2023 (CalEPA mirror — EPA EJScreen API retired, awaiting v2))"` — visually noisy and confuses the existing `extractAdapterKeyFromProvider` helper that splits on the first `" ("`. Em-dashes keep the attribution readable without breaking the packing.

## Verification (pending — running locally on Win32 native-deps workaround)

- [ ] `pnpm install --force` (Win32 overrides lifted in `pnpm-workspace.yaml`)
- [ ] `pnpm run typecheck` workspace-wide green
- [ ] `pnpm --filter @workspace/adapters test` — focus on `federalAdapters.test.ts` + `federalSummaries.test.ts`
- [ ] `pnpm --filter @workspace/portal-ui test` — focus on `BriefingSourceHistoryPanel.test.tsx`
- [ ] Revert `pnpm-workspace.yaml` + `pnpm-lock.yaml` (native-deps workaround is local-only)
- [ ] Moab live query (recon endpoint already confirmed in prior session — adapter calls the same URL with the same query shape, so a separate live probe would just repeat the prior session's evidence)

## Bounded-overlap check

This dispatch touched:
- `lib/adapters/src/federal/epa-ejscreen.ts` + `__fixtures__/federalFixtures.ts` + `__tests__/federalAdapters.test.ts` + `__tests__/federalSummaries.test.ts` (adapter scope)
- `lib/adapters/src/federal/summaries.ts` (briefing UI summary chips/labels — federal-tier)
- `lib/portal-ui/src/components/BriefingSourceDetails.tsx` + `__tests__/BriefingSourceHistoryPanel.test.tsx` (briefing row UI)
- `artifacts/design-tools/e2e/federal-layers-render.spec.ts` + `federal-summary-chips.spec.ts` (e2e fixtures only)

Disjoint from:
- cc-agent-C2's Phase 2D.x PR3 in `legacy-design-tools-c2`: `lib/site-context/server/*` + `lib/atom-events/*` + `lib/db/*`
- cc-agent-R's 40e rendering parity: `artifacts/design-tools/.../renders/*` + `lib/renders/*`

No collision risk.

## Operator handoff

One combined PR on `cortex/qa22-epa-dig` covers both halves of SCOPE A:

1. **Dead-end ledger** (`b108ff7`) — docstring + session note documenting the 2026-05-23 sweep that found no EPA-published successor.
2. **CalEPA opt-in** (this commit) — adapter swap + UI disclosure + tests.

Expected post-merge:
- Operator runs CI (typecheck + adapter test + portal-ui test). All green.
- Operator redeploys (no Cloud Run migration / secret / config change required; the adapter just calls a different upstream).
- Redd retest: open any geocoded engagement nationwide; the EPA pill should flip from red to green. The row body shows population + the top three indicators each labeled `"<indicator> state percentile"`. The row footer shows `"as of <fetch-date> · source: epa:ejscreen (EJScreen 2023 — CalEPA mirror — EPA EJScreen API retired, awaiting v2)"`. Beneath the row body, a small italic `"Dataset: EJScreen 2023 (CalEPA mirror, published 2024-01-29)"` discloses the underlying data vintage.

If CalEPA takes the mirror down post-merge: pill goes red, the adapter's failure-pill message names the CalEPA host (`upstreamLabel` = "EJScreen (CalEPA mirror)") so the operator can identify the cause off the pill. Reversal path is the decision record's reversal criteria #1 (file a fresh SCOPE A recon).
