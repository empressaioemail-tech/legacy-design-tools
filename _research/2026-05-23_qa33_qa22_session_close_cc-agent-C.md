---
title: Cortex QA close-out — QA-33 + QA-22 reopen (cc-agent-C)
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: draft — HR-11 report. Drafted here per the standing cross-repo
  doc-writes guidance; a copy is dropped at `doc_repo/_inbox/` for the
  planner to relocate.
dispatch: 2026-05-23_cc-agent-C_qa33_qa22_cleanup_batch
related: [43_cortex_qa_backlog]
---

# Cortex QA close-out — cc-agent-C

Cleanup batch following the QA-32 deploy on cortex-api-00019-bxf. Two
scopes, two PRs, both **diagnostic-only**. Both teed for operator
merge — neither speculates on a fix until the diagnostic surface
they add returns the data needed to choose between the scope's
fix options. QA-34 was operator-tabled (Revit file didn't carry the
project address) and not touched.

| Item | PR | Branch | State |
|---|---|---|---|
| QA-33 — BIM viewport empty despite 101 elements | #87 | `fix/qa33-ifc-ingest-glb-diagnostics` | open for review |
| QA-22 reopen — 4 layers still failing post-PR #76 | #88 | `fix/qa22-adapter-response-body-excerpt` | open for review |

## SCOPE A — QA-33 (PR #87)

### Symptom

On the deployed cortex-api for Musgrave_Residence_B (engagement
`977b5469-4b26-4bd0-895e-71ec752b7409`), the BIM tab shows the
`101 ELEMENTS` badge correctly but the Three.js viewport area below
is empty.

### Diagnosis (cold reading of the code, no deployed-env access)

