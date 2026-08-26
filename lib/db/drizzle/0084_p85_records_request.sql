-- P-85 Records Request: clerk portal terms + async job rows. No GIS landing tables.

CREATE TABLE IF NOT EXISTS clerk_portal_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_fips text NOT NULL,
  portal_id text NOT NULL,
  portal_url text NOT NULL,
  terms_url text,
  terms_text text NOT NULL,
  terms_fetched_at timestamptz NOT NULL,
  automated_search text NOT NULL DEFAULT 'unknown'
    CHECK (automated_search IN ('permitted', 'tolerated', 'prohibited', 'unknown')),
  login_required boolean NOT NULL DEFAULT false,
  image_purchase jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator_ruled_at timestamptz,
  operator_ruling_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (county_fips, portal_id)
);

CREATE INDEX IF NOT EXISTS clerk_portal_terms_county_idx ON clerk_portal_terms (county_fips);
CREATE INDEX IF NOT EXISTS clerk_portal_terms_portal_idx ON clerk_portal_terms (portal_id);

CREATE TABLE IF NOT EXISTS records_request_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  place_key text,
  user_id text NOT NULL,
  user_email text,
  parcel_key text NOT NULL,
  county_fips text NOT NULL,
  status text NOT NULL,
  request_payload jsonb,
  scope_searched jsonb,
  live_instant_gis jsonb,
  run_cost jsonb,
  recipe_version text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT records_request_jobs_status_check CHECK (
    status IN ('queued', 'running', 'complete', 'failed', 'needs-human', 'awaiting-purchase-approval')
  )
);

CREATE INDEX IF NOT EXISTS records_request_jobs_engagement_created_idx
  ON records_request_jobs (engagement_id, created_at DESC);

CREATE INDEX IF NOT EXISTS records_request_jobs_place_key_idx
  ON records_request_jobs (place_key);

CREATE INDEX IF NOT EXISTS records_request_jobs_status_idx
  ON records_request_jobs (status);

CREATE UNIQUE INDEX IF NOT EXISTS records_request_jobs_active_per_engagement_user_uniq
  ON records_request_jobs (engagement_id, user_id)
  WHERE status IN ('queued', 'running', 'awaiting-purchase-approval');
