-- WS1 plan-set decomposition — per-piece discipline classification +
-- finding discipline tag for orchestrated specialist passes.

CREATE TABLE IF NOT EXISTS "plan_set_piece_classifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "submission_id" uuid NOT NULL,
  "piece_kind" text NOT NULL,
  "piece_id" uuid NOT NULL,
  "discipline" text NOT NULL,
  "confidence" numeric NOT NULL,
  "source" text DEFAULT 'rule' NOT NULL,
  "classified_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plan_set_piece_classifications_submission_id_submissions_id_fk"
    FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE cascade,
  CONSTRAINT "plan_set_piece_classifications_piece_kind_check"
    CHECK ("piece_kind" IN ('sheet', 'attached-document')),
  CONSTRAINT "plan_set_piece_classifications_source_check"
    CHECK ("source" IN ('rule', 'llm')),
  CONSTRAINT "plan_set_piece_classifications_discipline_check"
    CHECK ("discipline" IN (
      'building', 'electrical', 'mechanical', 'plumbing',
      'residential', 'fire-life-safety', 'accessibility'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS "plan_set_piece_classifications_piece_unique"
  ON "plan_set_piece_classifications" ("piece_kind", "piece_id");

CREATE INDEX IF NOT EXISTS "plan_set_piece_classifications_submission_idx"
  ON "plan_set_piece_classifications" ("submission_id");

ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "discipline" text;

ALTER TABLE "findings" DROP CONSTRAINT IF EXISTS "findings_discipline_check";

ALTER TABLE "findings" ADD CONSTRAINT "findings_discipline_check"
  CHECK (
    "discipline" IS NULL OR "discipline" IN (
      'building', 'electrical', 'mechanical', 'plumbing',
      'residential', 'fire-life-safety', 'accessibility'
    )
  );
