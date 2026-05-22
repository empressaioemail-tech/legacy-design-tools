-- ============================================================================
-- 0015 — Catch-up migration: post-0014 schema drift on cortex-api production
--
-- The numbered migration head on `main` is 0014. Two schema changes merged
-- after it never received a migration file, so the cortex-api production Neon
-- DB (ep-lucky-truth-apodo8hr) drifted behind the deployed code:
--
--   • PR #33 (a00884d, "supersede-and-append materializable_elements on
--     re-ingest") — added materializable_elements.superseded_by_id +
--     superseded_at, the self-FK on superseded_by_id, and the
--     active-IFC-identity partial unique index.
--   • PR #27 (f4840ee) — added the eval-harness tables eval_baselines /
--     eval_runs / eval_scores.
--
-- The missing `superseded_at` column is the VERIFIED root cause of the IFC
-- push HTTP 500 — the production log shows
-- `column materializable_elements.superseded_at does not exist`, thrown from
-- ingestSnapshotIfc (artifacts/api-server/src/lib/ifcIngest.ts). The eval_*
-- tables are not load-bearing for the customer-zero loop but are part of the
-- same drift and are included so prod matches the drizzle migration head.
--
-- Recon confirming the gap (read-only, 2026-05-22, against the prod DB):
--   - materializable_elements: 16 columns (canonical 18) — superseded_by_id
--     and superseded_at MISSING; index materializable_elements_active_ifc_
--     identity_uniq MISSING.
--   - eval_baselines / eval_runs / eval_scores: tables ABSENT.
--   - All 0009-0014 tables + track-b-ifc-ingest.sql objects: PRESENT.
--   - reviewer_requests, code_atoms, attached_documents, etc.: no drift.
--
-- Idempotency: every statement uses IF NOT EXISTS, or DROP-then-ADD for
-- constraints (Postgres has no ADD CONSTRAINT IF NOT EXISTS) — matching the
-- track-b-ifc-ingest.sql precedent. A partial re-run is safe. The whole
-- migration runs in one transaction: all-or-nothing.
--
-- Apply: this round, by hand to the cortex-api production Neon DB via
-- 90_runbooks/neon_schema_migration_via_cloud_shell.md, operator-supervised.
-- Phase 2 P2-2 then adds the run-migrations workflow job so every deploy
-- after this applies outstanding migrations automatically.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- A. Eval-harness tables (PR #27).
--    Created without inline FKs so the FK constraint names match the drizzle-
--    generated names in the canonical schema (schema.sql.template). Inline
--    PRIMARY KEY yields the Postgres-default `<table>_pkey`, which already
--    matches the canonical names.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_key text NOT NULL,
  component_key text NOT NULL,
  baseline_score numeric(20,6) NOT NULL,
  regression_threshold numeric(6,4) NOT NULL,
  last_updated timestamp with time zone NOT NULL DEFAULT now(),
  commit_hash text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_baselines_fixture_component_uniq
  ON eval_baselines USING btree (fixture_key, component_key);

CREATE TABLE IF NOT EXISTS eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid,
  fixture_key text NOT NULL,
  engine_version text NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  state text NOT NULL,
  error text,
  total_cost_usd numeric(12,6),
  total_duration_ms integer,
  trigger_source text NOT NULL
);

ALTER TABLE eval_runs
  DROP CONSTRAINT IF EXISTS eval_runs_engagement_id_engagements_id_fk;
ALTER TABLE eval_runs
  ADD CONSTRAINT eval_runs_engagement_id_engagements_id_fk
  FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS eval_runs_fixture_started_idx
  ON eval_runs USING btree (fixture_key, started_at);

CREATE TABLE IF NOT EXISTS eval_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id uuid NOT NULL,
  component_key text NOT NULL,
  score numeric(20,6) NOT NULL,
  score_unit text NOT NULL,
  passed_threshold boolean,
  details jsonb
);

ALTER TABLE eval_scores
  DROP CONSTRAINT IF EXISTS eval_scores_eval_run_id_eval_runs_id_fk;
ALTER TABLE eval_scores
  ADD CONSTRAINT eval_scores_eval_run_id_eval_runs_id_fk
  FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS eval_scores_run_component_idx
  ON eval_scores USING btree (eval_run_id, component_key);

-- ----------------------------------------------------------------------------
-- B. materializable_elements supersede-and-append columns (PR #33).
--    superseded_at is the verified IFC-push HTTP 500 root cause.
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_at timestamp with time zone;

-- Self-referential FK on superseded_by_id. Drop-then-add for idempotency.
ALTER TABLE materializable_elements
  DROP CONSTRAINT IF EXISTS materializable_elements_superseded_by_id_materializable_element;
ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_superseded_by_id_materializable_element
  FOREIGN KEY (superseded_by_id) REFERENCES materializable_elements(id)
  ON DELETE SET NULL;

-- "One active row per IFC entity-identity" partial unique index. Safe to
-- create: no IFC ingest has ever succeeded in prod (this migration unblocks
-- the first one), so there are zero as-built-ifc rows to conflict.
CREATE UNIQUE INDEX IF NOT EXISTS materializable_elements_active_ifc_identity_uniq
  ON materializable_elements USING btree (source_snapshot_id, ifc_global_id)
  WHERE ((superseded_at IS NULL)
         AND (source_kind = ANY (ARRAY['as-built-ifc'::text, 'as-built-ifc-bundle'::text])));

COMMIT;

-- ============================================================================
-- Verification (run AFTER commit; not part of the transaction):
--
--   -- expect superseded_by_id + superseded_at columns and the
--   -- materializable_elements_active_ifc_identity_uniq index:
--   \d materializable_elements
--
--   -- expect all three tables present:
--   \d eval_baselines
--   \d eval_runs
--   \d eval_scores
--
--   -- column-count parity check — both must return 18 / 7 / 11 / 7:
--   SELECT count(*) FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='materializable_elements';
--   SELECT count(*) FROM information_schema.columns
--     WHERE table_schema='public' AND table_name IN ('eval_baselines','eval_runs','eval_scores')
--     GROUP BY table_name ORDER BY table_name;
-- ============================================================================
