-- Phase 2D.2/2D.3 — site-drainage materializable_elements integration.
-- Widens CHECK constraints to admit `source_kind = 'site-drainage'` rows
-- carrying engagement-scoped hydrology outputs (drainage zones, flow
-- lines, rainfall simulation GeoJSON). The site-drainage atom in
-- `atom_events` is the source of truth; this row is the read model.

ALTER TABLE materializable_elements
  DROP CONSTRAINT materializable_elements_source_kind_check;

ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_source_kind_check
  CHECK (source_kind IN (
    'briefing-derived',
    'as-built-ifc',
    'as-built-ifc-bundle',
    'site-topography',
    'site-drainage'
  ));

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
    OR (source_kind = 'site-drainage'
        AND engagement_id IS NOT NULL)
  );
