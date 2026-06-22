-- ICC PoC — persist formal reference bibliography on finding runs.
ALTER TABLE "finding_runs"
  ADD COLUMN IF NOT EXISTS "code_references" jsonb;
