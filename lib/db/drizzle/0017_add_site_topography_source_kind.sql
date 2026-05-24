-- Phase 2D.x PR3 — site-topography materializable_elements integration.
-- Renumbered 0016 → 0017 (2026-05-24) so `0016_renders_power_tools_source_type.sql`
-- (40e) owns the 0016 slot. migrate-prod.mjs orders by filename; both files
-- were tracked separately but the duplicate prefix blocked a clear head.
--
-- If `_schema_migrations` already records the old filename, operator runs once:
--   UPDATE _schema_migrations
--   SET name = '0017_add_site_topography_source_kind.sql'
--   WHERE name = '0016_add_site_topography_source_kind.sql';
--
-- Relax `materializable_elements`'s two CHECK constraints to admit a
-- `source_kind = 'site-topography'` row carrying engagement-scoped DEM
-- + contour-GeoJSON derived from USGS 3DEP. The site-topography atom
-- (PR #101) is the source of truth in `atom_events`; this row is the
-- materialized read model.
--
-- Net change:
--   - `materializable_elements_source_kind_check` widens to include
--     `'site-topography'` alongside the existing three values.
--   - `materializable_elements_provenance_invariants_check` adds a
--     third branch: `site-topography` rows require `engagement_id`
--     only (no `briefing_id`, no `source_snapshot_id`, no IFC fields).
--
-- Existing `briefing-derived` and `as-built-ifc(-bundle)` invariants
-- are unchanged — this migration ONLY widens the allowed set.
--
-- Mirrors the cc-agent-C2 SCOPE B observation that the dispatch's
-- "propertySet JSON column carries DEM ref + contour GeoJSON natively"
-- is true at the *column* level but NOT at the *row's source_kind*
-- level — the closed-tuple CHECK rejects unknown values until widened.
-- Operator confirmed the persistence path 2026-05-23 per
-- doc_repo/00_current_state.md; this migration is the implied
-- prerequisite.

ALTER TABLE materializable_elements
  DROP CONSTRAINT materializable_elements_source_kind_check;

ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_source_kind_check
  CHECK (source_kind IN ('briefing-derived', 'as-built-ifc', 'as-built-ifc-bundle', 'site-topography'));

ALTER TABLE materializable_elements
  DROP CONSTRAINT materializable_elements_provenance_invariants_check;

ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_provenance_invariants_check
  CHECK (
    (source_kind = 'briefing-derived' AND briefing_id IS NOT NULL)
    OR (source_kind IN ('as-built-ifc', 'as-built-ifc-bundle')
        AND source_snapshot_id IS NOT NULL
        AND engagement_id IS NOT NULL
        AND ifc_global_id IS NOT NULL
        AND ifc_type IS NOT NULL)
    OR (source_kind = 'site-topography'
        AND engagement_id IS NOT NULL)
  );
