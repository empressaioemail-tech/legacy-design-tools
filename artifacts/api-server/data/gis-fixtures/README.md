# Max map GIS fixtures — Cotality Spatial Tile bbox

Committed captures for `POST /api/brokerage/v1/map-data/gis-layer?fixture=1` so
extension-agent can style the national parcel mesh and land-use choropleth without
burning the Cotality **demo** Spatial Tile quota (HTTP 429).

## Files

| File | Purpose |
|------|---------|
| `bastrop-tx-parcels-bbox.gis-layer.json` | Full `/gis-layer` response shape (`result` + `manifest`) |
| `bastrop-tx-parcels-bbox.spatial-tile.raw.json` | Raw Cotality Spatial Tile pages (audit / re-process) |

FEMA NFHL is public and not quota-blocked — use live `layer: "fema"` (no fixture needed).

## Viewport

Bastrop QA bbox (matches `scripts/_map-cotality-national-smoke.mjs`):

```json
{ "west": -97.32, "south": 30.10, "east": -97.30, "north": 30.12 }
```

## Extension / QA request

```http
POST /api/brokerage/v1/map-data/gis-layer?fixture=1
X-Hauska-Key: <extension key>
X-Hauska-Install-Id: extension-agent-map-max-qa
Content-Type: application/json

{ "layer": "parcels", "bbox": { "west": -97.32, "south": 30.10, "east": -97.30, "north": 30.12 } }
```

Response adds `fixture: true`, `fixtureMeta`, and the same fields as live:
`geojson`, `featureCount`, `queryMode`, `adapterKey`, `provider`.

Parcel features include Cotality land-use / zoning properties when Property
`site-location` enrichment succeeded at capture time (`zoningCode`, `landUseCode`,
descriptions).

## Refresh (operator / agent)

When Cotality Spatial Tile quota allows:

```bash
node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs artifacts/api-server/src/captureBrokerageGisFixtureCli.ts
git add artifacts/api-server/data/gis-fixtures/
```

Requires `COTALITY_PROPERTY_*` + `COTALITY_SPATIALTILE_*` (GCP Secret Manager
on `legacy-design-tools-prod` or local env).

## Live map

Do **not** ship or QA the production mesh on demo keys — demo Spatial Tile quota
is exhausted under moderate load and keys expire ~**2026-07-06**. See
`_inbox/2026-06-18_legacy-design-tools_cc-agent-C_cotality_production_quota_scope.md`.
