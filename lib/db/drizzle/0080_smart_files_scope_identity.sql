-- Smart Files scope-keyed identity (OPS-17 G-10 / G-14 L1 completion).
--
-- Adds scope_type and scope_id to smart_file_documents; makes jurisdiction_fips
-- nullable on documents and absence determinations (populated only when
-- scope_type = jurisdiction). Does NOT rewrite 0078 or 0079. Empty-table safe:
-- columns added nullable, backfill if rows exist, then SET NOT NULL on the new
-- identity columns.

ALTER TABLE IF EXISTS "smart_file_documents"
  ADD COLUMN IF NOT EXISTS "scope_type" text,
  ADD COLUMN IF NOT EXISTS "scope_id" text;

-- Backfill legacy three-segment entity_id rows: rewrite entity_id to the declared
-- four-segment form so storage never persists a string the parser returns null
-- for. Empty deployment makes this safe.
UPDATE "smart_file_documents"
   SET "scope_type" = 'jurisdiction',
       "scope_id" = split_part("entity_id", ':', 2),
       "entity_id" = 'smartfile:jurisdiction:' || split_part("entity_id", ':', 2) || ':' || "doc_slug"
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

-- Keep denormalized document_entity_id on child rows in sync after any rewrite.
UPDATE "smart_file_versions" v
   SET "document_entity_id" = d."entity_id"
  FROM "smart_file_documents" d
 WHERE v."document_id" = d."id"
   AND v."document_entity_id" IS DISTINCT FROM d."entity_id";

UPDATE "smart_file_placements" p
   SET "document_entity_id" = d."entity_id"
  FROM "smart_file_documents" d
 WHERE p."document_id" = d."id"
   AND p."document_entity_id" IS DISTINCT FROM d."entity_id";

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

-- Absence determinations: nullable jurisdiction_fips (tenant/site have no FIPS).
ALTER TABLE IF EXISTS "smart_file_absence_determinations"
  ALTER COLUMN "jurisdiction_fips" DROP NOT NULL;

UPDATE "smart_file_absence_determinations"
   SET "jurisdiction_fips" = NULL
 WHERE "jurisdiction_fips" = '';

-- Rewrite legacy three-segment absence entity_id rows to declared form.
UPDATE "smart_file_absence_determinations"
   SET "entity_id" = 'smartfile:jurisdiction:' || split_part("entity_id", ':', 2) || ':' || "doc_slug",
       "jurisdiction_fips" = split_part("entity_id", ':', 2)
 WHERE "entity_id" LIKE 'smartfile:%:%'
   AND array_length(string_to_array("entity_id", ':'), 1) = 3
   AND split_part("entity_id", ':', 2) ~ '^[0-9]{5,10}$';
