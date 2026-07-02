-- Track D Phase 2 — engagement-scoped 2D/3D unified annotation model.
-- Distinct from `reviewer_annotations` (submission-scoped threaded scratch
-- notes): this table anchors a markup/finding overlay to an engagement, with
-- either a 2D document-space location (`location2d`: submission/page/bbox) or
-- a 3D element-space location (`location3d`: globalId/elementId), plus an
-- optional back-link to the finding it visualizes.
CREATE TABLE engagement_annotations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  author        text NOT NULL,
  kind          text NOT NULL,
  finding_id    uuid REFERENCES findings(id) ON DELETE SET NULL,
  confidence    jsonb,
  location2d    jsonb,
  location3d    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_annotations_engagement ON engagement_annotations(engagement_id);
