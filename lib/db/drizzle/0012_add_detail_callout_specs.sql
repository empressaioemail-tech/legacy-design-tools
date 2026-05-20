-- Cortex L4 (Lane C.4 / C.4.4) — detail_callout_specs table backing the
-- `detail-callout-spec` atom. Additive: CREATE TABLE only.
--
-- The `spec` JSONB column carries the discriminated-union payload keyed
-- on `detailType`; the route validates it against the engine
-- DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA before persisting.

CREATE TABLE IF NOT EXISTS "detail_callout_specs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "spec" jsonb NOT NULL,
  "push_state" text DEFAULT 'pending' NOT NULL,
  "aps_task_ref" text,
  "finding_id" text,
  "response_task_id" text,
  "actor_id" text,
  "principal_actor_id" text,
  "pushed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "detail_callout_specs_push_state_check"
    CHECK ("push_state" IN ('pending', 'pushed', 'applied', 'rejected-by-user')),
  CONSTRAINT "detail_callout_specs_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "detail_callout_specs_engagement_created_idx"
  ON "detail_callout_specs" ("engagement_id", "created_at");
