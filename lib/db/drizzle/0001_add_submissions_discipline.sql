-- PLR-10 / Task #471: tag each plan-review submission with the
-- discipline it targets, so the FindingsTab "Add from library" picker
-- can pre-filter the canned-finding library to the relevant code
-- track. Nullable so legacy rows (and packages where the architect
-- didn't tag a discipline) keep working — the picker falls back to
-- "All" in that case.
ALTER TABLE "submissions"
  ADD COLUMN IF NOT EXISTS "discipline" text;

ALTER TABLE "submissions"
  DROP CONSTRAINT IF EXISTS "submissions_discipline_check";

ALTER TABLE "submissions"
  ADD CONSTRAINT "submissions_discipline_check"
    CHECK ("discipline" IS NULL
           OR "discipline" IN ('building', 'fire', 'zoning', 'civil'));
