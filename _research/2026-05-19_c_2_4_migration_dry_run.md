---
id: 2026-05-19_c_2_4_migration_dry_run
title: C.2.4 — Neon data-migration dry-run procedure + expected diff
date: 2026-05-19
agent: cc-agent-C
repo: legacy-design-tools
kind: runbook-draft
related: [_research/2026-05-19_c_2_3_neon_provisioning, _research/2026-05-19_c_2_5_cutover_runbook_draft]
---

# C.2.4 — Neon data-migration dry-run procedure + expected diff

The **rehearsal** for moving production data from the current
(Replit-side) Neon instance to the new `cortex-prod` Neon instance. The
dry-run restores a snapshot to a *temporary staging* instance — never
the new prod instance — and diffs it against source so the real cutover
(C.2.5) replays a known-good procedure instead of improvising.

Operator-executed (cc-agent-C has no DB credentials). **Preparation
only** — no production data moves here.

## Why a dry-run at all

The legacy-design-tools schema is plain relational Postgres + `pgvector`
columns. A `pg_dump`/`pg_restore` round-trip is mechanically simple, but
three things make a rehearsal worth it:

1. **pgvector**: the `vector` extension must exist on the target before
   restore, or every `vector`-typed column fails. The dry-run proves
   the extension-first ordering.
2. **Sequences / identity**: confirm sequence current-values restore so
   post-cutover inserts don't collide with existing ids.
3. **Neon specifics**: dump from / restore to Neon needs the **direct**
   (non-pooled) endpoint; the pooler (pgBouncer) rejects some
   `pg_restore` operations. The dry-run catches endpoint mistakes
   before cutover.

## Prerequisites

- [ ] `pg_dump` + `pg_restore` + `psql` at a version **>=** the Neon
      server's Postgres major. (Postgres-client install is still a
      flagged Phase-1B prereq — install before starting.)
- [ ] Direct (non-pooled) connection string for the **current prod
      Neon** — call it `SRC_URL`.
- [ ] A **temporary staging** Postgres for the restore target — call it
      `STAGING_URL`. Cheapest path: a Neon *branch* off the current
      prod instance, or a throwaway free-tier Neon project. Do **not**
      use `cortex-prod` (the real new instance) as the dry-run target.

`SRC` = current prod Neon. `STAGING` = throwaway restore target.

## Procedure

### Step 1 — Snapshot the source

```bash
mkdir -p /tmp/cortex-migration
pg_dump "$SRC_URL" \
  --format=custom \
  --no-owner --no-privileges \
  --file=/tmp/cortex-migration/source.dump
```

`--no-owner --no-privileges`: Neon manages roles; restoring ownership
grants from one Neon project into another just produces noise. Custom
format enables parallel restore + selective inspection.

Capture the source's table inventory + row counts for the diff:

```bash
psql "$SRC_URL" -tAc "
  SELECT relname, n_live_tup
  FROM pg_stat_user_tables ORDER BY relname;" \
  > /tmp/cortex-migration/source_counts.txt
```

`n_live_tup` is an estimate; Step 4 does an exact `COUNT(*)` diff.

### Step 2 — Prepare the staging target

```bash
psql "$STAGING_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Extension first — the restore of any `vector` column fails otherwise.
If `STAGING` is a Neon branch of `SRC` it already has both the
extension and the data; for a branch, skip Steps 2-3 and treat the
branch itself as the "restore" (the branch IS a point-in-time copy) —
go straight to Step 4's diff (which should then be a clean zero-diff,
proving the branch tooling).

### Step 3 — Restore into staging

```bash
pg_restore \
  --dbname="$STAGING_URL" \
  --no-owner --no-privileges \
  --jobs=4 \
  --exit-on-error \
  /tmp/cortex-migration/source.dump
```

`--exit-on-error` so a partial restore fails loudly rather than
silently dropping rows.

### Step 4 — Diff staging vs source

Capture into `_research/2026-05-19_neon_migration_dry_run_diff.md`
(see "Expected diff" below for the shape).

**4a. Table inventory** — same set of tables both sides:

```bash
for U in "$SRC_URL" "$STAGING_URL"; do
  psql "$U" -tAc "SELECT tablename FROM pg_tables
                  WHERE schemaname='public' ORDER BY 1;"
