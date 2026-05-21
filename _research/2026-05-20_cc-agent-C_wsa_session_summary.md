---
title: cc-agent-C WS-A session summary (Cortex QA cutover-tail)
date: 2026-05-20
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: draft (planner relocates to doc_repo _sessions/ with canonical frontmatter)
dispatch: _dispatches/2026-05-20_cc-agent-C_cortex_qa_wsa_audit.md
related: [43_cortex_qa_backlog, 90_runbooks/legacy_design_tools_replit_to_cloud_run_cutover, 2026-05-20_cortex_qa_wsa_data_source_audit]
---

# WS-A session summary — cutover-tail data integrity

cc-agent-C, `legacy-design-tools`, re-verified against `origin/main` `d8f3bef`.
Covers QA-03, QA-04, QA-08 (site portion), QA-13.

> Revision note (2026-05-20). WS-A was first done against a local checkout 12
> commits behind `origin/main`. Re-verified against `origin/main`: the 13 files
> the audit rests on are byte-identical, so the per-surface findings,
> WSA.3, WSA.4, and WSA.5 all stand. The WSA.1 Headline was wrong and is
> corrected below and in the audit doc — `origin/main` carries an L-surface
> (PRs #44-46, #51) the stale checkout lacked.

## State per sub-task

| Sub-task | QA item | State |
|---|---|---|
| WSA.1 data-source audit | QA-13 | Done — audit doc written |
| WSA.2 Revit add-in repoint | QA-04 | Flagged — separate repo |
| WSA.3 IFC upload 500 | QA-04 | Filed — root cause named, log retrieval blocked |
| WSA.4 site context layers | QA-03, QA-08 | ugrc:dem fixed; rest attributed |
| WSA.5 Code Library warmup + jurisdictions | QA-13 | Flagged — architecture decision |

## WSA.1 — Data-source audit (DONE)

Full deliverable: `_research/2026-05-20_cortex_qa_wsa_data_source_audit.md`,
with per-surface file/line refs, a data-flow table, and an ASCII plus Mermaid
diagram of the Cortex side. Hands off to the planner for QA-05.

Headline (corrected against `origin/main`): the MCP integration is
one-directional and inbound. cortex-api exposes an L-surface (L1-L6 routes,
PRs #44-46/#51) guarded by a `SERVICE_API_KEY` bearer-auth middleware
(`middlewares/serviceAuth.ts`); the Hauska MCP Server calls those routes. But
cortex-api makes no outbound call to the MCP server or hauska-engine — no MCP
client, no `HAUSKA_BACKEND_URL` consumer. For the four QA surfaces (Code
Library, site-context, chat, Revit/IFC), cortex-api is self-contained:
cortex-prod Neon, external public APIs, the Anthropic API, GCS object storage.
None of the four touches the MCP server or the substrate.

QA-13 settled: the Code Library reads cortex-prod-local tables (`code_atoms`,
`code_atom_sources`, `code_atom_fetch_queue`) directly through `@workspace/db`.
It does not read the MCP server. There is no product tier and no `X-Hauska-Key`
involved. Backlog Finding 2's first hypothesis (a cortex-prod-local table that
never received the substrate ingest) is correct; the MCP-server hypothesis is
refuted.

Elgin and Bastrop County are not reachable by the Cortex app: neither is in the
`JURISDICTIONS` registry (`lib/codes/src/jurisdictions.ts:37` holds only
`grand_county_ut` and `bastrop_tx`, where `bastrop_tx` is the City of Bastrop),
there are no Cortex-side ingest sources for them, and the Sync 4.5 atoms for
both live in the Hauska substrate corpus, a separate system the Cortex app does
not consume.

## WSA.2 — Revit add-in endpoint repoint (FLAGGED — separate repo)

The add-in is the separate C# repo `legacy-revit-sensor` (confirmed via
`41_revit_connector.md`). No code in `legacy-design-tools` configures the
add-in's backend URL; a content search finds `prompt-agent-accelerator.replit.app`
only in docs, never in `artifacts/` or `lib/` source. The api-server does not
construct or return the "Snapshot sent" workbench link.

