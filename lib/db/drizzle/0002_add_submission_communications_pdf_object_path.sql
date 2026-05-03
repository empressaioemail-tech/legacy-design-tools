-- PLR-11: persist the `/objects/<uuid>` path of the rendered
-- comment-letter PDF on each submission_communications row. Nullable
-- so a transient PDF-render failure does not block the send (the row
-- + history event remain authoritative).
ALTER TABLE "submission_communications"
  ADD COLUMN IF NOT EXISTS "pdf_object_path" text;
