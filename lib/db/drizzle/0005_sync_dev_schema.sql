-- Task #487 — Sync the dev database with the latest schema.
--
-- The dev database had drifted from the Drizzle schemas in
-- `lib/db/src/schema/*`. Several tables that have existed in code for a
-- while were never applied (findings, finding_runs, submission_comments,
-- submission_communications, reviewer_requests, viewpoint_renders,
-- render_outputs, qa_*, canned_findings, decision_pdf_artifacts,
-- permit_counters, architect_notification_reads), and the `engagements`
-- table was missing the applicant_firm + architect_of_record_* columns
-- introduced in tasks #439 and #475 — which is why /api/engagements was
-- 500ing with `column "applicant_firm" does not exist`.
--
-- The dev DB also still carried a legacy `findings_code_atoms` table
-- that no longer has a Drizzle schema (the join is superseded by the
-- jsonb `citations` column on `findings`). Because drizzle-kit's
-- per-statement diff is purely structural, it kept proposing to RENAME
-- `findings_code_atoms` -> `submission_comments` (both happened to have
-- a similar shape). The correct answer is to drop the empty legacy
-- table and let `submission_comments` be created fresh.
--
-- This migration captures all of that as one idempotent SQL file so
-- any database (dev, fresh-clone, future prod) can be brought in line
-- without going through the interactive `drizzle-kit push` rename
-- prompt. After this migration runs, `pnpm --filter @workspace/db run
-- push` is a no-op.

