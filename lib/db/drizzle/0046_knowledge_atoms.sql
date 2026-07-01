-- Wave 1 — verified-absence / knowledge claim atoms (claim_type open text + ingest validation).
CREATE TABLE IF NOT EXISTS "knowledge_atoms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" text NOT NULL,
  "claim_type" text NOT NULL,
  "source_key" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "access_policy" text NOT NULL,
  "confidence" numeric(5, 4) NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_to" timestamp with time zone,
  "knowledge_at" timestamp with time zone NOT NULL,
  "dedup_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "knowledge_atoms_subject_claim_idx"
  ON "knowledge_atoms" ("subject_id", "claim_type");

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_atoms_dedup_key_uniq"
  ON "knowledge_atoms" ("dedup_key")
  WHERE "dedup_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "knowledge_atoms_knowledge_at_idx"
  ON "knowledge_atoms" ("knowledge_at");
