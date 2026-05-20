-- Cortex L1 (Lane C.4 / C.4.1) — response_tasks table backing the
-- `response-task` atom. Additive: CREATE TABLE only, no ALTER / DROP /
-- RENAME on existing tables.
--
-- One row per response-task: the persistent task state for the
-- client-comment response flow. The row is the single source of truth
-- for current state; the audit chain lives on `atom_events`.

CREATE TABLE IF NOT EXISTS "response_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "state" text DEFAULT 'open' NOT NULL,
  "due_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "source_client_comment_id" text,
  "finding_id" text,
  "actor_id" text,
  "principal_actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "response_tasks_state_check"
    CHECK ("state" IN ('open', 'in-progress', 'done', 'cancelled')),
  CONSTRAINT "response_tasks_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "response_tasks_engagement_created_idx"
  ON "response_tasks" ("engagement_id", "created_at");