-- 1. (Deferred — review-required.) The dev DB also still carried a
--    legacy `findings_code_atoms` table that no longer has a Drizzle
--    schema. It was empty in dev, and `drizzle-kit push` keeps wanting
--    to RENAME it to `submission_comments` (wrong — they're unrelated).
--    Per the operating constraints for task #487, destructive ops
--    (DROP TABLE / DROP COLUMN / RENAME) are NOT applied automatically
--    by this migration. Resolve out-of-band:
--      psql "$DATABASE_URL" -c "DROP TABLE IF EXISTS findings_code_atoms;"
--    after confirming the table is empty in the target environment.

-- 2. Backfill engagement columns added in tasks #439 (applicant_firm)
--    and #475 (architect_of_record_*).
ALTER TABLE "engagements"
  ADD COLUMN IF NOT EXISTS "applicant_firm" text,
  ADD COLUMN IF NOT EXISTS "architect_of_record_name" text,
  ADD COLUMN IF NOT EXISTS "architect_of_record_email" text,
  ADD COLUMN IF NOT EXISTS "architect_of_record_role" text;

-- 3. Create the missing tables. All CREATE TABLE / CREATE INDEX
--    statements are guarded with IF NOT EXISTS so this file is safe to
--    re-run.

CREATE TABLE IF NOT EXISTS "architect_notification_reads" (
  "user_id" text PRIMARY KEY,
  "last_read_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "canned_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "discipline" text NOT NULL,
  "title" text NOT NULL,
  "default_body" text NOT NULL,
  "severity" text NOT NULL,
  "category" text NOT NULL,
  "color" text NOT NULL DEFAULT '#6b7280',
  "code_atom_citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canned_findings_discipline_check"
    CHECK ("discipline" IN ('building','fire','zoning','civil')),
  CONSTRAINT "canned_findings_severity_check"
    CHECK ("severity" IN ('blocker','concern','advisory')),
  CONSTRAINT "canned_findings_category_check"
    CHECK ("category" IN ('setback','height','coverage','egress','use','overlay-conflict','divergence-related','other'))
);
CREATE INDEX IF NOT EXISTS "canned_findings_tenant_discipline_idx"
  ON "canned_findings" ("tenant_id", "discipline");

CREATE TABLE IF NOT EXISTS "finding_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submission_id" uuid NOT NULL
    REFERENCES "submissions"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "error" text,
  "invalid_citation_count" integer,
  "invalid_citations" text[],
  "discarded_finding_count" integer
);
CREATE INDEX IF NOT EXISTS "finding_runs_submission_started_idx"
  ON "finding_runs" ("submission_id", "started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "finding_runs_pending_per_submission_uniq"
  ON "finding_runs" ("submission_id") WHERE ("state" = 'pending');

CREATE TABLE IF NOT EXISTS "findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "atom_id" text NOT NULL,
  "submission_id" uuid NOT NULL
    REFERENCES "submissions"("id") ON DELETE CASCADE,
  "severity" text NOT NULL,
  "category" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ai-produced',
  "text" text NOT NULL,
  "citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "confidence" numeric NOT NULL,
  "low_confidence" boolean NOT NULL DEFAULT false,
  "reviewer_status_by" jsonb,
  "reviewer_status_changed_at" timestamptz,
  "reviewer_comment" text,
  "element_ref" text,
  "source_ref" jsonb,
  "ai_generated_at" timestamptz NOT NULL DEFAULT now(),
  "revision_of" uuid REFERENCES "findings"("id") ON DELETE SET NULL,
  "finding_run_id" uuid REFERENCES "finding_runs"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "findings_severity_check"
    CHECK ("severity" IN ('blocker','concern','advisory')),
  CONSTRAINT "findings_category_check"
    CHECK ("category" IN ('setback','height','coverage','egress','use','overlay-conflict','divergence-related','other')),
  CONSTRAINT "findings_status_check"
    CHECK ("status" IN ('ai-produced','accepted','rejected','overridden','promoted-to-architect'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "findings_atom_id_uniq"
  ON "findings" ("atom_id");
CREATE INDEX IF NOT EXISTS "findings_submission_created_idx"
  ON "findings" ("submission_id", "created_at");

CREATE TABLE IF NOT EXISTS "permit_counters" (
  "tenant_id" text NOT NULL,
  "year" integer NOT NULL,
  "last_issued_seq" integer NOT NULL DEFAULT 0,
  CONSTRAINT "permit_counters_tenant_id_year_pk" PRIMARY KEY ("tenant_id", "year")
);

CREATE TABLE IF NOT EXISTS "qa_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "suite_id" text NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "exit_code" integer,
  "log" text NOT NULL DEFAULT '',
  CONSTRAINT "qa_runs_status_check"
    CHECK ("status" IN ('running','passed','failed','errored'))
);
CREATE INDEX IF NOT EXISTS "qa_runs_suite_started_idx"
  ON "qa_runs" ("suite_id", "started_at");

CREATE TABLE IF NOT EXISTS "qa_checklist_results" (
  "checklist_id" text NOT NULL,
  "item_id" text NOT NULL,
  "status" text NOT NULL,
  "note" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "qa_checklist_results_checklist_id_item_id_pk"
    PRIMARY KEY ("checklist_id", "item_id"),
  CONSTRAINT "qa_checklist_results_status_check"
    CHECK ("status" IN ('pass','fail','skip'))
);

CREATE TABLE IF NOT EXISTS "qa_settings" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "viewpoint_renders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "engagement_id" uuid NOT NULL
    REFERENCES "engagements"("id") ON DELETE CASCADE,
  "briefing_id" uuid REFERENCES "parcel_briefings"("id") ON DELETE SET NULL,
  "briefing_atom_event_id" text,
  "bim_model_id" uuid REFERENCES "bim_models"("id") ON DELETE SET NULL,
  "bim_model_atom_event_id" text,
  "kind" text NOT NULL,
  "request_payload" jsonb NOT NULL,
  "status" text NOT NULL,
  "mnml_job_id" text,
  "mnml_jobs" jsonb,
  "error_code" text,
  "error_message" text,
  "error_details" jsonb,
  "requested_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "viewpoint_renders_engagement_created_idx"
  ON "viewpoint_renders" ("engagement_id", "created_at");
CREATE INDEX IF NOT EXISTS "viewpoint_renders_status_idx"
  ON "viewpoint_renders" ("status");

CREATE TABLE IF NOT EXISTS "render_outputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "viewpoint_render_id" uuid NOT NULL
    REFERENCES "viewpoint_renders"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "format" text NOT NULL,
  "resolution" text,
  "size_bytes" integer,
  "duration_seconds" integer,
  "source_url" text NOT NULL,
  "mirrored_object_key" text,
  "mnml_output_id" text,
  "thumbnail_url" text,
  "seed" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "render_outputs_viewpoint_render_idx"
  ON "render_outputs" ("viewpoint_render_id");
CREATE UNIQUE INDEX IF NOT EXISTS "render_outputs_render_role_uniq"
  ON "render_outputs" ("viewpoint_render_id", "role");

CREATE TABLE IF NOT EXISTS "reviewer_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "engagement_id" uuid NOT NULL
    REFERENCES "engagements"("id") ON DELETE CASCADE,
  "request_kind" text NOT NULL,
  "target_entity_type" text NOT NULL,
  "target_entity_id" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "requested_by" jsonb NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "dismissed_by" jsonb,
  "dismissed_at" timestamptz,
  "dismissal_reason" text,
  "withdrawn_by" jsonb,
  "withdrawn_at" timestamptz,
  "withdrawal_reason" text,
  "resolved_at" timestamptz,
  "triggered_action_event_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reviewer_requests_kind_check"
    CHECK ("request_kind" IN ('refresh-briefing-source','refresh-bim-model','regenerate-briefing')),
  CONSTRAINT "reviewer_requests_target_type_check"
    CHECK ("target_entity_type" IN ('briefing-source','bim-model','parcel-briefing')),
  CONSTRAINT "reviewer_requests_status_check"
    CHECK ("status" IN ('pending','dismissed','resolved','withdrawn'))
);
CREATE INDEX IF NOT EXISTS "reviewer_requests_pending_idx"
  ON "reviewer_requests" ("engagement_id", "status", "requested_at");
CREATE INDEX IF NOT EXISTS "reviewer_requests_target_idx"
  ON "reviewer_requests" ("target_entity_type", "target_entity_id", "status");

CREATE TABLE IF NOT EXISTS "submission_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submission_id" uuid NOT NULL
    REFERENCES "submissions"("id") ON DELETE CASCADE,
  "author_role" text NOT NULL,
  "author_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "submission_comments_author_role_check"
    CHECK ("author_role" IN ('architect','reviewer'))
);
CREATE INDEX IF NOT EXISTS "submission_comments_submission_idx"
  ON "submission_comments" ("submission_id", "created_at");

CREATE TABLE IF NOT EXISTS "submission_communications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submission_id" uuid NOT NULL
    REFERENCES "submissions"("id") ON DELETE CASCADE,
  "atom_id" text NOT NULL UNIQUE,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "finding_atom_ids" jsonb NOT NULL,
  "recipient_user_ids" jsonb NOT NULL,
  "sent_by" jsonb NOT NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  "pdf_object_path" text
);
CREATE INDEX IF NOT EXISTS "submission_communications_submission_idx"
  ON "submission_communications" ("submission_id", "sent_at");

CREATE TABLE IF NOT EXISTS "decision_pdf_artifacts" (
  "decision_id" uuid PRIMARY KEY,
  "submission_id" uuid NOT NULL
    REFERENCES "submissions"("id") ON DELETE CASCADE,
  "pdf_artifact_ref" text NOT NULL,
  "permit_number" text NOT NULL,
  "approver_name" text NOT NULL,
  "approval_date" timestamptz NOT NULL,
  "rendered_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "decision_pdf_artifacts_submission_idx"
  ON "decision_pdf_artifacts" ("submission_id", "rendered_at");
