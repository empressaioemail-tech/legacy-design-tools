-- Per-county-per-facet coverage + correctness LEDGER
-- (feat/join-integrity-gate-and-coverage-ledger).
--
-- The provable record the county-data pipeline writes AFTER an integrity
-- gate proves a facet's data is real. One row per (county_fips, facet). It
-- is the antidote to "91.6% coverage that was actually numeric-collision
-- fabrications" (the Hays/Williamson land-use failure): a county's coverage
-- number earns its place in this table only by passing the owner-match
-- integrity gate, and the row records the verdict + the owner-match rate the
-- verdict rested on.
--
-- honest_coverage_pct    the HONEST per-facet coverage (0..100). For land-use
--                        a BLOCKED join records 0 (honest-absence), never the
--                        fabricated stamp rate.
-- integrity_verdict      'pass' | 'block' | 'insufficient-sample' | 'n/a'
--                        (n/a for facets with no owner-match oracle, e.g.
--                        zoning stamped-% or envelope-%).
-- owner_match_rate       0..1, the land-use join's owner agreement rate the
--                        verdict rested on (NULL for n/a facets).
-- classification         'real-at-ceiling' | 'needs-crosswalk' |
--                        'true-source-gap' | 'fabricated-blocked'.
-- source / source_vintage provenance of the facet's data (e.g. 'cad-roll' /
--                        '2026-certified'); NULL when honestly absent.
-- sampled                informative owner pairs the rate was computed over.
-- checked_at             when the scorer last wrote this row (bumped on upsert).
--
-- Re-scoring a (county, facet) upserts in place (idempotent). The scorer is
-- READ-ONLY on the parcel/CAD data; it only writes this ledger.

CREATE TABLE IF NOT EXISTS "county_facet_coverage" (
  "county_fips" text NOT NULL,
  "facet" text NOT NULL,
  "honest_coverage_pct" numeric(5, 2) NOT NULL DEFAULT 0,
  "integrity_verdict" text NOT NULL,
  "owner_match_rate" numeric(5, 4),
  "source" text,
  "source_vintage" text,
  "sampled" integer NOT NULL DEFAULT 0,
  "classification" text NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "county_facet_coverage_county_fips_facet_pk"
    PRIMARY KEY ("county_fips", "facet"),
  CONSTRAINT "county_facet_coverage_integrity_verdict_check"
    CHECK ("integrity_verdict" IN
      ('pass', 'block', 'insufficient-sample', 'n/a')),
  CONSTRAINT "county_facet_coverage_classification_check"
    CHECK ("classification" IN
      ('real-at-ceiling', 'needs-crosswalk', 'true-source-gap',
       'fabricated-blocked'))
);

-- Query the ledger by verdict / classification (e.g. "show every blocked or
-- crosswalk-needing facet across the corpus") without a full scan.
CREATE INDEX IF NOT EXISTS "county_facet_coverage_verdict_idx"
  ON "county_facet_coverage" USING btree ("integrity_verdict");
CREATE INDEX IF NOT EXISTS "county_facet_coverage_classification_idx"
  ON "county_facet_coverage" USING btree ("classification");
