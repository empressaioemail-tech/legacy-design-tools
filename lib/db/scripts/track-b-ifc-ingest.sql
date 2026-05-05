-- ============================================================================
-- Track B — Server-side IFC ingest schema migration
--
-- Apply to deployment Neon by hand. Dev (helium) is updated via
-- `pnpm --filter @workspace/db push` from the repo root after the drizzle
-- schema files in `lib/db/src/schema/{materializableElements,snapshotIfcFiles}.ts`
-- are merged.
--
-- Idempotency: every step uses `IF NOT EXISTS` / `IF EXISTS` so a partial
-- re-run is safe.
--
-- Pre-flight check (recon-confirmed): production has zero rows in
-- `materializable_elements`. The backfill UPDATE is therefore a no-op in
-- production but is included for safety in case the situation changes
-- before deploy.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- A. Provenance discriminator
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'briefing-derived';

-- ----------------------------------------------------------------------------
-- B. Drop briefing_id NOT NULL so IFC rows can exist without a briefing.
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  ALTER COLUMN briefing_id DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- C. Denormalize engagement_id; nullable. CHECK below requires it for IFC.
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES engagements(id) ON DELETE CASCADE;

-- Backfill from the briefing relation. No-op in production (zero rows).
UPDATE materializable_elements me
SET engagement_id = pb.engagement_id
FROM parcel_briefings pb
WHERE me.briefing_id = pb.id AND me.engagement_id IS NULL;

-- ----------------------------------------------------------------------------
-- D. IFC-only columns
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  ADD COLUMN IF NOT EXISTS ifc_global_id text,
  ADD COLUMN IF NOT EXISTS ifc_type text,
  ADD COLUMN IF NOT EXISTS property_set jsonb,
  ADD COLUMN IF NOT EXISTS source_snapshot_id uuid REFERENCES snapshots(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- E. Closed-tuple guard on source_kind
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  DROP CONSTRAINT IF EXISTS materializable_elements_source_kind_check;
ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_source_kind_check
  CHECK (source_kind IN ('briefing-derived', 'as-built-ifc', 'as-built-ifc-bundle'));

-- ----------------------------------------------------------------------------
-- F. Provenance invariants
-- ----------------------------------------------------------------------------
ALTER TABLE materializable_elements
  DROP CONSTRAINT IF EXISTS materializable_elements_provenance_invariants_check;
ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_provenance_invariants_check
  CHECK (
    (source_kind = 'briefing-derived' AND briefing_id IS NOT NULL)
    OR (source_kind IN ('as-built-ifc', 'as-built-ifc-bundle')
        AND source_snapshot_id IS NOT NULL
        AND engagement_id IS NOT NULL
        AND ifc_global_id IS NOT NULL
        AND ifc_type IS NOT NULL)
  );

-- ----------------------------------------------------------------------------
-- G. Indexes for the new query paths
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS materializable_elements_engagement_source_idx
  ON materializable_elements (engagement_id, source_kind)
  WHERE engagement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS materializable_elements_snapshot_idx
  ON materializable_elements (source_snapshot_id)
  WHERE source_snapshot_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- H. New table: snapshot_ifc_files
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshot_ifc_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL UNIQUE REFERENCES snapshots(id) ON DELETE CASCADE,
  blob_object_path text NOT NULL,
  gltf_object_path text,
  file_size_bytes bigint NOT NULL,
  ifc_version text,
  export_duration_ms integer,
  parse_entity_count integer,
  parsed_at timestamptz,
  parse_error text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshot_ifc_files_parsed_at_idx
  ON snapshot_ifc_files (parsed_at);

COMMIT;

-- ============================================================================
-- Verification queries (run AFTER commit; not part of the transaction)
-- ============================================================================
-- \d materializable_elements                  -- expect new columns + checks
-- \d snapshot_ifc_files                       -- expect table + indexes
-- SELECT count(*) FROM materializable_elements;  -- expect 0 in prod today
-- SELECT count(*) FROM snapshot_ifc_files;       -- expect 0