Per `41_revit_connector.md`, the add-in's backend URL is the per-workstation
setting `settings.ReplitUrl` in `%APPDATA%\Hauska\DesignTools\settings.json`,
read by `EngagementMatchClient.cs`, `SnapshotClient.cs`, `SheetUploadClient.cs`,
and `IfcUploadClient.cs`, and editable through the add-in's `Configure` command
dialog.

Two-part fix, both outside this repo:

1. Immediate, operator action, no code change. Open the add-in's `Configure`
   dialog and set the backend URL to the cortex-api Cloud Run URL,
   `https://cortex-api-tds7av26va-uc.a.run.app` (or `https://cortex.empressa.io`
   once the domain mapping lands). Until this is done every add-in push lands on
   Replit-side Neon — this is the time-sensitive data-scatter item.

2. `legacy-revit-sensor` code change, flagged to the planner. Rename the
   `ReplitUrl` setting to a neutral name (`BackendUrl` / `CortexUrl`), update its
   default value, and fix the hardcoded workbench link
   `https://prompt-agent-accelerator.replit.app` in the `SendSnapshotCommand`
   "Snapshot sent" dialog.

## WSA.3 — IFC upload HTTP 500 (FILED — root cause named, logs unreachable)

`POST /api/snapshots/:id/ifc` runs `ingestSnapshotIfc` (`lib/ifcIngest.ts:237`).
It has exactly three HTTP 500 branches:

- `storage_error` — `ifcIngest.ts:264`, the GCS object-storage upload of the raw
  `.ifc` blob fails.
- `db_error` — `ifcIngest.ts:322`, the `snapshot_ifc_files` upsert fails.
- `atom_insert_failed` — `ifcIngest.ts:501`, the `materializable_elements`
  transaction fails.

A web-ifc parse failure returns 422, not 500, so the QA-reported 500 is not a
parse bug.

Strongest hypothesis: `storage_error`. Evidence:

1. The QA observation "sheet upload succeeded, IFC failed" does not exonerate
   object storage. Sheet upload stores PNGs as `thumbnailPng`/`fullPng` bytea
   columns in cortex-prod and never touches object storage. The IFC path is the
   only one of the four add-in endpoints that writes to GCS.
2. The cutover repointed object storage from the Replit localhost sidecar to
   Cloud Run ADC against a fresh, empty `legacy-design-tools-prod-objects`
   bucket (runbook Stage 9).
3. Runbook Stage 4 Probe 4 specified an object read; an empty bucket has nothing
   to read, and Stage 9 records that only Stages 0-3 ran. The object-storage
   write path was never verified post-cutover.

Two `storage_error` sub-causes to check, in order:

- `PRIVATE_OBJECT_DIR` env var not set on the cortex-api service.
  `getPrivateObjectDir()` throws when it is missing (`objectStorage.ts:83`), and
  that throw is caught into the `storage_error` 500.
- The cortex-api runtime service account lacks `storage.objects.create` (and
  `storage.objects.delete`, used for the re-ingest cleanup) on the
  `legacy-design-tools-prod-objects` bucket.

Log retrieval blocked. The dispatch directs diagnosis from Cloud Run logs. I
could not retrieve them: the workstation `gcloud` cannot refresh its auth token.
Verbatim:

```
ERROR: (gcloud.logging.read) There was a problem refreshing your current auth
tokens: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max
retries exceeded with url: /token (Caused by SSLError(SSLCertVerificationError(1,
'[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get
local issuer certificate (_ssl.c:1077)')))
```

The active account is correct (`empressaioemail@gmail.com`, verified via
`gcloud auth list`). The blocker is the workstation's gcloud TLS trust store,
not project access. Operator command to confirm the root cause:

```
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="cortex-api"
   AND severity>=ERROR
   AND (jsonPayload.msg=~"ifc ingest" OR textPayload=~"ifc")' \
  --project=legacy-design-tools-prod --freshness=10d --limit=40
```

Look for `ifc ingest: storage upload failed` (confirms `storage_error`),
`ifc ingest: db upsert failed`, or `ifc ingest: atom insert failed`. If
`storage_error`, the `err` field will name either the `PRIVATE_OBJECT_DIR`
config throw or a GCS 403.

Per the runbook, a still-failing Probe 6 does not block the cutover; the import
path was already broken pre-cutover. If the operator confirms `storage_error`,
the fix is an env-var or IAM correction on the deployed service, outside repo
scope. If the logs instead show `db_error` or `atom_insert_failed`, that points
back into the repo and warrants a follow-up dispatch.

