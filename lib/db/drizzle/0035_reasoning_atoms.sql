-- v2 reasoning-atom grounding — Hauska stores reasoning + deeplinks, NOT verbatim code text.
-- Distinct from public code_atoms catalog; platform-internal access only.

CREATE TABLE IF NOT EXISTS "reasoning_atoms" (
  "id" text PRIMARY KEY NOT NULL,
  "jurisdiction_key" text NOT NULL,
  "code_ref" text NOT NULL,
  "edition" text NOT NULL,
  "edition_slug" text NOT NULL,
  "sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reasoning" text,
  "confidence" numeric NOT NULL,
  "verification_state" text NOT NULL,
  "snippet" text,
  "display_mode" text DEFAULT 'deeplink' NOT NULL,
  "calibrated_confidence" numeric,
  "access_policy" text DEFAULT 'platform-internal' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reasoning_atoms_verification_state_check"
    CHECK ("verification_state" IN ('verified', 'unverified-web-source')),
  CONSTRAINT "reasoning_atoms_display_mode_check"
    CHECK ("display_mode" IN ('deeplink', 'licensed')),
  CONSTRAINT "reasoning_atoms_access_policy_check"
    CHECK ("access_policy" IN ('platform-internal', 'tenant-scoped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "reasoning_atoms_jurisdiction_ref_edition_unique"
  ON "reasoning_atoms" ("jurisdiction_key", "code_ref", "edition");

CREATE INDEX IF NOT EXISTS "reasoning_atoms_jurisdiction_idx"
  ON "reasoning_atoms" ("jurisdiction_key");
