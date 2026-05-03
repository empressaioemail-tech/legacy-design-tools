-- Task #486 — QA autopilot orchestration tables.
--
-- These three tables back the QA autopilot feature (task #482):
--   * `autopilot_runs`         — one row per kicked-off run
--   * `autopilot_findings`     — per-suite per-test findings within a run
--   * `autopilot_fix_actions`  — fixer-applied side-effects we may revert
--
-- The Drizzle schemas in lib/db/src/schema/autopilot{Runs,Findings,FixActions}.ts
-- have been present since #482, but the DDL was never applied to the dev
-- database, so `POST /api/qa/autopilot/runs` 500'd with
-- `relation "autopilot_runs" does not exist`. This migration creates the
-- tables (idempotently) so the autopilot endpoints work on any database
-- this migration has been applied to.

CREATE TABLE IF NOT EXISTS "autopilot_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "status" text NOT NULL,
  "trigger" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "total_suites" integer NOT NULL DEFAULT 0,
  "passing" integer NOT NULL DEFAULT 0,
  "failing" integer NOT NULL DEFAULT 0,
  "flaky" integer NOT NULL DEFAULT 0,
  "auto_fixes_applied" integer NOT NULL DEFAULT 0,
  "needs_review" integer NOT NULL DEFAULT 0,
  "notes" text NOT NULL DEFAULT '',
  CONSTRAINT "autopilot_runs_status_check"
    CHECK ("status" IN ('running', 'completed', 'errored')),
  CONSTRAINT "autopilot_runs_trigger_check"
    CHECK ("trigger" IN ('manual', 'auto-on-open'))
);

CREATE INDEX IF NOT EXISTS "autopilot_runs_started_idx"
  ON "autopilot_runs" ("started_at");

CREATE TABLE IF NOT EXISTS "autopilot_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "autopilot_run_id" uuid NOT NULL
    REFERENCES "autopilot_runs"("id") ON DELETE CASCADE,
  "suite_id" text NOT NULL,
  "qa_run_id" uuid,
  "test_name" text,
  "file_path" text,
  "line" integer,
  "error_excerpt" text NOT NULL DEFAULT '',
  "category" text NOT NULL,
  "severity" text NOT NULL,
  "auto_fix_status" text NOT NULL,
  "plain_summary" text NOT NULL DEFAULT '',
  "suggested_diff" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "autopilot_findings_category_check"
    CHECK ("category" IN ('flaky', 'snapshot', 'codegen-stale', 'lint', 'fixture', 'app-code', 'unknown')),
  CONSTRAINT "autopilot_findings_severity_check"
    CHECK ("severity" IN ('info', 'warning', 'error')),
  CONSTRAINT "autopilot_findings_autofix_check"
    CHECK ("auto_fix_status" IN ('auto-fixed', 'needs-review', 'skipped'))
);

CREATE INDEX IF NOT EXISTS "autopilot_findings_run_idx"
  ON "autopilot_findings" ("autopilot_run_id");
CREATE INDEX IF NOT EXISTS "autopilot_findings_suite_idx"
  ON "autopilot_findings" ("suite_id");

CREATE TABLE IF NOT EXISTS "autopilot_fix_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "autopilot_run_id" uuid NOT NULL
    REFERENCES "autopilot_runs"("id") ON DELETE CASCADE,
  "finding_id" uuid
    REFERENCES "autopilot_findings"("id") ON DELETE SET NULL,
  "fixer_id" text NOT NULL,
  "suite_id" text NOT NULL,
  "command" text NOT NULL,
  "files_changed" text NOT NULL DEFAULT '[]',
  "success" boolean NOT NULL DEFAULT false,
  "log" text NOT NULL DEFAULT '',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "autopilot_fix_actions_run_idx"
  ON "autopilot_fix_actions" ("autopilot_run_id");
