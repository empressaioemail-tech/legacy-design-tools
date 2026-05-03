-- Track 1 — submission classification, reviewer disciplines, finding AI-badge
-- columns. All ALTERs are additive (ADD COLUMN / CREATE TABLE) — no DROP, no
-- RENAME, no TYPE change on populated columns.

-- ---- findings: AI-provenance + first-acceptance attribution -----------------
ALTER TABLE "findings"
  ADD COLUMN IF NOT EXISTS "ai_generated" boolean NOT NULL DEFAULT false;

ALTER TABLE "findings"
  ADD COLUMN IF NOT EXISTS "accepted_by_reviewer_id" text;

ALTER TABLE "findings"
  ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;

-- Backfill: rows produced by the finding-engine carry a finding_run_id;
-- override-revisions and any other human-authored rows do not.
UPDATE "findings"
   SET "ai_generated" = true
 WHERE "finding_run_id" IS NOT NULL
   AND "ai_generated" = false;

-- ---- users: reviewer disciplines (PlanReviewDiscipline[]) -------------------
-- Empty array on every existing row keeps the FE's "Show all" fallback safe;
-- reviewers populate via the admin write surface.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "disciplines" text[] NOT NULL DEFAULT '{}'::text[];

-- Closed-set enforcement at the DB layer. Mirrors PLAN_REVIEW_DISCIPLINE_VALUES
-- in lib/api-zod/src/types/planReviewDiscipline.ts; keep literal in lock-step.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_disciplines_check'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_disciplines_check"
      CHECK ("disciplines" <@ ARRAY['building','electrical','mechanical','plumbing','residential','fire-life-safety','accessibility']::text[]);
  END IF;
END $$;

-- ---- submission_classifications: one-to-one classification atom row ---------
CREATE TABLE IF NOT EXISTS "submission_classifications" (
  "submission_id" uuid PRIMARY KEY REFERENCES "submissions"("id") ON DELETE CASCADE,
  "project_type" text,
  "disciplines" text[] NOT NULL DEFAULT '{}'::text[],
  "applicable_code_books" text[] NOT NULL DEFAULT '{}'::text[],
  "confidence" numeric,
  "source" text NOT NULL DEFAULT 'auto',
  "classified_by" jsonb,
  "classified_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "submission_classifications_source_check"
    CHECK ("source" IN ('auto', 'reviewer')),
  CONSTRAINT "submission_classifications_disciplines_check"
    CHECK ("disciplines" <@ ARRAY['building','electrical','mechanical','plumbing','residential','fire-life-safety','accessibility']::text[])
);

CREATE INDEX IF NOT EXISTS "submission_classifications_disciplines_gin_idx"
  ON "submission_classifications" USING gin ("disciplines");
