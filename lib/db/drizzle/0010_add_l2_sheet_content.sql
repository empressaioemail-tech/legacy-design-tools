-- Cortex L2 (Lane C.4 / C.4.2) — sheet_content_extractions +
-- attached_documents tables backing the `sheet-content-extraction` and
-- `attached-document` atoms. Additive: CREATE TABLE only.

CREATE TABLE IF NOT EXISTS "sheet_content_extractions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_sheet_id" uuid NOT NULL,
  "engagement_id" uuid NOT NULL,
  "page_label" text DEFAULT '' NOT NULL,
  "extracted_text_segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "structured_annotations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ocr_model" text NOT NULL,
  "actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sheet_content_extractions_source_sheet_id_unique"
    UNIQUE ("source_sheet_id"),
  CONSTRAINT "sheet_content_extractions_source_sheet_id_sheets_id_fk"
    FOREIGN KEY ("source_sheet_id") REFERENCES "sheets"("id")
    ON DELETE CASCADE,
  CONSTRAINT "sheet_content_extractions_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "sheet_content_extractions_engagement_idx"
  ON "sheet_content_extractions" ("engagement_id");

CREATE TABLE IF NOT EXISTS "attached_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engagement_id" uuid NOT NULL,
  "title" text NOT NULL,
  "document_type" text NOT NULL,
  "extracted_text" text DEFAULT '' NOT NULL,
  "original_blob_ref" text NOT NULL,
  "actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attached_documents_document_type_check"
    CHECK ("document_type" IN ('specification', 'calculation', 'product-data', 'narrative')),
  CONSTRAINT "attached_documents_engagement_id_engagements_id_fk"
    FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "attached_documents_engagement_idx"
  ON "attached_documents" ("engagement_id");
