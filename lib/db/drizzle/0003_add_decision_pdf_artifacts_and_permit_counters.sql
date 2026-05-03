-- PLR-11: derived-state side tables.
--
-- `decision_pdf_artifacts`: keyed by the decision-event entity id.
-- The recorded event payload stays artifact-free (so its chain hash
-- doesn't need a back-fill rewrite); the decision atom's
-- contextSummary joins this table to expose pdfArtifactRef /
-- permitNumber / approverName.
--
-- `permit_counters`: atomic tenant-scoped sequence used by the
-- decisions route. Increments via INSERT ... ON CONFLICT DO UPDATE
-- RETURNING so concurrent approvals serialize on the row lock.
CREATE TABLE IF NOT EXISTS "decision_pdf_artifacts" (
  "decision_id" uuid PRIMARY KEY,
  "submission_id" uuid NOT NULL REFERENCES "submissions"("id") ON DELETE CASCADE,
  "pdf_artifact_ref" text NOT NULL,
  "permit_number" text NOT NULL,
  "approver_name" text NOT NULL,
  "approval_date" timestamptz NOT NULL,
  "rendered_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "decision_pdf_artifacts_submission_idx"
  ON "decision_pdf_artifacts" ("submission_id", "rendered_at");

CREATE TABLE IF NOT EXISTS "permit_counters" (
  "tenant_id" text NOT NULL,
  "year" integer NOT NULL,
  "last_issued_seq" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("tenant_id", "year")
);
