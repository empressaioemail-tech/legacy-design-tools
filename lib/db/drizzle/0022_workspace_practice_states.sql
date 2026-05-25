-- QA-59 v1.5 — firm practice regions (US state codes) for Code Library filtering.

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS practice_states jsonb NOT NULL DEFAULT '[]'::jsonb;
