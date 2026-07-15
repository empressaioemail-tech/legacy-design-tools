# @workspace/permit-ingest

Batch ingest of free municipal permit open-data exports into the
`building_permits` store (peer to `@workspace/cad-ingest` /
`cad_property`). Consumed by a follow-up Property Brief `permits:*` slot
adapter (a separate PR — not built here).

## Sources

| `--source` | `--county` | Jurisdiction | Parcel key | Permit id |
| --- | --- | --- | --- | --- |
| `austin` | `48453` | Austin (Travis) | `TCAD ID` | `Permit Num` |
| `san-antonio` | `48029` | San Antonio (Bexar) | none in the open data | `PERMIT #` |

The per-city CSV column mapping is factored into
`@workspace/calibration-engines/k2` (`permitColumns.ts`) and shared with
the K2 calibration harness, so the store and the harness read the same
corpus identically. San Antonio's live open-data drops carry no parcel
and no status column and use the string sentinel `NULL`; `prop_id` falls
back to `""` there (the permit still lands under the composite key), and
the repeated `PERMIT #` across a project's trade lines dedups to one row.

## Usage

```
pnpm --filter @workspace/permit-ingest permit-ingest -- \
  --source=san-antonio \
  --file=gs://hauska-calibration-raw/backtest/san_antonio_tx/permit/open_data/acquired=2026-06-21/data/permits_issued_current.csv
```

`DATABASE_URL` must point at the target Postgres unless `--dry-run`.

Flags: `--source` (or `--county`), `--file` (required), `--vintage`
(default: derived from the file name), `--batch-size` (default 1000),
`--limit`, `--dry-run`.

### Input: gs:// or local path

`gs://` inputs stream through `gcloud storage cat` (mirrors the K2
harness). Set `PERMIT_INGEST_GCLOUD` to point at a specific gcloud
binary (defaults to the one on `PATH`; the harness hardcodes a Windows
path). The permit files are large (Austin ~2.36M rows) and are streamed,
never buffered whole.

If `gcloud storage cat` streaming is flaky in your environment,
`gcloud storage cp` the file down first and pass the local path instead:

```
gcloud storage cp gs://.../permits_issued_2020_2024.csv ./sa.csv
pnpm --filter @workspace/permit-ingest permit-ingest -- \
  --source=san-antonio --file=./sa.csv
```

Both forms feed the same streaming RFC-4180 parser.

## Idempotency

Upsert is `ON CONFLICT (county_fips, prop_id, permit_id) DO UPDATE`:
re-running the same drop (or a fresher drop of the same corpus)
overwrites attribute columns and bumps `ingested_at`, leaving the row
count unchanged. The parser dedups on the primary key within a file so a
single INSERT never updates the same row twice.
