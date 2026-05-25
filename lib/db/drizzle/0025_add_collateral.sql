-- Placid collateral export — async PDF jobs, export history, metering stub.

CREATE TABLE IF NOT EXISTS "collateral_export_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "step" text DEFAULT 'preparing' NOT NULL,
  "progress_label" text NOT NULL,
  "request" jsonb NOT NULL,
  "download_url" text,
  "thumbnail_url" text,
  "error_code" text,
  "error_message" text,
  "placid_pdf_id" text,
  "credits_estimated" integer,
  "credits_actual" integer,
  "provider" text DEFAULT 'placid' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "collateral_export_jobs_engagement_created_idx"
  ON "collateral_export_jobs" ("engagement_id", "created_at");

CREATE TABLE IF NOT EXISTS "collateral_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "export_job_id" uuid,
  "template_pack_id" text NOT NULL,
  "template_name" text NOT NULL,
  "status" text DEFAULT 'rendering' NOT NULL,
  "download_url" text,
  "thumbnail_url" text,
  "source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "credits_charged" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "collateral_exports_engagement_created_idx"
  ON "collateral_exports" ("engagement_id", "created_at");

CREATE TABLE IF NOT EXISTS "collateral_metering_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "engagement_id" uuid NOT NULL,
  "export_job_id" uuid NOT NULL,
  "units" integer NOT NULL,
  "provider" text DEFAULT 'placid' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "collateral_metering_events_engagement_idx"
  ON "collateral_metering_events" ("engagement_id", "created_at");
