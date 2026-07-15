-- Durable plan-review report-run STATE (feat/durable-report-run-state).
--
-- Replaces the three instance-local Maps in
-- artifacts/api-server/src/routes/planReviewBff.ts (inFlightReports,
-- lastReportRunFailure, reportResultCache) with a shared Postgres row so a
-- status GET is correct regardless of which Cloud Run instance answers it.
-- On multi-instance deploys a status GET landing on a different instance than
-- the one that ran the job saw "not-run" even though a sibling held the real
-- running/failed/done record; the #249 watchdog bounded forever-"running" but
-- did not fix cross-instance visibility. Mirrors finding_runs reasoning.
--
-- Keyed (engagement_id, report_type): exactly the pair the status GET queries
-- and every in-memory `${engagementId}:${type}` key was built from. History is
-- not needed (the in-memory model kept only the LATEST running record and
-- LATEST failure per key), so one upsert-target row per pair is the minimal
-- correct shape. Idempotent upserts write run start / completion / failure via
-- ON CONFLICT DO UPDATE on the composite pk.
--
-- This is run STATE, not a result store: materialized results stay in their
-- existing homes (site_topography / site_drainage derived rows; brief / hazard
-- / encumbrances loaders). Only the subsurface + hazard-quota flags that had
-- no other home (old reportResultCache) are carried inline in "result".

CREATE TABLE IF NOT EXISTS "report_run" (
  "engagement_id" text NOT NULL,
  "report_type" text NOT NULL,
  "status" text NOT NULL,
  "generation_id" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text,
  "reason" text,
  "degraded" text,
  "degraded_reason" text,
  "library" text,
  "result" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_run_engagement_id_report_type_pk"
    PRIMARY KEY ("engagement_id", "report_type")
);
