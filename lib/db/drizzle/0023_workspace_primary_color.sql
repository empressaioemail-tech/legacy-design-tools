-- QA-57 / workspace branding — accent color for workspace-scoped UI chrome.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS primary_color text;
