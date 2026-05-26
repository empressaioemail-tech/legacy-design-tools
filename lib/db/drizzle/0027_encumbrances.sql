-- ADR-020 Phase 1 — engagement-scoped recorded instruments + restriction clauses (R4 upload).

CREATE TABLE IF NOT EXISTS "recorded_instruments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "instrument_did" text NOT NULL,
  "instrument_type" text NOT NULL,
  "recording" jsonb,
  "issuer_actor_did" text NOT NULL,
  "source_document_cid" text NOT NULL,
  "applies_to" jsonb NOT NULL,
  "access_policy" text DEFAULT 'tenant-private' NOT NULL,
  "legal_weight" text DEFAULT 'recorded' NOT NULL,
  "verification_status" text DEFAULT 'machine' NOT NULL,
  "extracted_at" timestamp with time zone NOT NULL,
  "source_adapter" text NOT NULL,
  "source_object_path" text NOT NULL,
  "upload_original_filename" text,
  "upload_content_type" text,
  "upload_byte_size" integer,
  "extract_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recorded_instruments_engagement_idx"
  ON "recorded_instruments" ("engagement_id");

CREATE TABLE IF NOT EXISTS "restriction_clauses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instrument_id" uuid NOT NULL,
  "clause_did" text NOT NULL,
  "parent_instrument_cid" text NOT NULL,
  "clause_path" text NOT NULL,
  "body_text" text NOT NULL,
  "structured_fields" jsonb,
  "confidence" numeric(4, 3) NOT NULL,
  "extracted_by" text NOT NULL,
  "human_verified_at" timestamp with time zone,
  "verified_by_actor_did" text,
  "access_policy" text DEFAULT 'tenant-private' NOT NULL,
  "legal_weight" text DEFAULT 'recorded' NOT NULL,
  "reasoning_summary" text,
  "source_citation" text NOT NULL,
  "evaluated_at" timestamp with time zone NOT NULL,
  "source_page" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "restriction_clauses_instrument_idx"
  ON "restriction_clauses" ("instrument_id");

ALTER TABLE "recorded_instruments"
  ADD CONSTRAINT "recorded_instruments_engagement_id_engagements_id_fk"
  FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE;

ALTER TABLE "restriction_clauses"
  ADD CONSTRAINT "restriction_clauses_instrument_id_recorded_instruments_id_fk"
  FOREIGN KEY ("instrument_id") REFERENCES "recorded_instruments"("id") ON DELETE CASCADE;
