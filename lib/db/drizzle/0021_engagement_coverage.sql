-- Jurisdiction surfacing v2 — honest coverage on engagements + operator queue for QA-20.

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS substrate_jurisdiction_key text,
  ADD COLUMN IF NOT EXISTS cortex_jurisdiction_key text,
  ADD COLUMN IF NOT EXISTS coverage_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS coverage_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS coverage_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  jurisdiction_state text,
  jurisdiction_city text,
  jurisdiction_fips text,
  note text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coverage_requests_open_idx
  ON coverage_requests (status, created_at)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS coverage_requests_engagement_idx
  ON coverage_requests (engagement_id);
