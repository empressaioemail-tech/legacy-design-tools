# Parcels PMTiles bake (map 10x rebuild, Wave D3)

`src/parcelsPmtilesBakeCli.ts` turns the self-hosted Central-Texas parcel
geometry into a static vector-tile pyramid (PMTiles) for the browse-all-CenTX
map. It is an offline, re-runnable bake. It does NOT deploy or serve the tiles
(that is Wave D4, which uploads the produced PMTiles to GCS and wires the
serving). It never writes the parcel tables — the DB reads are read-only.

## What it reads (dual-table union)

The full Central-TX parcel fabric lives in TWO tables with the SAME physical
schema (migration 0053):

- `txgio_parcel` — the prod store the app reads (Comal 48091, Hays 48209).
- `txgio_parcel_staging` — the operator's bulk-load staging table for the eight
  metro/gap counties (Travis 48453, Bexar 48029, Williamson 48491, Bell 48027,
  McLennan 48309, Guadalupe 48187, Bastrop 48021, Caldwell 48055).

The bake reads the UNION of both. A county present in both is taken from prod
(the authoritative store) and skipped in staging, so a mid-migration state
(operator promoting staging into prod) never double-emits a parcel. Reading
only prod would silently omit the metro core; reading only staging would omit
Comal/Hays.

Rows are stored one-per-intersecting-grid-cell, so the export reads
`DISTINCT ON (feature_index)` per county to emit each parcel exactly once
(same dedupe the store readers use). The distinct-parcel count across both
tables is ~2.51M (the ~2.72M figure quoted upstream is the raw row count
before the per-cell dedupe).

## What it stamps on each feature

- `parcel_node_id = "{county_fips}:{normalizeCadPropId(prop_id)}"`, computed
  via the SHARED `parcelNodeId` helper (`src/lib/parcelNodeId.ts`) so a parcel
  baked here and the same parcel fetched live carry the SAME id. It is kept as
  a feature PROPERTY (R1's renderer keys feature-state on it via maplibre
  `promoteId`, which replaces the tile id with the property value at runtime).
  Parcels with no prop id are emitted WITHOUT a node id (never a fabricated
  one).
- `apn`, `county_fips`, `countyName`, `situsAddress`, `owner` where present.
- `landUseCode` + a keyword-bucketable `landUseDescription` (via the shared
  `ptadLandUseDescription`) + `landUseSource: "cad-roll"` + `landUseVintage`,
  joined from the `cad_property` appraisal roll on the SAME key the cad:* brief
  adapters use `(county_fips, normalizeCadPropId(prop_id))`. Five counties have
  a roll loaded (Travis, Williamson, Bastrop, Caldwell, Hays); the other five
  bake geometry-only with uniform paint — still clickable, honestly neutral, no
  fabricated code.

## tippecanoe (>= 2.x required)

PMTiles output and the `--coalesce-densest-as-needed` flag need a CURRENT
tippecanoe. The old `klokantech/tippecanoe:latest` (v1.24) has neither. Build
the maintained felt/tippecanoe fork into a local image once:

```
# clone the source on the host (a container git clone may hit a proxy cert
# wall in this environment), then COPY it into the build:
git clone --depth 1 https://github.com/felt/tippecanoe.git /tmp/tippecanoe-src
cat > /tmp/tippecanoe-src/../Dockerfile <<'EOF'
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libsqlite3-dev zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY tippecanoe-src /src
RUN cd /src && make -j"$(nproc)" && make install
WORKDIR /data
EOF
docker build -t tippecanoe-felt:latest /path/containing/tippecanoe-src
```

The bake auto-detects a native `tippecanoe` on PATH; otherwise it runs the
docker image named by `TIPPECANOE_DOCKER_IMAGE` (default `tippecanoe-felt:latest`).

## Run

```
# from the repo root; DATABASE_URL falls back to the DEPLOYMENT_DATABASE_URL
# secret via gcloud if unset.
pnpm --filter @workspace/api-server parcels-pmtiles-bake -- \
  --out-dir=./.pmtiles-bake \
  [--counties=48453,48209,48021]   # subset; default: all present \
  [--min-zoom=0] [--max-zoom=16] \
  [--page-size=20000] [--limit=N]  # --limit caps parcels per county \
  [--export-only]                  # write the GeoJSONSeq only, skip tippecanoe \
  [--geojson=<path>]               # bake an existing export (skip the DB) \
  [--tippecanoe=docker|<binary>]
```

The tippecanoe config: `--minimum-zoom 0 --maximum-zoom 16
--drop-densest-as-needed --coalesce-densest-as-needed --simplification 10
--extend-zooms-if-still-dropping`. z0-z16 with density coalescing means a
zoomed-out CenTX view renders a coherent generalized parcel fabric instead of
cutting off. (`--use-attribute-for-id` is omitted deliberately: parcel_node_id
is a string and a tile numeric id must be an integer, so the flag would only
warn per feature and set no usable id; the property + promoteId is the
load-bearing mechanism. Set `TIPPECANOE_ATTRIBUTE_ID=1` to force the flag.)

## Content-hashed output + re-bake

The output is renamed to `parcels.<sha256-12>.pmtiles`. When the operator later
promotes staging into prod or loads more CAD roll, re-baking produces a fresh
hash; D4 uploads the hashed name to GCS so cache-busting is automatic.
