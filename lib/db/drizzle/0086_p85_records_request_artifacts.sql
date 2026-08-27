-- P-85 WDLL item 6 — per-instrument acquisition artifacts for Records Request runs.

CREATE TABLE IF NOT EXISTS records_request_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES records_request_jobs(id) ON DELETE CASCADE,
  portal_id text NOT NULL,
  recording_ref text,
  document_type text,
  recording_date text,
  parties text,
  acquisition_method text NOT NULL
    CHECK (acquisition_method IN ('download', 'purchase', 'capture', 'human')),
  content_sha256 text NOT NULL,
  byte_size integer,
  purchase_cost_cents integer,
  detail_url text,
  storage_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS records_request_artifacts_job_idx
  ON records_request_artifacts (job_id, created_at);

CREATE INDEX IF NOT EXISTS records_request_artifacts_sha256_idx
  ON records_request_artifacts (content_sha256);
