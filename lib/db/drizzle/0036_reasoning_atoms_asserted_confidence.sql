-- Cold-warm field split (0036): asserted confidence owned by cold-warm;
-- calibrated confidence + source-set versioning owned by arrow-two Phase 3 (0037).
-- 0037 is reserved — do not add arrow-two overlay tables here.

ALTER TABLE "reasoning_atoms" RENAME COLUMN "confidence" TO "asserted_confidence";

ALTER TABLE "reasoning_atoms"
  ADD COLUMN IF NOT EXISTS "source_set_version" integer NOT NULL DEFAULT 1;

ALTER TABLE "reasoning_atoms"
  ADD COLUMN IF NOT EXISTS "calibration_stale" boolean NOT NULL DEFAULT false;
