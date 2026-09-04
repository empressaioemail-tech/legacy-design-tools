-- P-85 WDLL item 14 — daily portal canary status on clerk_portal_terms.

ALTER TABLE clerk_portal_terms
  ADD COLUMN IF NOT EXISTS canary_status text
    CHECK (canary_status IN ('ok', 'lookup-failed')),
  ADD COLUMN IF NOT EXISTS canary_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS canary_failure_reason text,
  ADD COLUMN IF NOT EXISTS canary_recipe_version text;

CREATE INDEX IF NOT EXISTS clerk_portal_terms_canary_status_idx
  ON clerk_portal_terms (canary_status)
  WHERE canary_status IS NOT NULL;
