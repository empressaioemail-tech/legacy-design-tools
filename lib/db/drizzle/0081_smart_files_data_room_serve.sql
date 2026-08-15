-- Smart Files data-room serve layer (OPS-17 G-56 / Layer 1.5).
-- Folder registry + non-file record links. Documents/placements unchanged (G-14).

CREATE TABLE IF NOT EXISTS "smart_file_folders" (
  "folder_id" text PRIMARY KEY,
  "scope_type" text NOT NULL,
  "scope_id" text NOT NULL,
  "label" text NOT NULL,
  "access_policy" text NOT NULL,
  "parent_folder_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "smart_file_folders_scope_idx"
  ON "smart_file_folders" ("scope_type", "scope_id");

ALTER TABLE "smart_file_folders"
  ADD CONSTRAINT "smart_file_folders_scope_type_check"
  CHECK ("scope_type" IN ('jurisdiction', 'tenant', 'site'));

ALTER TABLE "smart_file_folders"
  ADD CONSTRAINT "smart_file_folders_access_policy_check"
  CHECK ("access_policy" IN (
    'public-free', 'public-paid', 'platform-internal',
    'tenant-private', 'tenant-shared'
  ));

CREATE TABLE IF NOT EXISTS "smart_file_folder_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "folder_id" text NOT NULL REFERENCES "smart_file_folders"("folder_id") ON DELETE CASCADE,
  "record_entity_id" text NOT NULL,
  "entity_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "access_policy" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "smart_file_folder_records_uniq"
  ON "smart_file_folder_records" ("folder_id", "record_entity_id");

ALTER TABLE "smart_file_folder_records"
  ADD CONSTRAINT "smart_file_folder_records_access_policy_check"
  CHECK ("access_policy" IN (
    'public-free', 'public-paid', 'platform-internal',
    'tenant-private', 'tenant-shared'
  ));
