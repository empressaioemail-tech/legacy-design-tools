-- Cortex L3 (Lane C.4 / C.4.3) — deliverable_letters table backing the
-- `deliverable-letter` atom. Additive: CREATE TABLE only.
--
-- The `sections` JSONB column carries the ordered LetterSection[]
-- (each `{ kind, heading, content, provenance }`). Section-targeted
-- endpoints address sections by zero-based array index.

CREATE TABLE IF NOT EXISTS "deliverable_letters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "recipient_actor_id" text,
  "sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "actor_id" text,
  "principal_actor_id" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deliverable_letters_status_check"
    CHECK ("status" IN ('draft', 'sent')),
  CONSTRAINT "deliverable_letters_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "deliverable_letters_engagement_created_idx"
  ON "deliverable_letters" ("engagement_id", "created_at");