## WSA.4 — Site context layer failures (ugrc:dem FIXED; rest attributed)

### ugrc:dem ArcGIS 400 — FIXED (uncommitted)

Root cause confirmed: `UGRC_ENDPOINTS.dem` pointed at a `Utah_Elevation_Contours`
FeatureServer that does not exist on the UGRC ArcGIS org. A direct request to
that service returns `{"error":{"code":400,"message":"Invalid URL"}}`, which is
exactly the QA-reported "ArcGIS error 400 invalid URL".

Fix: repointed `dem` to `ContoursGeneralized200Ft/FeatureServer/0`, the
published statewide generalized elevation-contour product on the same UGRC org.
Verified by a live point-in-polygon query at the Moab pilot coordinate
(38.5733, -109.5498): returns 1 feature, `ContourElevation: 4200`,
`ElevationRange: "4,000 - 4,200"`. The layer is polygon bands, so a parcel point
reliably intersects exactly one band — a better fit for the adapter's point
query than the original (non-existent) layer would have been.

Change: `lib/adapters/src/state/utah.ts`, the `dem` URL string plus three
comment blocks corrected for accuracy (the old comments described a "5m DEM";
the real product is generalized 200ft contours from a 30m DEM). No test asserts
the URL — `moabAndLemhiAdapters.test.ts` injects a fetch mock and the `ugrc:dem`
call falls through to a generic ArcGIS fixture. The change is string- and
comment-only, so it carries no typecheck surface.

### The "cancelled by the caller" failures — external, not in-repo bugs