done
# diff the two lists — expect identical.
```

**4b. Exact row counts** — per table, both sides:

```bash
# Generate a COUNT(*) query for every table, run on each side, diff.
psql "$SRC_URL" -tAc "
  SELECT 'SELECT '''||tablename||''' t, count(*) c FROM '||tablename||';'
  FROM pg_tables WHERE schemaname='public' ORDER BY 1;" \
  > /tmp/cortex-migration/count_each.sql
psql "$SRC_URL"     -tAf /tmp/cortex-migration/count_each.sql | sort > /tmp/cortex-migration/src_rows.txt
psql "$STAGING_URL" -tAf /tmp/cortex-migration/count_each.sql | sort > /tmp/cortex-migration/stg_rows.txt
diff /tmp/cortex-migration/src_rows.txt /tmp/cortex-migration/stg_rows.txt
# expect: no output (every table's count matches).
```

**4c. Referential integrity** — no orphaned FKs on the restored side.
For each FK, a left-anti-join must return zero rows. Generate the
checks dynamically:

```bash
psql "$STAGING_URL" -tAc "
  SELECT format(
    'SELECT %L fk, count(*) orphans FROM %I c LEFT JOIN %I p ON c.%I = p.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL;',
    conname, conrelid::regclass, confrelid::regclass,
    (SELECT attname FROM pg_attribute WHERE attrelid=conrelid AND attnum=conkey[1]),
    (SELECT attname FROM pg_attribute WHERE attrelid=confrelid AND attnum=confkey[1]),
    (SELECT attname FROM pg_attribute WHERE attrelid=conrelid AND attnum=conkey[1]),
    (SELECT attname FROM pg_attribute WHERE attrelid=confrelid AND attnum=confkey[1]))
  FROM pg_constraint WHERE contype='f';" \
  > /tmp/cortex-migration/fk_checks.sql
psql "$STAGING_URL" -tAf /tmp/cortex-migration/fk_checks.sql
# expect: every line reports 0 orphans.
```

(Single-column FKs only — composite FKs, if any, need a hand-written
check. The current schema's FKs are single-column.)

**4d. Sequences** — `last_value` restored, not reset to 1:

```bash
for U in "$SRC_URL" "$STAGING_URL"; do
  psql "$U" -tAc "
    SELECT schemaname||'.'||sequencename, last_value
    FROM pg_sequences WHERE schemaname='public' ORDER BY 1;"
done
# diff — expect identical last_value per sequence.
```

Most tables use `uuid` / `gen_random_uuid()` primary keys (no
sequence). Any genuine `serial`/`identity` column must restore its
sequence position or post-cutover inserts collide.

**4e. Spot-check content** — a few high-value tables, newest rows:

```bash
for T in engagements snapshots submissions findings materializable_elements; do
  for U in "$SRC_URL" "$STAGING_URL"; do
    psql "$U" -tAc "SELECT md5(string_agg(id::text, ',' ORDER BY id))
                    FROM (SELECT id FROM $T ORDER BY created_at DESC LIMIT 50) s;"
  done
done
# per table, the two md5s match → the newest 50 rows are byte-identical.
```

### Step 5 — Document drops / transforms / special handling

Record anything that needs hand-holding at real cutover:

- **pgvector**: extension-create must precede restore (Step 2). The
  custom-format dump does not carry `CREATE EXTENSION` reliably across
  Neon projects — always run it explicitly.
- **Materialized views**: `pg_dump` restores MV *definitions* but their
  contents need `REFRESH MATERIALIZED VIEW` post-restore. Inventory:
  `SELECT matviewname FROM pg_matviews WHERE schemaname='public';` — if
  any exist, the cutover adds a refresh step. (Current schema is
  believed to have none — confirm during the dry-run.)
- **Sequence resets**: per 4d — none expected (uuid PKs), confirm.
- **Object storage**: `pg_dump` moves only the database. The GCS object
  bytes (`/objects/...`) are separate. If the cutover keeps the
  existing GCS bucket (C.2.3 A6 — likely), no object migration is
  needed; if a new bucket, object bytes need a separate `gcloud storage
  rsync`. Decide bucket strategy before cutover.

## Expected diff (the shape of `2026-05-19_neon_migration_dry_run_diff.md`)

A clean dry-run produces a diff doc that is mostly "no delta":

| Check | Expected result |
|---|---|
| 4a table inventory | identical table set both sides |
| 4b row counts | zero `diff` output — every table count matches |
| 4c referential integrity | every FK reports `0 orphans` |
| 4d sequences | identical `last_value` (or: no sequences — uuid PKs) |
| 4e content spot-check | matching md5 per sampled table |

**Known-acceptable deltas** (document, do not block on):
- A tiny row-count drift on append-heavy tables (`atom_events`,
  `*_runs`, `adapter_cache`) if the source took writes *between* the
  Step-1 dump and the Step-4 count. The real cutover eliminates this by
  taking the production snapshot during a write-quiet window / brief
  maintenance pause (see C.2.5).
- `pg_stat_user_tables.n_live_tup` estimates differing from exact
  `COUNT(*)` — expected; 4b's exact counts are authoritative.

Any **unexplained** delta (missing table, non-zero orphan count,
mismatched content md5) blocks cutover — investigate before C.2.5.

## Exit criteria (C.2.4 done)

- [ ] A full dump → restore → diff cycle completed against a staging
      target.
- [ ] `2026-05-19_neon_migration_dry_run_diff.md` written, every check
      either clean or its delta documented as known-acceptable.
- [ ] Special-handling list (Step 5) finalized — feeds the C.2.5
      cutover's data-load step.

Hand the readiness signal to the planner; the C.2.5 cutover runbook
replays this procedure in production-mode against `cortex-prod`.
