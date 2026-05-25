CREATE TABLE IF NOT EXISTS "workspace_settings" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "firm_display_name" text DEFAULT 'Cortex Workspace' NOT NULL,
  "logo_url" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

INSERT INTO "workspace_settings" ("id", "firm_display_name")
VALUES ('default', 'Cortex Workspace')
ON CONFLICT ("id") DO NOTHING;
