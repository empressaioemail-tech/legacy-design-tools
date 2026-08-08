-- County Manifest observability (feat/manifest-observability-tables).
--
-- Part 2 of 2: durable run-state surface, heavy-scan slot registry, and
-- per-run / per-jurisdiction cost metering. resource_key on slot tables is
-- an extensible string so a parallel Neon advisory-lock lane can layer
-- semantics without a schema rewrite (see manifestObservability.ts header).
--
-- manifest_run
--   One row per factory/onboarding/scoring run, updated at stage boundaries.
--   Backs the mockup LIVE tab (lane, cohort, stage, progress, artifact).
--
-- manifest_slot_reservation + manifest_slot_queue
--   Queryable heavy-scan slot holder + strictly ordered wait queue.
--
-- manifest_jurisdiction_cost
--   Dual cost counters per county: commitment_cost_usd (first successful
--   acquisition pass only — re-warms excluded per operator ruling 2026-08-08)
--   and lifetime_cost_usd (all runs including re-warms).

CREATE TABLE IF NOT EXISTS manifest_run (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane                      text NOT NULL,
  job                       text NOT NULL,
  target_fips               text,
  target_city               text,
  cohort                    text,
  scope_label               text,
  stage                     text NOT NULL,
  status                    text NOT NULL DEFAULT 'running',
  outcome                   text,
  started_at                timestamptz NOT NULL DEFAULT now(),
  heartbeat_at              timestamptz NOT NULL DEFAULT now(),
  completed_at              timestamptz,
  items_done                integer,
  items_total               integer,
  holds_heavy_slot          boolean NOT NULL DEFAULT false,
  artifact_path             text,
  compute_seconds           numeric(12, 3),
  db_seconds                numeric(12, 3),
  egress_bytes              bigint,
  external_api_calls        integer,
  human_minutes             numeric(8, 2),
  cost_usd                  numeric(10, 2),
  run_class                 text NOT NULL DEFAULT 'other',
  counts_toward_commitment  boolean NOT NULL DEFAULT false,
  notes                     text,
  CONSTRAINT manifest_run_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT manifest_run_run_class_check
    CHECK (run_class IN ('acquisition', 'rewarm', 'verify', 'score', 'other'))
);

CREATE INDEX IF NOT EXISTS manifest_run_status_heartbeat_idx
  ON manifest_run (status, heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS manifest_run_lane_started_idx
  ON manifest_run (lane, started_at DESC);

CREATE INDEX IF NOT EXISTS manifest_run_target_fips_idx
  ON manifest_run (target_fips)
  WHERE target_fips IS NOT NULL;

-- At most one non-terminal run may hold the heavy-scan slot flag at a time.
-- Application layer enforces via manifest_slot_reservation; this partial
-- index is a backstop against double-hold bugs.
CREATE UNIQUE INDEX IF NOT EXISTS manifest_run_active_heavy_slot_uniq
  ON manifest_run (holds_heavy_slot)
  WHERE holds_heavy_slot = true AND status = 'running';

CREATE TABLE IF NOT EXISTS manifest_slot_reservation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_key    text NOT NULL,
  holder_run_id   uuid NOT NULL,
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  CONSTRAINT manifest_slot_reservation_holder_run_id_fk
    FOREIGN KEY (holder_run_id) REFERENCES manifest_run (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS manifest_slot_reservation_active_uniq
  ON manifest_slot_reservation (resource_key)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS manifest_slot_reservation_holder_idx
  ON manifest_slot_reservation (holder_run_id);

CREATE TABLE IF NOT EXISTS manifest_slot_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_key    text NOT NULL,
  run_id          uuid NOT NULL,
  queue_position  integer NOT NULL,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  dequeued_at     timestamptz,
  CONSTRAINT manifest_slot_queue_run_id_fk
    FOREIGN KEY (run_id) REFERENCES manifest_run (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS manifest_slot_queue_active_position_uniq
  ON manifest_slot_queue (resource_key, queue_position)
  WHERE dequeued_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS manifest_slot_queue_active_run_uniq
  ON manifest_slot_queue (resource_key, run_id)
  WHERE dequeued_at IS NULL;

CREATE INDEX IF NOT EXISTS manifest_slot_queue_resource_enqueued_idx
  ON manifest_slot_queue (resource_key, enqueued_at)
  WHERE dequeued_at IS NULL;

CREATE TABLE IF NOT EXISTS manifest_jurisdiction_cost (
  county_fips                   text PRIMARY KEY,
  commitment_cost_usd           numeric(10, 2),
  lifetime_cost_usd             numeric(10, 2) NOT NULL DEFAULT 0,
  first_acquisition_run_id      uuid,
  first_acquisition_recorded_at timestamptz,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manifest_jurisdiction_cost_first_acquisition_run_id_fk
    FOREIGN KEY (first_acquisition_run_id) REFERENCES manifest_run (id) ON DELETE SET NULL
);

-- Back-reference run_id on history + verification tables (0071).
ALTER TABLE rail_state_history
  ADD CONSTRAINT rail_state_history_run_id_fk
    FOREIGN KEY (run_id) REFERENCES manifest_run (id) ON DELETE SET NULL;

ALTER TABLE rail_verification
  ADD CONSTRAINT rail_verification_run_id_fk
    FOREIGN KEY (run_id) REFERENCES manifest_run (id) ON DELETE SET NULL;
