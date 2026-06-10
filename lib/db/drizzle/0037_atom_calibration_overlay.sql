-- Arrow-two Phase 3: (atomId, jurisdictionTenant) calibration overlay.
-- Covers reasoning atoms AND immutable corpus atoms via canonical atom_id key.
-- Corpus is never mutated — calibration lives here only.

CREATE TABLE IF NOT EXISTS "atom_calibration_overlay" (
  "atom_id" text NOT NULL,
  "jurisdiction_tenant" text NOT NULL,
  "partition_kind" text NOT NULL DEFAULT 'public',
  "access_policy" text NOT NULL DEFAULT 'public-free',
  "shared_with_tenants" jsonb,
  "asserted_confidence" numeric NOT NULL,
  "calibrated_confidence" numeric,
  "code_ref" text,
  "edition" text,
  "source_set_version" integer NOT NULL DEFAULT 1,
  "calibration_stale" boolean NOT NULL DEFAULT false,
  "calibration_grain" text NOT NULL DEFAULT 'atom',
  "atom_class" text,
  "signal_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "atom_calibration_overlay_pk" PRIMARY KEY ("atom_id", "jurisdiction_tenant"),
  CONSTRAINT "atom_calibration_overlay_partition_kind_check"
    CHECK ("partition_kind" IN ('public', 'tenant-private', 'tenant-shared')),
  CONSTRAINT "atom_calibration_overlay_grain_check"
    CHECK ("calibration_grain" IN ('atom', 'class'))
);

CREATE INDEX IF NOT EXISTS "atom_calibration_overlay_tenant_idx"
  ON "atom_calibration_overlay" ("jurisdiction_tenant");

CREATE INDEX IF NOT EXISTS "atom_calibration_overlay_class_idx"
  ON "atom_calibration_overlay" ("jurisdiction_tenant", "atom_class");
