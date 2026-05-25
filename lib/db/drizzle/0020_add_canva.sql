-- Canva Connect — OAuth tokens, push jobs, design history.

CREATE TABLE IF NOT EXISTS "canva_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "owner_user_id" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "display_name" text NOT NULL,
  "avatar_url" text,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "canva_connections_tenant_owner_idx"
  ON "canva_connections" ("tenant_id", "owner_user_id");

CREATE TABLE IF NOT EXISTS "canva_oauth_states" (
  "state" text PRIMARY KEY NOT NULL,
  "code_verifier" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "canva_oauth_states_created_idx"
  ON "canva_oauth_states" ("created_at");

CREATE TABLE IF NOT EXISTS "canva_push_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "step" text DEFAULT 'preparing' NOT NULL,
  "progress_label" text NOT NULL,
  "request" jsonb NOT NULL,
  "design_url" text,
  "design_thumbnail_url" text,
  "error_code" text,
  "error_message" text,
  "canva_autofill_job_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "canva_push_jobs_engagement_created_idx"
  ON "canva_push_jobs" ("engagement_id", "created_at");

CREATE TABLE IF NOT EXISTS "canva_design_pushes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "push_job_id" uuid,
  "template_id" text NOT NULL,
  "template_name" text NOT NULL,
  "status" text DEFAULT 'uploading' NOT NULL,
  "thumbnail_url" text,
  "design_url" text,
  "source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "canva_design_pushes_engagement_created_idx"
  ON "canva_design_pushes" ("engagement_id", "created_at");
