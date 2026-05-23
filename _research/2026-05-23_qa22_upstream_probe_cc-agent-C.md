---
title: cc-agent-C QA-22 upstream probe — three-scope close-out
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: durable HR-11 committed copy. Inbox drop at
  doc_repo/_inbox/2026-05-23_legacy-design-tools_cc-agent-C_qa22_upstream_probe.md
  (file-only, not committed to doc_repo).
dispatch: 2026-05-23_cc-agent-C_qa22_upstream_probe
related: [43_cortex_qa_backlog, 2026-05-23_cc-agent-C_qa22_throw_path]
---

# QA-22 upstream probe — cc-agent-C

Three scopes, one shipped PR (#94 — SCOPE B), two written
recommendations (SCOPE A + SCOPE C). PR #92's `throwExcerpt`
capture returned exactly the diagnostic surface each scope needed
to root-cause cleanly.

| Field | Content |
|-------|---------|
| **SCOPE A** | EPA — old URL `https://ejscreen.epa.gov/mapper/ejscreenRESTbroker3.aspx` (NXDOMAIN). **No new URL found.** WebFetch on geopub/gispub/EPA-EJScreen-pages/data.gov returned nothing usable. Per dispatch step 5, stopped at recommendation. |
| **SCOPE B** | FCC — timeout floor `SLOW_UPSTREAM_TIMEOUT_MS` (45s) → `FCC_BROADBAND_TIMEOUT_MS = 90_000` (90s) on `fcc:broadband` only; 15-min in-mem cache keyed by lat/lng rounded to 5 d.p. PR #94. |
| **SCOPE C** | Grand County — adapter uses `gis.grandcountyutah.net` (live host). Cloud Run `UND_ERR_CONNECT_TIMEOUT` is TCP-level → DNS resolved, firewall is what's blocking. **Operator infra**: VPC connector + Cloud NAT + whitelist outreach. |
| **Deploy** | Operator merge + redeploy required for SCOPE B to take effect. SCOPE A and SCOPE C land in subsequent dispatches. |

## SCOPE A — EPA EJScreen (no code change, recommendation only)

**Root cause**: `ejscreen.epa.gov` is NXDOMAIN — the entire hostname
appears decommissioned. PR #92's pill is exactly accurate:
`ENOTFOUND getaddrinfo ejscreen.epa.gov`.

**WebFetch sweep** (per dispatch step 3):

- `geopub.epa.gov/arcgis/rest/services/OECA` — only `msep_imagery`
- `gispub.epa.gov/arcgis/rest/services` — no EJScreen folder at root
- `www.epa.gov/ejscreen` — 404
- `www.epa.gov/ejscreen/learn-use-ejscreen` — 404
- `www.epa.gov/ejscreen/ejscreen-api` — 404
- `catalog.data.gov/dataset?q=ejscreen` — no EJScreen entries surfaced

Per dispatch step 5 ("If you cannot find an official replacement
API: stop at a written recommendation"), the adapter is left
untouched.

**Operator options**:

1. **Wait** for an EPA-published successor. No-op until announced.
2. **CDC EJI** (`atsdr.cdc.gov/placeandhealth/eji/`) — different
   geography (tract vs block group), different indicators,
   non-trivial rewrite.
3. **PEDP mirror** — explicitly gated on operator sign-off per
   dispatch.
4. **Remove** the EJScreen adapter — perma-`no-coverage` row.

Adapter pill stays informative thanks to PR #92.

## SCOPE B — FCC broadband (PR #94, code-side mitigation)

**Root cause**: BDC v2 endpoint
(`broadbandmap.fcc.gov/nbm/map/api/published/location/availability`)
is legitimately slow from Cloud Run egress. Operator workstation
curl confirmed reachability but timed out at 60s with 0 bytes; pill
on Cloud Run is `did not respond in time during attempt 1`.

**Mitigation in PR #94**:

- **Timeout**: per-adapter floor 45s → 90s, **FCC-only**. EPA /
  Grand County deliberately stay at the shared `SLOW_UPSTREAM_TIMEOUT_MS`
  because their failure modes (DNS, TCP connect-timeout) wouldn't
  benefit from a longer budget.
- **Cache**: 15-min in-memory `Map`, keyed by lat/lng rounded to
  `CACHE_COORDINATE_PRECISION` (5 d.p.). Sits in front of the
  existing 24h Postgres `adapter_response_cache` (federal-tier
  default, see [`artifacts/api-server/src/lib/adapterCache.ts`](artifacts/api-server/src/lib/adapterCache.ts)).
  Catches operator-reload-within-15min case and the tests/scripts
  path that runs without Postgres.
- Cache key shape: `${latRounded5},${lngRounded5}` — string form
  of the same precision contract `toCacheKey` uses, so an in-mem
  hit and a Postgres hit are interchangeable for the same parcel.

Three new tests + one updated invariant in `federalAdapters.test.ts`;
all 227/227 adapter tests pass.

## SCOPE C — Grand County GIS (operator infra recommendation)

**Adapter URLs** ([grand-county-ut.ts:37-44](lib/adapters/src/local/grand-county-ut.ts#L37-L44)):

```
parcels: https://gis.grandcountyutah.net/server/rest/services/Public/Parcels/MapServer/0
zoning:  https://gis.grandcountyutah.net/server/rest/services/Public/Zoning/MapServer/0
roads:   https://gis.grandcountyutah.net/server/rest/services/Public/Roads/MapServer/0
```

The REST query the adapter builds via `arcgisPointQuery`:
`{serviceUrl}/query?f=json&geometry={x:lng,y:lat,spatialReference:{wkid:4326}}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true`.

**Operator's table probed `webgis.grandcountyutah.net` (NXDOMAIN)
and `grandcountyutah.maps.arcgis.com` (200/0.5s)** — but the adapter
uses **`gis.grandcountyutah.net`** (a different host). The
dispatch's "if any reference to webgis…, fix to the live host"
rule doesn't trigger because there is no `webgis.` reference.

**Cloud Run vs workstation**: pill is `UND_ERR_CONNECT_TIMEOUT`
(TCP socket opened, no SYN-ACK). That semantics requires DNS to
have succeeded — undici would surface ENOTFOUND otherwise. So
`gis.grandcountyutah.net` resolves from Cloud Run; the TCP
handshake is what's failing. Classic firewall / IP-allowlist drop
on the upstream side.

**Verdict: operator infra**, not code.

**Recommendation**:

1. Provision a serverless VPC connector for `cortex-api` + Cloud
   NAT with **stable allocated egress IP**. Whitelist outreach is
   pointless until the IP is stable.
2. Outreach to Grand County GIS to whitelist the egress IP for
   `gis.grandcountyutah.net`.
3. **Fallback** if the county can't / won't whitelist: switch the
   adapter to `grandcountyutah.maps.arcgis.com` (AGOL mirror — the
   operator confirmed it's reachable from workstation; presumably
   also from Cloud Run since AGOL uses CDN). That's a separate
   dispatch — non-trivial because AGOL uses different service IDs
   (UUIDs) and the layer schema may differ from the county-hosted
   MapServer.

**Note**: `grand-county-ut:roads` returning `ok` is **not**
evidence Grand County GIS is healthy — it's the OSM Overpass
fallback that's serving, not the county.

## Verification

- Branch off `origin/main` HEAD = `0fc4e7d` (includes PR #93)
  in isolated worktree `p:/tmp/qa22-upstream-probe` per the
  workspace-hygiene memory.
- `pnpm --filter @workspace/adapters run typecheck` — clean.
- `pnpm --filter @workspace/adapters test` — 227/227 passing
  (224 pre-existing + 3 new + 1 updated assertion).
- `pnpm run typecheck` (workspace-wide) — all 7 artifacts +
  scripts green.
- Workspace YAML + lockfile reverted post-verify per
  `project_windows_test_natives` workaround.

## Held / not touched

- Cached-last-good fallback in `runner.ts` — separate dispatch.
- VPC / NAT / whitelist implementation — operator.
- `retry.ts` throw-capture behavior — no regression identified.
- QA-33 / QA-35 (separate dispatches), 2D-site-context, Phase 3
  features.
