-- Task #477 — `sheets.content_body` (vision-extracted sheet text).
--
-- The Drizzle schema in lib/db/src/schema/sheets.ts has carried the
-- `contentBody: text("content_body")` column since #477 but no SQL
-- migration was ever authored, so any DB the schema reaches via a
-- migration runner (rather than `drizzle-kit push`) was missing the
-- column. This surfaced as Revit Send-Snapshot failing with
--   "db insert failed for sheet A0.0 ... column \"content_body\" does
--    not exist"
-- on the deployed Neon DB. Idempotent so it is safe to re-run.

ALTER TABLE "sheets" ADD COLUMN IF NOT EXISTS "content_body" text;
