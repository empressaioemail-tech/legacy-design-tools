-- P-106 constraint search: the parcel constraint index.
--
-- HANDED BACK UNAPPLIED. This lane is read-only against production; the
-- migration is written, reviewed and NOT run, the way 0093 was handed back.
-- Number 0094 claimed 2026-09-02 against main (highest committed 0092) and
-- against every unmerged branch on this machine (0093 is held by the P-100
-- share-funnel lane, unpushed). Nothing has recorded 0094 in
-- _schema_migrations anywhere.
--
-- WHAT THIS IS AND IS NOT.
-- It is a CACHE, projected from facets that are already baked. It is not a
-- second store for a subject that already has one: no value here is derived
-- from a source the bake did not already read, and every row names the bake
-- snapshot it was projected from. `place_layer_snapshots` indexes
-- (adapter_key, place_key) and (adapter_key, lat_rounded, lng_rounded) and
-- nothing on payload_json, so filtering by attribute today means scanning
-- every parcel row in the county. That is the only reason this table exists.
--
-- WHY EVERY RAIL CARRIES A STATE COLUMN, NOT JUST A NULLABLE VALUE.
-- A null value cannot say WHY it is null, and the three reasons are three
-- different facts: the parcel has no such thing (absent-verified, a positive
-- determination with a basis), nobody looked (unknown / unread), or the
-- producer declined (refused). A search that cannot tell them apart either
-- fabricates a claim by counting unmeasured parcels as qualifying, or hides
-- parcels that might qualify by dropping them silently. The state column is
-- what makes the three-set result expressible at all, so it is NOT NULL on
-- every rail: a row without a disposition for a rail is not admitted.
--
-- WHY THE VALUE/STATE PAIR IS CHECK-CONSTRAINED IN DDL RATHER THAN IN CODE.
-- The invariant is "a value exists if and only if the state is present". A
-- raw connection, a future backfill, or a hand-written UPDATE does not run
-- the TypeScript. The constraint refuses, at the store, both halves of the
-- defect: a value smuggled in under an unmeasured state (which a filter would
-- then read as a determination), and a `present` state with nothing behind it
-- (which is a sentinel wearing a determination's clothes). Same posture as
-- pe_user_entitlements_billing_interval_chk in 0092.
--
-- ZERO IS A VALUE. None of these columns defaults. A dollar rail of 0 and an
-- unmeasured dollar rail are different rows, and a DDL default would erase
-- the difference silently, which is the one outcome this table exists to
-- prevent.
--
-- THE ETJ COLUMN IS DECLARED AHEAD AND HAS NO SOURCE.
-- Measured 2026-09-02: the deployment store carries tx_city_boundary,
-- tx_county_boundary, tx_special_district and landing_parcel_jurisdiction,
-- and nothing carries an extraterritorial-jurisdiction ring. Per
-- _decisions/2026-09-01_parcel_record_rails_v2_template.md the column exists
-- so "we do not carry this" stays distinguishable from "this parcel does not
-- have it"; its state is 'unread' on every row, it never enters a coverage
-- number as live, and every filter over it is refused by the serve path.

CREATE TABLE IF NOT EXISTS pe_parcel_constraint_index (
  county_fips text NOT NULL,
  prop_id text NOT NULL,
  parcel_node_id text NOT NULL,

  -- Cache provenance. built_at is when THIS row was projected; bake_snapshot_at
  -- is the snapshot_at of the tier-1 row it was projected from. A response that
  -- reports built_at as the freshness of the facts would be wrong by exactly
  -- the distance between these two, so both are kept.
  built_at timestamptz NOT NULL,
  bake_snapshot_at timestamptz,
  build_run_id uuid NOT NULL,

  acreage_acres numeric(14,4),
  acreage_state text NOT NULL,

  land_use_code text,
  land_use_state text NOT NULL,

  city_limits text,
  city_limits_state text NOT NULL,

  etj text,
  etj_state text NOT NULL,

  zoning_district text,
  zoning_state text NOT NULL,

  flood_zone text,
  flood_in_sfha boolean,
  flood_state text NOT NULL,

  special_district_id text,
  special_district_state text NOT NULL,

  market_value bigint,
  market_value_state text NOT NULL,

  land_value bigint,
  land_value_state text NOT NULL,

  improvement_value bigint,
  improvement_value_state text NOT NULL,

  year_built integer,
  year_built_state text NOT NULL,

  CONSTRAINT pe_parcel_constraint_index_pk PRIMARY KEY (county_fips, prop_id)
);

-- The rail-state vocabulary, frozen at the store. These five words are
-- SMART_SITE_RAIL_STATES in artifacts/api-server/src/lib/smartSiteStub.ts, the
-- vocabulary get_smart_site already publishes. A sixth word would let a rail
-- express a disposition the serve path has no display for.
DO $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'acreage_state','land_use_state','city_limits_state','etj_state',
    'zoning_state','flood_state','special_district_state',
    'market_value_state','land_value_state','improvement_value_state',
    'year_built_state'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'pe_pci_' || col || '_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE pe_parcel_constraint_index ADD CONSTRAINT %I CHECK (%I IN (''present'',''absent-verified'',''unknown'',''refused'',''unread''))',
        'pe_pci_' || col || '_chk', col
      );
    END IF;
  END LOOP;
END $$;

