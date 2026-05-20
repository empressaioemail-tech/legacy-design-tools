-- Cortex L5 (Lane C.4 / C.4.5) — product_spec_references table backing
-- the `product-spec-reference` atom. Additive: CREATE TABLE only.
--
-- `status_history` is an append-only JSONB chain of
-- `{ status, changedAt, sourceUrl }` ICC-ES observations.

CREATE TABLE IF NOT EXISTS "product_spec_references" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "product_name" text NOT NULL,
  "product_manufacturer" text NOT NULL,
  "esr_number" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "icc_es_url" text DEFAULT '' NOT NULL,
  "finding_id" text,
  "response_task_id" text,
  "actor_id" text,
  "principal_actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_spec_references_status_check"
    CHECK ("status" IN ('active', 'withdrawn', 'expired')),
  CONSTRAINT "product_spec_references_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "product_spec_references_engagement_created_idx"
  ON "product_spec_references" ("engagement_id", "created_at");
