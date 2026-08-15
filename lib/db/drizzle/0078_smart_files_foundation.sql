-- Smart Files — the city-file-system artifact store (OPS-17 PLAN-ROW G-14).
--
-- A NEW family (amendment A-012). Nothing here touches `brokerage_workspaces`
-- or `brokerage_workspace_attachments`; the brokerage rename is a separate
-- backlogged lane.
--
-- Three tables because the promise forces the shape.
-- `brokerage_workspace_attachments` has 8 columns and a single NOT NULL FK to
-- ONE workspace on cascade delete, with no updated_at, no version, no cid, no
-- access_policy. So "a document lives once and appears everywhere it belongs"
-- is impossible there (one row, one parent → N placements means N copies), and
-- "revise once, prior version still there" has no schema there at all (insert
-- and delete only). Here: documents hold identity, versions hold content
-- append-only, placements hold location many-to-many.
--
-- Placements reference the DOCUMENT, never a version, so one revision is
-- current at every placement with no per-placement write that could partially
-- fail.

CREATE TABLE IF NOT EXISTS "smart_file_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The DECLARED entityId (`smartfile:<jurisdictionFips>:<docSlug>`), stored
  -- exactly as the builder produced it. Never reconstructed by a reader.
  "entity_id" text NOT NULL,
  "jurisdiction_fips" text NOT NULL,
  "doc_slug" text NOT NULL,
  "title" text NOT NULL,
  -- ADR-017 five-value union, resolved at READ time. Per-tenant ENFORCEMENT is
  -- gated on the auth/tenancy leg (G-11 / S-1) and is not claimed here.
  "access_policy" text NOT NULL,
  -- Which version is current. Moved by a revision; superseded version rows are
  -- never touched.
  "current_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- One of the four columns the brokerage table provably lacks.
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "smart_file_documents_access_policy_check"
    CHECK ("access_policy" IN ('public-free', 'public-paid', 'platform-internal', 'tenant-private', 'tenant-shared')),
  CONSTRAINT "smart_file_documents_current_version_check"
    CHECK ("current_version" >= 1)
);

-- The store-once guarantee, enforced by the DATABASE rather than by caller
-- discipline: one row per declared entityId.
CREATE UNIQUE INDEX IF NOT EXISTS "smart_file_documents_entity_id_uniq"
  ON "smart_file_documents" ("entity_id");
CREATE INDEX IF NOT EXISTS "smart_file_documents_jurisdiction_idx"
  ON "smart_file_documents" ("jurisdiction_fips", "doc_slug");
CREATE INDEX IF NOT EXISTS "smart_file_documents_access_policy_idx"
  ON "smart_file_documents" ("access_policy");

-- APPEND-ONLY. A revision INSERTS here and moves the document pointer; it never
-- updates or deletes a row, so history survives by construction.
CREATE TABLE IF NOT EXISTS "smart_file_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL
    REFERENCES "smart_file_documents"("id") ON DELETE CASCADE,
  "document_entity_id" text NOT NULL,
  "version" integer NOT NULL,
  -- CID minted by the engine document-ingest pinBlob (content-hash idempotent).
  -- Changes per revision, which is why the DOCUMENT is keyed by entity_id and
  -- never by cid.
  "content_cid" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" bigint NOT NULL,
  -- { sourceUri, sourceLabel, retrievedAt, sourceVintage }. NOT NULL: an
  -- unsourced city document is a rumor, and an optional provenance makes
  -- "nobody set it" indistinguishable from "there isn't one".
  "provenance" jsonb NOT NULL,
  -- Half the freshness stamp. `servedAt` is a property of the READ and is
  -- stamped there, never stored.
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A POSITIVE record of supersession rather than an inference from the
  -- document pointer. NULL while current.
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "smart_file_versions_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "smart_file_versions_doc_version_uniq"
  ON "smart_file_versions" ("document_id", "version");
CREATE INDEX IF NOT EXISTS "smart_file_versions_document_idx"
  ON "smart_file_versions" ("document_id", "version");
CREATE INDEX IF NOT EXISTS "smart_file_versions_content_cid_idx"
  ON "smart_file_versions" ("content_cid");

-- Many-to-many placement. THIS is the structural difference from
-- `brokerage_workspace_attachments`: many placements per document and many
-- documents per target, so placing a document again adds a row here rather than
-- copying the document or its bytes.
CREATE TABLE IF NOT EXISTS "smart_file_placements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL
    REFERENCES "smart_file_documents"("id") ON DELETE CASCADE,
  "document_entity_id" text NOT NULL,
  "target_type" text NOT NULL,
  -- The target's id AS THAT TARGET'S WRITER PERSISTS IT. Opaque here: never
  -- parsed, never reconstructed by this family.
  "target_id" text NOT NULL,
  "placed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- NULL is a positive "no actor recorded", not "unknown".
  "placed_by" text,
  CONSTRAINT "smart_file_placements_target_type_check"
    CHECK ("target_type" IN ('folder', 'parcel', 'project', 'asset', 'permit', 'meeting'))
);

-- Idempotent placement: placing the same document at the same target twice
-- conflicts rather than creating a second placement. Without this, "placed in
-- three locations" could read as four.
CREATE UNIQUE INDEX IF NOT EXISTS "smart_file_placements_uniq"
  ON "smart_file_placements" ("document_id", "target_type", "target_id");
CREATE INDEX IF NOT EXISTS "smart_file_placements_document_idx"
  ON "smart_file_placements" ("document_id");
CREATE INDEX IF NOT EXISTS "smart_file_placements_target_idx"
  ON "smart_file_placements" ("target_type", "target_id");
