-- Task #503 — `qa_triage_items` queue for the QA dashboard.
--
-- Idempotent so it is safe to re-run on environments that have
-- already had the table created by `drizzle-kit push`.

CREATE TABLE IF NOT EXISTS "qa_triage_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "source_run_id" text,
  "suite_id" text,
  "title" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'error',
  "excerpt" text NOT NULL DEFAULT '',
  "suggested_next_step" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "sent_at" timestamp with time zone,
  "done_at" timestamp with time zone,
  CONSTRAINT "qa_triage_items_source_kind_check"
    CHECK ("source_kind" IN ('autopilot_finding', 'run', 'suite_failure', 'checklist_item')),
  CONSTRAINT "qa_triage_items_status_check"
    CHECK ("status" IN ('open', 'sent', 'done')),
  CONSTRAINT "qa_triage_items_severity_check"
    CHECK ("severity" IN ('info', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS "qa_triage_items_status_idx"
  ON "qa_triage_items" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "qa_triage_items_source_idx"
  ON "qa_triage_items" ("source_kind", "source_id");
