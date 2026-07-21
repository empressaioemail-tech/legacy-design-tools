import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Per-county-per-facet coverage + correctness LEDGER.
 *
 * The provable, queryable record the county-data pipeline writes AFTER an
 * integrity gate proves a facet's data is real. One row per
 * `(county_fips, facet)`.
 *
 * Motivation: the Hays/Williamson land-use fabrication (a numeric-collision
 * join that stamped ~167k parcels with a DIFFERENT property's land-use) passed
 * every existing ingest step because nothing scored or stored per-county data
 * quality. This ledger closes that gap: a county's coverage number earns its
 * place only after passing the owner-match integrity gate
 * (`artifacts/api-server/src/lib/joinIntegrityGate.ts`), and the row records
 * the verdict + the owner-match rate the verdict rested on. "County done" =
 * gates passed + ledger row written.
 *
 * Written by the per-county scorer CLI
 * (`artifacts/api-server/src/countyCoverageScoreCli.ts`), which is READ-ONLY
 * on the parcel/CAD data and only upserts this table. Re-scoring a
 * `(county, facet)` upserts in place (idempotent).
 */
export const countyFacetCoverage = pgTable(
  "county_facet_coverage",
  {
    /** 5-digit county FIPS, e.g. `48491` (Williamson). */
    countyFips: text("county_fips").notNull(),
    /** The facet scored, e.g. `land-use`, `zoning`, `envelope`. */
    facet: text("facet").notNull(),
    /**
     * HONEST per-facet coverage, 0..100. For land-use a BLOCKED join records
     * 0 (honest-absence), NEVER the fabricated stamp rate.
     */
    honestCoveragePct: numeric("honest_coverage_pct", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("0"),
    /**
     * `pass` | `block` | `insufficient-sample` | `n/a`. `n/a` for facets with
     * no owner-match oracle (zoning stamped-%, envelope-%).
     */
    integrityVerdict: text("integrity_verdict").notNull(),
    /**
     * The land-use join's owner-agreement rate the verdict rested on (0..1).
     * NULL for facets with no owner-match oracle.
     */
    ownerMatchRate: numeric("owner_match_rate", { precision: 5, scale: 4 }),
    /** Provenance of the facet's data, e.g. `cad-roll`. NULL when absent. */
    source: text("source"),
    /** Export/vintage label, e.g. `2026-certified`. NULL when absent. */
    sourceVintage: text("source_vintage"),
    /** Informative owner pairs the rate was computed over. */
    sampled: integer("sampled").notNull().default(0),
    /**
     * `real-at-ceiling` | `needs-crosswalk` | `true-source-gap` |
     * `fabricated-blocked`.
     */
    classification: text("classification").notNull(),
    /** When the scorer last wrote this row; bumped on every upsert. */
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.facet] }),
    verdictIdx: index("county_facet_coverage_verdict_idx").on(
      t.integrityVerdict,
    ),
    classificationIdx: index("county_facet_coverage_classification_idx").on(
      t.classification,
    ),
    // Enforce the verdict + classification enums at the DB (the gate never
    // writes a value outside these, and a bad write should fail loudly).
    integrityVerdictCheck: check(
      "county_facet_coverage_integrity_verdict_check",
      sql`${t.integrityVerdict} IN ('pass', 'block', 'insufficient-sample', 'n/a')`,
    ),
    classificationCheck: check(
      "county_facet_coverage_classification_check",
      sql`${t.classification} IN ('real-at-ceiling', 'needs-crosswalk', 'true-source-gap', 'fabricated-blocked')`,
    ),
  }),
);

export type CountyFacetCoverageRow = typeof countyFacetCoverage.$inferSelect;
export type CountyFacetCoverageInsert =
  typeof countyFacetCoverage.$inferInsert;
