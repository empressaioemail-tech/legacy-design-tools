-- Workspace product settings — jurisdictions, presentation, storage policy.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