-- Value-present iff state-present, per rail. Both directions, deliberately:
-- left-to-right refuses a value under an unmeasured state, right-to-left
-- refuses a `present` with nothing behind it.
DO $$
DECLARE
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['acreage','acreage_acres','acreage_state'],
    ARRAY['land_use','land_use_code','land_use_state'],
    ARRAY['city_limits','city_limits','city_limits_state'],
    ARRAY['etj','etj','etj_state'],
    ARRAY['zoning','zoning_district','zoning_state'],
    ARRAY['special_district','special_district_id','special_district_state'],
    ARRAY['market_value','market_value','market_value_state'],
    ARRAY['land_value','land_value','land_value_state'],
    ARRAY['improvement_value','improvement_value','improvement_value_state'],
    ARRAY['year_built','year_built','year_built_state']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_' || pair[1] || '_value_state_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE pe_parcel_constraint_index ADD CONSTRAINT %I CHECK ((%I IS NOT NULL) = (%I = ''present''))',
        'pe_pci_' || pair[1] || '_value_state_chk', pair[2], pair[3]
      );
    END IF;
  END LOOP;
END $$;

-- Flood is the one rail whose determination is the BOOLEAN, not the string.
-- floodHazardFactRead's present shape allows floodZone null with
-- inSpecialFloodHazardArea true or false (a mapped zone with no letter is
-- still a determination), so the flag is what present means here and
-- flood_zone is free to be null under it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_flood_value_state_chk') THEN
    ALTER TABLE pe_parcel_constraint_index
      ADD CONSTRAINT pe_pci_flood_value_state_chk
      CHECK ((flood_in_sfha IS NOT NULL) = (flood_state = 'present'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_flood_zone_needs_flag_chk') THEN
    ALTER TABLE pe_parcel_constraint_index
      ADD CONSTRAINT pe_pci_flood_zone_needs_flag_chk
      CHECK (flood_zone IS NULL OR flood_in_sfha IS NOT NULL);
  END IF;
END $$;

-- city_limits is a closed two-value grammar. 'unresolved' is NOT admitted as a
-- value: the jurisdiction run looking at a parcel and failing to place it is a
-- refusal, carried in city_limits_state, not a third kind of place.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_city_limits_grammar_chk') THEN
    ALTER TABLE pe_parcel_constraint_index
      ADD CONSTRAINT pe_pci_city_limits_grammar_chk
      CHECK (city_limits IS NULL OR city_limits IN ('in-city','unincorporated'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_county_fips_chk') THEN
    ALTER TABLE pe_parcel_constraint_index
      ADD CONSTRAINT pe_pci_county_fips_chk
      CHECK (county_fips ~ '^[0-9]{5}$');
  END IF;
  -- prop_id '0' is the live degenerate key (48021:0 carries a ", ," situs and
  -- a bake row). It is refused here for the same reason
  -- landing_parcel_jurisdiction refuses it: it is not a parcel.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_prop_id_chk') THEN
    ALTER TABLE pe_parcel_constraint_index
      ADD CONSTRAINT pe_pci_prop_id_chk
      CHECK (btrim(prop_id) <> '' AND prop_id <> '0');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_node_id_shape_chk') THEN
    ALTER TABLE pe_parcel_constraint_index
      ADD CONSTRAINT pe_pci_node_id_shape_chk
      CHECK (parcel_node_id = county_fips || ':' || prop_id);
  END IF;
END $$;

-- One filtered scan per county is the access pattern; every query is
-- county-scoped by construction (a search with no geographic bound is refused
-- at the route, not answered statewide).
CREATE INDEX IF NOT EXISTS pe_pci_county_idx
  ON pe_parcel_constraint_index (county_fips);

-- The two rails the measurement of 2026-09-02 shows are actually populated
-- get a composite so the common land-buyer filter is an index range rather
-- than a county scan. Deliberately NOT one index per rail: eleven indexes on
-- a table nobody has yet built is speculation, and the rails that are at zero
-- today would carry ten of them.
CREATE INDEX IF NOT EXISTS pe_pci_county_acreage_idx
  ON pe_parcel_constraint_index (county_fips, acreage_state, acreage_acres);
CREATE INDEX IF NOT EXISTS pe_pci_county_flood_idx
  ON pe_parcel_constraint_index (county_fips, flood_state, flood_in_sfha);

-- The build ledger. ENFORCEMENT: every operation that mutates durable state
-- emits a durable record naming the items acted on, the timestamp and the
-- invocation, and a count is not a record. The scope here is the county plus
-- the prop_id range actually walked, which is what "the items acted on" means
-- for a set of half a million rows; the invocation string is the command that
-- produced it. A build that cannot write this row does not run.
CREATE TABLE IF NOT EXISTS pe_parcel_constraint_index_builds (
  build_run_id uuid PRIMARY KEY,
  county_fips text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  invocation text NOT NULL,
  prop_id_lo text,
  prop_id_hi text,
  bake_rows_read bigint,
  rows_written bigint,
  bake_snapshot_max timestamptz,
  outcome text NOT NULL,
  refusal_reason text
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_builds_outcome_chk') THEN
    ALTER TABLE pe_parcel_constraint_index_builds
      ADD CONSTRAINT pe_pci_builds_outcome_chk
      CHECK (outcome IN ('started','succeeded','failed','refused'));
  END IF;
  -- A refusal without a reason is how an unattributed mutation becomes
  -- unanswerable. Refusals are recorded the same way successes are.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pe_pci_builds_refusal_chk') THEN
    ALTER TABLE pe_parcel_constraint_index_builds
      ADD CONSTRAINT pe_pci_builds_refusal_chk
      CHECK (outcome <> 'refused' OR btrim(coalesce(refusal_reason,'')) <> '');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pe_pci_builds_county_started_idx
  ON pe_parcel_constraint_index_builds (county_fips, started_at DESC);
