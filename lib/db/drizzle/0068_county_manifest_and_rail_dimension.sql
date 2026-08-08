-- County Manifest Sprint 1 (feat/county-manifest-sprint1).
--
-- Two new, pure-additive tables implementing the operator ruling at
-- _decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md
-- and the build spec at
-- _inbox/2026-08-08_SPRINT1_manifest_schema_spec.md (doc_repo).
--
-- county_manifest: the missing denominator. One row per Texas county (254),
-- seeded from artifacts/api-server/data/texas_county_roster_v1.json (a
-- counties-only extract of doc_repo's _catalog/texas_roster_v1.json).
-- Without this table there is nothing to LEFT JOIN from and "254" cannot
-- exist as anything but a hardcoded literal. Columns carry only what the
-- roster can currently justify plus identity/sort/display fields the
-- Command Center manifest console needs. This is NOT a copy of the full
-- roster JSON — per-rail roster fields (geometry.*, cadastral.*,
-- zoning_regime.*, rails.*) seed county_facet_coverage cells directly
-- (see 0069 + countyManifestSeedCli.ts), not this table.
--
-- county_rail: the 13 ruled rails, in ruled order. atom_family_state /
-- has_writer are DECLARED FACTS about the current state of the atom
-- contract and the scorer CLI, kept here so the console can render
-- `no-atom` / `no-writer` from data rather than a hardcoded TS list that
-- drifts (the same anti-pattern this sprint retires at
-- countyCoverageScoreCli.ts's COUNTY_NAMES). Neither column enforces
-- anything — updating them here does not create an atom or wire a writer;
-- they are the manifest's honest record of what exists elsewhere.

CREATE TABLE IF NOT EXISTS county_manifest (
  county_fips               text PRIMARY KEY,
  county_name               text NOT NULL,
  parcel_count_est          integer,
  population_est            integer,
  population_status         text NOT NULL DEFAULT 'unverified',
  in_stratmap                boolean NOT NULL DEFAULT false,
  stratmap_vintage           text,
  cad_verification            text,
  cad_vendor_pattern          text,
  join_key_kind               text NOT NULL DEFAULT 'prop_id',
  prop_id_bad_rate            numeric(6, 4),
  owner_match_gate_required   boolean NOT NULL DEFAULT true,
  risk_class                  text[] NOT NULL DEFAULT '{}',
  cost_estimate_usd            numeric(10, 2),
  cost_estimate_method         text,
  roster_schema_version        text NOT NULL,
  roster_generated_at          timestamptz NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT county_manifest_population_status_check
    CHECK (population_status IN ('verified', 'unverified')),
  CONSTRAINT county_manifest_join_key_kind_check
    CHECK (join_key_kind IN ('prop_id', 'geo_id_or_address_crosswalk')),
  CONSTRAINT county_manifest_cad_verification_check
    CHECK (cad_verification IS NULL OR cad_verification IN
      ('verified', 'partial', 'honestly_absent', 'pending'))
);

CREATE INDEX IF NOT EXISTS county_manifest_parcel_count_idx
  ON county_manifest (parcel_count_est DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS county_manifest_in_stratmap_idx
  ON county_manifest (in_stratmap);

CREATE TABLE IF NOT EXISTS county_rail (
  rail_key              text PRIMARY KEY,
  display_name          text NOT NULL,
  ordinal               smallint NOT NULL,
  rail_letter           text,
  kind                  text NOT NULL,
  threshold_pct          numeric(5, 2) NOT NULL,
  atom_family_state      text NOT NULL,
  atom_family_ref        text,
  has_writer             boolean NOT NULL DEFAULT false,
  writer_ref              text,
  declared_source          text NOT NULL,
  notes                    text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT county_rail_ordinal_unique UNIQUE (ordinal),
  CONSTRAINT county_rail_kind_check
    CHECK (kind IN ('spine', 'derived')),
  CONSTRAINT county_rail_atom_family_state_check
    CHECK (atom_family_state IN ('present', 'missing', 'partial', 'unpublished'))
);

-- Seed: the 13 ruled rails, ruled order, per
-- doc_repo/_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md
-- and cross-checked against doc_repo/_inbox/2026-08-08_CONTRACT_coherence_audit.md
-- section 1 for atom_family_state / has_writer.
INSERT INTO county_rail (rail_key, display_name, ordinal, rail_letter, kind, threshold_pct, atom_family_state, atom_family_ref, has_writer, writer_ref, declared_source, notes) VALUES
  ('geometry',  'Parcel geometry',      1, 'C', 'spine',   95, 'missing',      NULL,
     false, NULL, 'TxGIO StratMap bulk zip per FIPS; county ArcGIS override where fresher',
     'Spine rail, no atom. ADR-029 builds its graph on a parcel-record type that does not exist (contract audit S2).'),
  ('cad',       'CAD attributes',       2, 'B', 'spine',   95, 'missing',      NULL,
     false, NULL, 'County CAD (BIS/PACS/Orion/HCAD), joined to Rail C geometry', NULL),
  ('join',      'Join quality',         3, NULL,'spine',   95, 'missing',      NULL,
     true, 'county_facet_coverage.owner_match_rate (land-use row only, not a peer cell)',
     'Derived; owner_match_gate_required ALWAYS per OPS-1', 'Measured but not stored as its own rail today.'),
  ('zoning',    'Zoning + setback',     4, 'A', 'spine',   95, 'present',      'zoning-fact, setback-rule (contract)',
     true, 'countyCoverageScoreCli.ts facet land-use/:538 no -- zoning:591', 'Municipal code per incorporated city; unincorporated county is unzoned',
     'Typed absence discriminant; satisfied-absent is first-class here.'),
  ('roads',     'Roads / frontage',     5, NULL,'spine',   95, 'present',      'road-node (contract + engine)',
     false, NULL, 'OSM Overpass plus county roadway layers', 'Atom exists, no scorer emits it, and no roster block backs it.'),
  ('flood',     'Flood / terrain',      6, 'D', 'spine',   95, 'partial',      'parcel-terrain-model (terrain only; no flood atom)',
     false, NULL, 'FEMA NFHL, USGS 3DEP, USDA SSURGO', 'Terrain covered; flood half has no atom.'),
  ('envelope',  'Buildable envelope',   7, NULL,'derived', 90, 'present',      'buildable-envelope (contract)',
     true, 'countyCoverageScoreCli.ts:602', 'Derived from parcel geometry + zoning/setback + roads',
     'Absence rides off-contract engine fields (warmVerifyDecline*); will not survive export (contract audit S4).'),
  ('landuse',   'Land use',             8, NULL,'derived', 90, 'missing',      NULL,
     true, 'countyCoverageScoreCli.ts:538 facet land-use', 'CAD roll code',
     'Scored but not atomized. Only live land_use_code carrier is the EXTINGUISHED Cotality adapter.'),
  ('footprint', 'Building footprints',  9, NULL,'derived', 90, 'unpublished',  'building-footprint (contract v1.12.0, unpublished)',
     false, NULL, 'ML-derived default statewide (Microsoft/Overture/USA Structures)', 'One npm publish away from existing.'),
  ('easement',  'Utility easements',   10, NULL,'derived', 90, 'unpublished',  'utility-easement (contract v1.12.0, unpublished)',
     false, NULL, 'County honest-absence default; CAD exception where published',
     'Roster easement_tier "cad-easement-rest" (McLennan) is not a contract enum member -- will hard-fail Zod parse (contract audit S5).'),
  ('owner',     'Owner facet',         11, NULL,'derived', 90, 'missing',      NULL,
     false, NULL, 'CAD owner_name + mailing, authenticated paid facet',
     'Ruled public-paid at the atom level; no owner atom exists to carry the policy.'),
  ('rrc',       'RRC wells / pipelines',12, NULL,'derived', 90, 'partial',      '12 O&G types (wells only; no parcelNodeId edge; pipelines missing)',
     false, NULL, 'RRC public GIS (W-1, H-10, PDQ)', 'W3 HELD per 2026-08-01 scale ruling.'),
  ('mud',       'MUD / special districts', 13, NULL,'derived', 90, 'missing',   NULL,
     false, NULL, 'TX Comptroller special-district registry', 'W4 HELD per 2026-08-01 scale ruling.')
ON CONFLICT (rail_key) DO NOTHING;
