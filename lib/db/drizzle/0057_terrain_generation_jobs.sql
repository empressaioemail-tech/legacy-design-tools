-- Async parcel-terrain generation jobs (feat/async-terrain-job).
--
-- The site-topography ingest worker (DEM -> gridded triangle mesh -> GLB ->
-- ifcopenshell IFC) used to run SYNCHRONOUSLY inside the
-- POST .../site-topography/refresh request handler. The mesh build is a nested
-- per-pixel loop on the Node main thread and the IFC author spawns a Python
-- sidecar; on the shared 2-CPU cortex-api container both pegged the cores and
-- starved the co-scheduled 29s brief request -> Cloud Run "malformed response"
-- 503s. This table backs the async fix: the refresh route inserts a `queued`
-- row and returns 202 immediately; a fire-and-forget worker (the viewpoint_renders
-- pattern) runs the ingest off the request path and drives `status` to a
-- terminal state; the read route reports that status so the Brief can poll.
--
-- Identity: `id` IS the public jobId (mirrors briefing_generation_jobs /
-- viewpoint_renders whose PK doubles as the job id).
--
-- Single-flight: the partial unique index on (engagement_id) WHERE status in
-- ('queued','generating') guarantees at most one active authoring run per
-- engagement; a concurrent refresh loses on the unique-violation and the route
-- returns the existing active job's id instead of launching a second run —
-- exactly the CPU contention being removed.
--
-- Orphan rescue + retention: the sweeper at
-- artifacts/api-server/src/lib/terrainGenerationJobsSweep.ts fails
-- queued/generating rows older than a wall-clock threshold (crash/deploy
-- restart) and reaps old terminal rows, keyed off the status index.

CREATE TABLE IF NOT EXISTS "terrain_generation_jobs" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "engagement_id" uuid NOT NULL,
  "place_key" text,
  "request_payload" jsonb,
  "status" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "materializable_element_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "terrain_generation_jobs"
    ADD CONSTRAINT "terrain_generation_jobs_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "terrain_generation_jobs"
    ADD CONSTRAINT "terrain_generation_jobs_materializable_element_id_materializable_elements_id_fk"
    FOREIGN KEY ("materializable_element_id") REFERENCES "materializable_elements"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "terrain_generation_jobs_engagement_created_idx"
  ON "terrain_generation_jobs" ("engagement_id", "created_at");

CREATE INDEX IF NOT EXISTS "terrain_generation_jobs_place_key_idx"
  ON "terrain_generation_jobs" ("place_key");

CREATE INDEX IF NOT EXISTS "terrain_generation_jobs_status_idx"
  ON "terrain_generation_jobs" ("status");

-- Single-flight: at most one queued/generating job per engagement.
CREATE UNIQUE INDEX IF NOT EXISTS "terrain_generation_jobs_active_per_engagement_uniq"
  ON "terrain_generation_jobs" ("engagement_id")
  WHERE "status" in ('queued', 'generating');
