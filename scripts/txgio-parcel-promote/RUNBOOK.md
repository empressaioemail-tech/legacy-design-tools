# txgio_parcel staging -> prod promote (OPERATOR-GATED)

Status: prepared, NOT run. Run manually against production. Nick/operator gate.

## What this does

Promotes all 8 counties in `txgio_parcel_staging` into prod `txgio_parcel`:

| FIPS  | County     | staging rows |
|-------|------------|--------------|
| 48021 | Bastrop    | 74,729       |
| 48027 | Bell       | 184,470      |
| 48029 | Bexar      | 747,206      |
| 48055 | Caldwell   | 32,781       |
| 48187 | Guadalupe  | 106,508      |
| 48309 | McLennan   | 130,650      |
| 48453 | Travis     | 894,657      |
| 48491 | Williamson | 304,298      |
| **total** |        | **2,475,299**|

Prod already holds Hays (48209, 131,734) and Comal (48091, 114,430) and is left
untouched by this promote. After the promote, prod holds all 10 counties.

Row count note: rows > distinct parcels because a parcel spanning multiple map
tiles has one row per tile (PK includes `tile_key`). 2,475,299 rows is the store
representation, consistent with the tiled store design.

## Safety picture (verified live 2026-07-19, read-only)

- Schemas are byte-identical: 18 columns, same names/types/nullability/defaults,
  PK on both = `(county_fips, tile_key, feature_index)`. No `owner_user_id` or any
  other NOT-NULL column that staging fails to populate. Zero staging rows are NULL
  in any prod NOT-NULL column. The historical owner_user_id landmine does NOT exist
  on this table.
- Zero PK overlap between staging and prod today, so this is a pure insert;
  `ON CONFLICT DO NOTHING` is for restartability, not because collisions exist.
- Lock: an `INSERT` takes only `RowExclusiveLock` on `txgio_parcel`. In Postgres
  MVCC this does NOT block concurrent `SELECT` (the live `/resolve` reads keep
  serving). No index rebuild, no `ACCESS EXCLUSIVE` lock.
- Prod carries two indexes staging lacks: `txgio_parcel_prop_idx` and a large
  functional situs-normalization index `txgio_parcel_situs_norm_idx`. These are
  maintained incrementally per inserted row (no rebuild) but make this a
  write-heavy operation. Run in a low-traffic window; expect minutes, not seconds,
  for Travis/Bexar.

## Prerequisites

Get the prod DB URL into a shell var (do NOT paste it into history files):

```bash
PGURL="$(gcloud secrets versions access latest \
  --secret=DEPLOYMENT_DATABASE_URL --project=legacy-design-tools-prod)"
# sanity: should start with postgresql:// and be ~117 chars
echo "len=${#PGURL}"; echo "${PGURL:0:15}..."
```

## Run (recommended: per-county, restartable)

```bash
psql "$PGURL" -f scripts/txgio-parcel-promote/promote_staging_to_prod.sql
```

The script prints PRE staging/prod counts, runs 8 per-county INSERTs (each with
its own `INSERT 0 <n>` line), then prints POST prod counts and a reconciliation
query. A clean run ends with an EMPTY reconciliation result.

Neon note: Neon can idle-timeout very long transactions
(`idle_in_transaction_session_timeout`). The per-county file keeps each INSERT as
its own statement so a stall on one county doesn't jeopardize the others, and any
county can be re-run independently.

### Single-statement variant (optional)

```bash
psql "$PGURL" -f scripts/txgio-parcel-promote/promote_staging_to_prod_single.sql
```

One atomic INSERT of all 8 counties. No per-county progress; an interrupt rolls
back the whole insert (nothing lands until commit). Still safe to re-run.

## If interrupted

Just re-run the same file. `ON CONFLICT DO NOTHING` skips already-present rows;
only the remainder inserts. For the per-county file you can also re-run only the
county that failed by copying its single INSERT block.

## Verify after (independent check)

```bash
psql "$PGURL" -c "SELECT county_fips, count(*) FROM txgio_parcel GROUP BY county_fips ORDER BY county_fips;"
```

Expect 10 rows; the 8 promoted counts should match the table above, and
48091/48209 unchanged.

## SEQUENCING with the router PR

Run this promote FIRST. Only after prod holds the 3 gap counties (Bell 48027,
McLennan 48309, Guadalupe 48187) should the router PR
("F4g: route Bell/McLennan/Guadalupe to txgio-store (post-promote)") be
merged + deployed. If the router deploys before the promote, those coords resolve
to the store, find zero rows, and 502 again (now "supported but empty" instead of
"unsupported") — confusing, not fixed. Promote is idempotent, so promote-first is
strictly safe.

The metro-5 (Travis/Williamson/Bexar/Bastrop/Caldwell) stay on their live-ArcGIS
path per operator decision even though their data is now also in the store; the
router PR does not touch their entries. Their promoted store rows are simply
inert until/unless a later change repoints them.
