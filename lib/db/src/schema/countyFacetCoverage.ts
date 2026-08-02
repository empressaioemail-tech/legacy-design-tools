import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  boolean,
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
 *
 * Phase A7 (additive) — performance fields. The ledger started as a
 * coverage/correctness scorecard; these columns extend it into the
 * rewarmable-factory PERFORMANCE layer: what recipe a jurisdiction was
 * warmed under, its cert progression, when it was last rewarmed/refreshed,
 * whether it has drifted stale or is unsafe to rewarm (an unfrozen
 * sticky-part decision blocks it), its onboarding cost against the
 * per-jurisdiction budget commitment, and whether it has been through the
 * onboarding line at all. All nullable/defaulted so every pre-existing row
 * stays valid without a backfill.
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
    /**
     * Phase A7. The recipe version the jurisdiction's atoms were warmed
     * under — the rewarm trigger (a bumped recipe version means every
     * jurisdiction still on an older version is a rewarm candidate). NULL
     * for rows written before recipe-version tracking existed.
     */
    recipeVersion: text("recipe_version"),
    /**
     * Phase A7. `uncerted` | `mechanical-pass` | `r6-pass` | `certified`.
     * NULL for rows that predate cert tracking. Enforced at the DB via
     * check constraint below.
     */
    certState: text("cert_state"),
    /** Phase A7. When this jurisdiction was last rewarmed. NULL if never. */
    lastRewarmAt: timestamp("last_rewarm_at", { withTimezone: true }),
    /**
     * Phase A7. When this jurisdiction's sources were last re-acquired
     * (distinct from `lastRewarmAt`: a refresh re-pulls source data, a
     * rewarm re-derives atoms from whatever sources are on hand).
     */
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    /**
     * Phase A7. True when `source_vintage` has aged past the refresh
     * cadence for this facet. Defaults false; a staleness sweep flips it.
     */
    stalenessFlag: boolean("staleness_flag").notNull().default(false),
    /**
     * Phase A7. True when an unfrozen sticky-part decision exists for this
     * jurisdiction, blocking a safe rewarm until it is resolved. Defaults
     * false (safe to rewarm absent a known blocker).
     */
    rewarmUnsafe: boolean("rewarm_unsafe").notNull().default(false),
    /**
     * Phase A7. Compute + human-review cost to onboard this jurisdiction,
     * in USD, scored against the $200/jurisdiction hard-kill commitment.
     * NULL until the jurisdiction has an onboarding cost recorded.
     */
    costUsd: numeric("cost_usd", { precision: 10, scale: 2 }),
    /**
     * Phase A7. Whether this jurisdiction has been through the onboarding
     * line at all (distinct from cert/rewarm state — a jurisdiction can be
     * onboarded but not yet certified). Defaults false.
     */
    onboarded: boolean("onboarded").notNull().default(false),
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
    // Phase A7 — cert_state enum. NULL allowed (pre-cert-tracking rows);
    // any non-NULL value must be one of the four cert stages.
    certStateCheck: check(
      "county_facet_coverage_cert_state_check",
      sql`${t.certState} IS NULL OR ${t.certState} IN ('uncerted', 'mechanical-pass', 'r6-pass', 'certified')`,
    ),
  }),
);

export type CountyFacetCoverageRow = typeof countyFacetCoverage.$inferSelect;
export type CountyFacetCoverageInsert =
  typeof countyFacetCoverage.$inferInsert;
