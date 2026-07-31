# Terrain RGB tile pipeline (TxGIO DTM → MapLibre terrain-RGB)

Sibling to the parcel PMTiles bake (`artifacts/api-server/README-parcels-pmtiles-bake.md`).
Canonical portfolio doc: `doc_repo/40j_hauska_map_tile_build_pipeline.md`.

**ADDITIVE ONLY** — tiles power 3D map viz. Do not repoint engine flood/drainage or terrain export routes.

## Prerequisites

- Python 3.10+
- **GDAL** (`gdalbuildvrt`, `gdalwarp`, `gdalinfo`) on PATH, **or** Docker (uses `ghcr.io/osgeo/gdal:alpine-small-latest`)
- T-009 additionally: `rio-rgbify` (Python), `gdal2tiles.py`

## T-008 — Acquire bare-earth DTM

```powershell
cd P:\legacy-design-tools
python artifacts/tile-pipeline/terrain_dem_acquire.py `
  --aoi=bastrop-city-2mi `
  --out-dir=./.terrain-bake
```

### AOI presets

Defined in `aoi_presets.json`:

| Preset | Purpose |
|--------|---------|
| `bastrop-city-2mi` | Proof AOI — Bastrop city + ~2 mi buffer (8 StratMap qquads) |
| `bastrop-county` | County-wide extension example |

Add presets by bbox + `tile_name_patterns` (fnmatch against TxGIO `area_type_name`).

### Default source

- **Collection:** StratMap 2017 Central Texas Lidar
- **UUID:** `0549d3ba-3f72-4710-b26c-28c65df9c70d`
- **DataHub:** https://data.tnris.org/collection/?c=0549d3ba-3f72-4710-b26c-28c65df9c70d
- **API:** https://api.tnris.org/api/v1/resources/?collection_id=...&resource_type_abbreviation=DEM

### Output

```
.terrain-bake/
  terrain-dem.<hash12>.tif
  terrain-dem.<hash12>.metadata.json   # CRS, NAVD88, ftUS — required for Phase 3
  download_manifest.json
  zips/   tiles/   (cache; safe to delete after mosaic)
```

Metadata fields are load-bearing for Phase 3 (`T-012` flood depth = BFE − ground):

- `horizontal_crs` — native projected CRS (expect EPSG:6343)
- `vertical_datum` — expect NAVD88 (verify supplemental report)
- `vertical_unit` — expect US survey foot

### Statewide extension

1. Add an AOI preset (or `--collection-id` for a different TxGIO collection).
2. Re-run acquire → new content hash.
3. Run T-009 bake → upload new `terrain-rgb.<hash12>/` to `gs://hauska-map-tiles`.
4. Update hauska-map config hash. No code fork.

## T-009 — Terrain-RGB bake

```powershell
python -m pip install -r artifacts/tile-pipeline/requirements.txt

python artifacts/tile-pipeline/terrain_rgb_tiles_bake.py `
  --dem=./.terrain-bake/terrain-dem.6fb2e610e91b.tif `
  --metadata=./.terrain-bake/terrain-dem.6fb2e610e91b.metadata.json `
  --out-dir=./.terrain-bake
```

Steps: warp EPSG:3857 → vertical unit to meters during rgbify (US survey foot × 1200/3937) → Mapbox encoding (`base -10000`, `interval 0.1` m) → `gdal2tiles.py` z0–z16 (XYZ PNG). Intermediate warp3857.tif is deleted after rgbify unless `--keep-intermediates`.

GDAL via native PATH or Docker `ghcr.io/osgeo/gdal:ubuntu-full-latest` (warp, gdal_calc, gdal2tiles).

### Output

```
.terrain-bake/
  terrain-rgb.<hash12>/              # {z}/{x}/{y}.png pyramid
  terrain-rgb.<hash12>.metadata.json # encoding, zoom range, datum preserved
  terrain-rgb.<hash12>.wire.env      # T-010 constants for hauska-map
  terrain-rgb.warp3857.tif           # intermediate (cache)
  terrain-rgb.meters.tif             # intermediate (cache)
  terrain-rgb.rgb.tif                # intermediate (cache)
```

Publish (planner-owned, after merge coordination):

```powershell
gcloud storage rsync -r .\terrain-rgb.<hash12>\ `
  gs://hauska-map-tiles/terrain-rgb.<hash12>/ `
  --cache-control="public, max-age=31536000, immutable" `
  --project=legacy-design-tools-prod

gcloud storage cp .\terrain-rgb.<hash12>.metadata.json `
  gs://hauska-map-tiles/terrain-rgb.<hash12>.metadata.json `
  --cache-control="public, max-age=31536000, immutable" `
  --project=legacy-design-tools-prod
```

## T-010 — hauska-map wire

See `doc_repo/_dispatches/2026-07-31_T010_setTerrain_wire.md`.

## Safety

- Do not import staged DEM into `hauska-engine` flood or `bastrop-contours.ts` paths.
- Datum trap: TxGIO = NAVD88; FEMA BFE may be NGVD29 — per-report migration only.