The viewer's
[`classifyElements`](lib/portal-ui/src/components/BimModelViewport.tsx#L316-L366)
walks the bim-model's elements and skips any with no
`geometry`/`briefingSourceId`/`glbObjectPath`. For an IFC ingest the
shape of the elements is:

- 101 per-entity `as-built-ifc` rows: **all three fields null** —
  every one of these is skipped.
- 1 synthetic `as-built-ifc-bundle` row: `glbObjectPath = gltfObjectPath`
  **iff** `parseResult.glbBytes.length > 0` at
  [`ifcIngest.ts:362-377`](artifacts/api-server/src/lib/ifcIngest.ts#L362-L377).

So "viewport empty" maps cleanly to one of three states the ingest
could have left behind, all of which surface as
`data-renderable-element-count = 0`:

- (a) parse produced zero glb bytes (every `buildMeshForGeometry`
  early-returned because web-ifc reported empty vertex/index arrays
  — typical for metadata-only IFCs or IFC4 with externally-stored
  geometry not loaded by the parser) → bundle row's
  `glb_object_path` is `null`;
- (b) parse produced glb bytes but the storage upload threw (already
  logged as `gltf upload failed`, but the success-path log doesn't
  carry the byte count, so an operator reading logs later can't
  distinguish this from (a));
- (c) bundle row has `glb_object_path` set and the viewer-side fetch
  is the problem (audience gate, ETag mismatch, route 404 against
  the bucket key).

The ingest success path logs only `entityCount` and the bim-model
event's chain hash. `parseResult.glbBytes.length` and the resulting
`gltfObjectPath` never reach logs. So an operator triaging an empty
viewport today has to either guess or open a bucket browser.

### Fix shape (PR #87)

Two log lines in
[`artifacts/api-server/src/lib/ifcIngest.ts`](artifacts/api-server/src/lib/ifcIngest.ts).
No behavior change, no schema change, no test impact:

- `ifc ingest: parser produced zero glb bytes — bundle row will have
  no GLB` (warn) on the `glbBytes.length === 0` branch.
- `ifc ingest: complete` (info) at the end of the success path,
  carrying `{snapshotId, ifcFileId, entityCount, glbBytesLen,
  gltfObjectPath, ifcVersion}`. (a)/(b)/(c) collapse to a single
  log-line read.

### Operator handoff

Merge → redeploy → re-upload the Musgrave IFC → tail `ifc ingest:`
log entries. Next session picks the real fix from the three-arm
diagnosis tree.

## SCOPE B — QA-22 reopen (PR #88)

### Symptom

On engagement Redd (`8e2bac10-7e28-445b-b396-553e769e3052`, Moab UT),
`epa:ejscreen`, `fcc:broadband`, `grand-county-ut:parcels`, and
`grand-county-ut:zoning` all fail after 3 retries even with the 45s
slow-upstream floor PR #76 widened.

### Diagnosis

**PR #76 isn't relevant to these four.** Verified by reading
`git show 7525ce2`: PR #76 only added `SLOW_UPSTREAM_TIMEOUT_MS` to
the *UGRC* adapters (`utah.ts`). The four affected adapters already
carried that floor since QA-22 (#63), and the constant bump from
30s → 45s only gave them MORE headroom for free. They were failing
before #76 and they're failing after — for a different reason than
the timeouts #76 fixed.

The current failure message (e.g.
[`arcgis.ts:122-125`](lib/adapters/src/arcgis.ts#L122-L125)) reads:

> Grand County, UT GIS responded with HTTP 503 after 3 attempts. Use
> Force refresh to retry.

**It never captures the response body.** So neither the on-screen
failure pill nor the request log distinguishes:

- schema drift — the upstream API returns an envelope like
  `{ error: { message: "Layer 0 not found" } }` → option 3 in the
  scope, fix the request shape;
- transient flakiness — 503 maintenance banner, empty body,
  Cloudflare interstitial → option 2 in the scope, cached-last-good
  fallback.

Operators have to reach Cloud Run logs for every triage round, and
the workstation `gcloud` token has been broken since QA-08
(`reference_gcloud_token_refresh_broken`), so the canonical
"tail the logs" path is currently unreachable. This PR closes that
gap.

### Fix shape (PR #88)

Diagnostic-add only:

- [`lib/adapters/src/retry.ts`](lib/adapters/src/retry.ts) — when the
  final attempt returns a non-OK response (transient-status
  exhaustion OR a hard 4xx single-attempt), `fetchWithRetry` reads
  up to 256 chars of the body and attaches it as `bodyExcerpt` on
  its result. The previous "drain and discard" branch on retry
  exhaustion is replaced with a real read — the socket is no longer
  needed since the request is over. Whitespace is collapsed so a
  pretty-printed HTML error page stays compact; body-empty /
  read-threw / transport-reset-mid-read all collapse to `undefined`
  so callers fall back to the bare wording they had before.
- [`arcgis.ts`](lib/adapters/src/arcgis.ts),
  [`federal/epa-ejscreen.ts`](lib/adapters/src/federal/epa-ejscreen.ts),
  [`federal/fcc-broadband.ts`](lib/adapters/src/federal/fcc-broadband.ts):
  when `bodyExcerpt` is populated, append ` Upstream response: …`
  to the existing failure message. These three call sites cover all
  four affected adapters (arcgisPointQuery serves both Grand County
  rows).
- [`__tests__/retry.test.ts`](lib/adapters/src/__tests__/retry.test.ts):
  six new cases pinning transient-status capture, hard-4xx capture,
  whitespace collapse, truncation with trailing ellipsis,
  empty-body absence, success-path absence, mid-read throw absence.

Typecheck clean. All 217 adapter tests pass (211 existing + 6 new).

### Operator handoff

Merge → redeploy → re-run Redd's Generate Layers → read the four
failed-layer pills:

- JSON envelope with `error.message` → schema drift → next session
  fixes request shape.
- HTML error page / maintenance banner / empty body / Cloudflare
  interstitial → transient flakiness → next session adds
  cached-last-good fallback in `runner.ts`.
- If a 2xx surfaces with a `parse-error` instead, completely
  different diagnosis tree (parser-side change in the upstream
  response shape).

## Held / not touched

- **QA-34** — operator-tabled. The Revit file did not carry the
  project address; not a bug. No code touched.
- **Phase 3 features (QA-27 / 28 / 29)** — deferred behind
  2D-site-context per operator call. Not touched.
- **2D-site-context sprint** — separate scope, separate dispatch.
  Not touched.

## Session hygiene

- Both branches cut from clean `main` (one branch each — no
  cross-scope coupling).
- Pre-push typecheck via `pnpm --filter @workspace/<pkg> run
  typecheck` per `feedback_typecheck_command`. Both green.
- SCOPE B tests run locally via `pnpm --filter @workspace/adapters
  test`. All 217 pass.
- SCOPE A test impact: none (logging-only). Relied on CI for full
  api-server suite — Windows test runs need the native-deps
  workaround (`project_windows_test_natives`) which I did not
  apply for a logging-only diff.
- No commits to `doc_repo`. This file dropped at
  `doc_repo/_inbox/2026-05-23_qa33_qa22_session_close.md` per
  `feedback_cross_repo_doc_writes` (HR-11).
