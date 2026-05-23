-- doc 40e A.4 — viewpoint_renders source-type discriminator + power-tool linkage.
--
-- Adds three columns to viewpoint_renders supporting (1) the upload-as-
-- source flow (A.5/B.2 — sketches/photos that bypass the GLB-capture
-- path) and (2) the five power tools (A.1/A.2/B.3 — Render Enhancer,
-- 4K Upscaler, AI Eraser, Inpaint, Style Transfer) that derive a new
-- render from an existing render-output. All additive; existing rows
-- backfill to source_type='model-capture' (the pre-40e default).
--
-- The render-output atom variants (A.6) read these columns through the
-- viewpoint_renders → render_outputs join — no migration needed there.
--
-- source_type values after this migration:
--   'model-capture'   (existing rows backfill; new GLB-capture-sourced rows continue using it)
--   'upload'          (B.2 — uploaded image as render source)
--   'enhance'         (B.3 — Render Enhancer output, parent_render_output_id set)
--   'upscale'         (B.3 — 4K Upscaler output, parent_render_output_id set)
--   'erase'           (B.3 — AI Eraser output, parent_render_output_id set)
--   'inpaint'         (B.3 — Inpaint output, parent_render_output_id set)
--   'style_transfer'  (B.3 — Style Transfer output, parent_render_output_id set)
--
-- source_upload_url is the GCS reference returned by the A.5 upload
-- endpoint. NULL except when source_type='upload'.
--
-- parent_render_output_id is the FK to the source render_output for
-- the five power tools (NULL otherwise). ON DELETE SET NULL so deleting
-- a parent render-output leaves the tool-derived row standing as
-- historical artifact (mirrors the briefing_id / bim_model_id pattern
-- on this same table).

ALTER TABLE viewpoint_renders
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'model-capture';

ALTER TABLE viewpoint_renders
  ADD COLUMN IF NOT EXISTS source_upload_url TEXT;

ALTER TABLE viewpoint_renders
  ADD COLUMN IF NOT EXISTS parent_render_output_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'viewpoint_renders_parent_render_output_id_render_outputs_id_fk'
      AND table_name = 'viewpoint_renders'
  ) THEN
    ALTER TABLE viewpoint_renders
      ADD CONSTRAINT viewpoint_renders_parent_render_output_id_render_outputs_id_fk
        FOREIGN KEY (parent_render_output_id)
        REFERENCES render_outputs(id)
        ON DELETE SET NULL;
  END IF;
END $$;
