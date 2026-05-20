-- Cortex L6 (Lane C.4 / C.4.6) — deliverable_letter_renders table
-- backing the `deliverable-letter-render` atom. Additive: CREATE TABLE
-- only.
--
-- `render_bytes` stores the generated DOCX/PDF inline (bytea, mirrors
-- sheets.full_png); `blob_ref` is the opaque atom-level pointer.

CREATE TABLE IF NOT EXISTS "deliverable_letter_renders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "letter_id" uuid NOT NULL,
  "source_letter_ref" text NOT NULL,
  "source_letter_version" text NOT NULL,
  "format" text NOT NULL,
  "blob_ref" text NOT NULL,
  "render_bytes" bytea NOT NULL,
  "rendered_by_actor_id" text,
  "rendered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deliverable_letter_renders_format_check"
    CHECK ("format" IN ('docx', 'pdf')),
  CONSTRAINT "deliverable_letter_renders_letter_id_deliverable_letters_id_fk"
    FOREIGN KEY ("letter_id") REFERENCES "deliverable_letters"("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "deliverable_letter_renders_letter_rendered_idx"
  ON "deliverable_letter_renders" ("letter_id", "rendered_at");
