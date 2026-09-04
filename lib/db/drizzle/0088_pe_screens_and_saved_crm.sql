-- P-91 / P-92 Wave B (items 17-20, 28-30). Next number after origin/main
-- 0087_p85_portal_canary.sql. leave_behind: not applied to live Neon.

CREATE TABLE IF NOT EXISTS pe_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  owner_user_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS pe_screens_owner_updated_idx
  ON pe_screens (tenant_id, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pe_screen_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id uuid NOT NULL REFERENCES pe_screens(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  query text NOT NULL,
  parcel_node_id text,
  resolution text NOT NULL,
  source text NOT NULL,
  candidates jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_screen_rows_resolution_chk
    CHECK (resolution IN ('resolved', 'ambiguous', 'unresolved')),
  CONSTRAINT pe_screen_rows_source_chk
    CHECK (source IN ('pasted', 'chrome', 'gmail', 'file', 'walk', 'saved')),
  CONSTRAINT pe_screen_rows_resolved_node_chk
    CHECK ((resolution = 'resolved') = (parcel_node_id IS NOT NULL)),
  CONSTRAINT pe_screen_rows_ambiguous_candidates_chk
    CHECK (
      (resolution = 'ambiguous')
      =
      (
        candidates IS NOT NULL
        AND jsonb_typeof(candidates) = 'array'
        AND jsonb_array_length(candidates) > 0
      )
    ),
  CONSTRAINT pe_screen_rows_query_present_chk
    CHECK (char_length(btrim(query)) > 0)
);

CREATE INDEX IF NOT EXISTS pe_screen_rows_screen_ordinal_idx
  ON pe_screen_rows (screen_id, ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS pe_screen_rows_screen_node_uidx
  ON pe_screen_rows (screen_id, parcel_node_id)
  WHERE parcel_node_id IS NOT NULL;

ALTER TABLE pe_saved_properties
  ADD COLUMN IF NOT EXISTS crm_status text,
  ADD COLUMN IF NOT EXISTS note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pe_saved_properties_crm_status_chk'
  ) THEN
    ALTER TABLE pe_saved_properties
      ADD CONSTRAINT pe_saved_properties_crm_status_chk
      CHECK (
        crm_status IS NULL
        OR crm_status IN ('New', 'Watching', 'Chasing', 'Passed')
      );
  END IF;
END $$;
