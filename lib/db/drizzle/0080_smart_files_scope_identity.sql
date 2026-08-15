-- Smart Files scope-keyed identity (OPS-17 G-10 / G-14 L1 completion).
--
-- Adds scope_type and scope_id to smart_file_documents; makes jurisdiction_fips
-- nullable (populated only when scope_type = jurisdiction). Does NOT rewrite
-- 0078 or 0079. Empty-table safe: columns added nullable, backfill if rows
-- exist, then SET NOT NULL on the new identity columns.

ALTER TABLE IF EXISTS "smart_file_documents"
  ADD COLUMN IF NOT EXISTS "scope_type" text,
  ADD COLUMN IF NOT EXISTS "scope_id" text;

-- Backfill from legacy three-segment entity_id shape if any rows exist.
UPDATE "smart_file_documents"
   SET "scope_type" = 'jurisdiction',
       "scope_id" = split_part("entity_id", ':', 2)
 WHERE "scope_type" IS NULL
   AND "entity_id" LIKE 'smartfile:%:%'
   AND array_length(string_to_array("entity_id", ':'), 1) = 3
   AND split_part("entity_id", ':', 2) ~ '^[0-9]{5,10}$';

-- Backfill from four-or-more-segment scope-keyed shape if any rows exist.
UPDATE "smart_file_documents"
   SET "scope_type" = split_part("entity_id", ':', 2),
       "scope_id" = array_to_string(
         (string_to_array("entity_id", ':'))[3:array_length(string_to_array("entity_id", ':'), 1) - 1],
         ':'
       )
 WHERE "scope_type" IS NULL
   AND "entity_id" LIKE 'smartfile:%:%:%'
   AND split_part("entity_id", ':', 2) IN ('jurisdiction', 'tenant', 'site');

ALTER TABLE IF EXISTS "smart_file_documents"
  ALTER COLUMN "scope_type" SET NOT NULL,
  ALTER COLUMN "scope_id" SET NOT NULL;

ALTER TABLE IF EXISTS "smart_file_documents"
  ALTER COLUMN "jurisdiction_fips" DROP NOT NULL;

UPDATE "smart_file_documents"
   SET "jurisdiction_fips" = "scope_id"
 WHERE "scope_type" = 'jurisdiction'
   AND "jurisdiction_fips" IS DISTINCT FROM "scope_id";

UPDATE "smart_file_documents"
   SET "jurisdiction_fips" = NULL
 WHERE "scope_type" <> 'jurisdiction'
   AND "jurisdiction_fips" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'smart_file_documents_scope_type_check'
  ) THEN
    ALTER TABLE "smart_file_documents"
      ADD CONSTRAINT "smart_file_documents_scope_type_check"
      CHECK ("scope_type" IN ('jurisdiction', 'tenant', 'site'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "smart_file_documents_scope_identity_uniq"
  ON "smart_file_documents" ("scope_type", "scope_id", "doc_slug");

CREATE INDEX IF NOT EXISTS "smart_file_documents_scope_idx"
  ON "smart_file_documents" ("scope_type", "scope_id", "doc_slug");
