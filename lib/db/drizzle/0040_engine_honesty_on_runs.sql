-- Persist engine-api honesty envelope on async reasoning runs (findings + briefing).

ALTER TABLE "finding_runs"
  ADD COLUMN IF NOT EXISTS "engine_honesty" jsonb;

ALTER TABLE "briefing_generation_jobs"
  ADD COLUMN IF NOT EXISTS "engine_honesty" jsonb;