EPA EJScreen ("fetch failed after 3 attempts"), FCC broadband ("cancelled by
caller during attempt 1"), grand-county-ut:parcels and :zoning ("cancelled by
caller during attempt 2"): these are external-API connectivity failures.

"Cancelled by the caller" is not an FE unmount aborting a fetch. The
generate-layers route passes no caller `signal` to the adapter context
(`generateLayers.ts:443`). The only abort source is the runner's own 15s
per-adapter `AbortController` (`runner.ts:36`). The message originates in
`fetchWithRetry` when that timer fires (`retry.ts:131`). So every "cancelled by
the caller" outcome is a 15s server-side runner timeout. "Attempt 2" means
attempt 1 failed transiently and was retried before the timer fired.

EPA's "fetch failed after 3 attempts" is a connection-level network error
exhausting all three retries. These are consistent with the QA report's own
"varies by run" — intermittent external connectivity, not a code defect.

Possible in-repo mitigation, not applied: raise the per-adapter timeout for the
slow upstreams (the Grand County roads adapter already overrides to 60s for the
same reason). I did not change it — a timeout bump should be driven by Cloud Run
latency evidence, which I could not retrieve. Recommend the planner decide after
the operator pulls adapter latency from logs.

### Map view fails to load / site 3D blank

Map view: `SiteMap` (`lib/site-context/src/client/SiteMap.tsx`) renders only
when the engagement has a geocode; without one it shows an "Add an address"
placeholder (`EngagementDetail.tsx:2929`). With a geocode, tiles come from the
public OSM tile server. "Fails to load on some engagements" is most likely
either no geocode (the placeholder, expected) or OSM tiles being blocked or
rate-limited (a Content-Security-Policy `img-src` restriction would do it).
Pinning it needs browser-console evidence from the QA pass.

Site 3D blank: `SiteContextViewer` (`lib/portal-ui/src/components/SiteContextViewer.tsx`)
renders site-context overlays (DXF/GLB briefing sources) plus an optional
building massing GLB. When all site adapters fail there are no `briefing_sources`,
and with no BIM model push there is no building GLB, so the scene is empty. The
blank 3D view is a downstream symptom of the adapter failures, not a regression
in the viewer. The viewer component is implemented and unit-tested.

QA-08's richer ask — the house model rendered on the site with surrounding
buildings and topo — is partially unfinished scope. The adapter set has no
terrain-mesh producer and no surrounding-buildings producer; that 3D scene is
W2-wave aspirational per `40_design_accelerator.md`. Not a regression.

## WSA.5 — Code Library warmup 403 + missing jurisdictions (FLAGGED)

### Warmup 403

Root cause: `POST /api/codes/warmup/:key` calls
`requireArchitectAudience` (`lib/audienceGuards.ts:29`), which 403s unless
`session.audience === "internal"`. In production, `sessionMiddleware`
(`middlewares/session.ts:238`) is fail-closed: it sets every request to the
anonymous `audience:"user"` and ignores the `pr_session` cookie and the
`x-audience` header. There is no production path to `internal`. The warmup and
embeddings-backfill routes are structurally unreachable on Cloud Run.

This is not an MCP-key problem and not a cutover regression — it is the current
auth-stub by design. The dispatch's WSA.5 hypothesis (wire an `X-Hauska-Key`)
does not apply; there is no MCP integration in this app.

Not fixed, deliberately. Two non-options and why:

- Loosening the guard so warmup accepts `audience:"user"` is wrong — warmup
  triggers ingestion load and must stay internal-only.
- Wiring a `SERVICE_API_KEY` bypass into `requireArchitectAudience` is a new
  auth surface. `SERVICE_API_KEY` exists in Secret Manager but has no consumer
  anywhere in this repo, and the session middleware's own header documents that
  a security review insisted on fail-closed production. An operator-auth path
  is an architecture decision for the planner, not a WS-A wiring fix.

### Missing Elgin and Bastrop County

Per WSA.1: neither is in the `JURISDICTIONS` registry, there are no Cortex-side
ingest sources for them, and their Sync 4.5 atoms live in the Hauska substrate
corpus the Cortex app does not consume. Restoring visibility is one of:

- Register the jurisdictions and their Municode / raw-PDF sources in
  `lib/codes`, add `code_atom_sources` rows, and run warmup — substantial work,
  and warmup is itself 403-blocked in production.
- Re-architect the Code Library to read the Hauska catalog (MCP server /
  hauska-engine). This is the Cortex MCP retrofit, a roadmap item, and exactly
  the QA-05 architecture question.

Either way it is an architecture decision. Flagged to the planner; not actioned.

## Repo changes this session

- `lib/adapters/src/state/utah.ts` — ugrc:dem endpoint fix (uncommitted).
- `_research/2026-05-20_cortex_qa_wsa_data_source_audit.md` — new (WSA.1 deliverable).
- `_research/2026-05-20_cc-agent-C_wsa_session_summary.md` — this file.

Commit note. I did not commit. The working tree carried two unrelated
modifications at session start that are not mine and must not be swept into a
WS-A commit: `artifacts/api-server/src/routes/findings.ts` and
`artifacts/api-server/src/__tests__/track-b-ifc-schema.test.ts`. The current
branch `docs/c2-3-4-5-research-drafts` is a docs branch; the `utah.ts` code fix
should land on its own branch. Recommend the operator or planner review the
verbatim `utah.ts` diff below and commit it on a dedicated branch, then run
`pnpm run typecheck` and the adapters test suite per the repo's pre-push gate.

```
diff --git a/lib/adapters/src/state/utah.ts b/lib/adapters/src/state/utah.ts
@@ -5,7 +5,8 @@
- *   - `ugrc:dem`            — the statewide 5m DEM layer (point sample).
+ *   - `ugrc:dem`            — statewide generalized 200ft elevation
+ *                             contour polygons (point-in-polygon sample).
@@ -28,7 +29,14 @@
 const UGRC_ENDPOINTS = {
-  dem: ".../Utah_Elevation_Contours/FeatureServer/0",
+  // ... QA-03 / WSA.4 fix comment ...
+  dem: ".../ContoursGeneralized200Ft/FeatureServer/0",
```

## Backlog status the planner should set

- QA-03: ugrc:dem fixed (pending commit); remaining layer failures attributed
  to external connectivity. Map/3D blank attributed downstream.
- QA-04: Revit add-in repoint flagged to the `legacy-revit-sensor` repo plus an
  immediate operator settings change. IFC 500 filed with a named root-cause
  hypothesis pending Cloud Run log confirmation.
- QA-08 (site portion): same as QA-03; the richer 3D ask is W2 scope.
- QA-13: settled. Code Library reads cortex-prod-local tables. Missing
  jurisdictions and the warmup 403 are architecture decisions, flagged.
