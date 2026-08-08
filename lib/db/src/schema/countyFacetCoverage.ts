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
    /**
     * County Manifest Sprint 1 (feat/county-manifest-sprint1). The
     * three-state acquisition axis: `satisfied-present` | `satisfied-absent`
     * | `not-yet`. Deliberately independent of `integrityVerdict` /
     * `classification` above, which encode JOIN INTEGRITY (is this row's
     * data provably real), not ACQUISITION (do we have / need this rail at
     * all) — see doc_repo
     * `_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md`
     * ruling 2. `no-atom` / `no-writer` are NOT stored here; they are
     * derived at query time from `county_rail` (see `countyLedger.ts`).
     * NULL for rows written before this axis existed.
     */
    railState: text("rail_state"),
    /**
     * County Manifest Sprint 1. SATISFIED-vs-PARTIAL comparison point for
     * this cell (ruling 3), copied from `county_rail.threshold_pct` at
     * write time. A separate column (not only on `county_rail`) so a
     * future county-specific threshold override does not require a schema
     * change.
     */
    thresholdPct: numeric("threshold_pct", { precision: 5, scale: 2 }),
    /**
     * County Manifest Sprint 1. The public-record citation for a
     * `satisfied-absent` verdict (e.g. the roster's `zoning_regime.doctrine`
     * string). REQUIRED whenever `railState = 'satisfied-absent'`, enforced
     * by the check constraint below — ruling 2 makes absence a finding, and
     * a finding needs its citation or the state is unfalsifiable.
     */
    absenceBasis: text("absence_basis"),
    /**
     * County Manifest Sprint 1. Per-cell trust: when THIS cell was last
     * verified, distinct from `checkedAt` (when the scorer last WROTE this
     * row — they can diverge if a sweep confirms an existing value without
     * a rewrite).
     */
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /**
     * County Manifest Sprint 1. Free-text identifier of what did the
     * verifying (a CLI name, a sweep job id, `roster-load` for cells seeded
     * from the roster with no independent instrument run).
     */
    verifiedByInstrument: text("verified_by_instrument"),
    /**
     * County Manifest Sprint 1. `sweep` | `sample` | `roster-load` |
     * `unverified`, per MEMORY.md `area-sweep-not-parcel-sample` — a
     * sample-verified cell is a materially weaker claim than a
     * sweep-verified one, and the console must be able to show the
     * difference.
     */
    verificationMethod: text("verification_method"),
    /**
     * County Manifest Sprint 1. Evidence drill-through: a pointer to the
     * artifact (JSON probe file, CAD service response, roster evidence
     * field) backing this cell.
     */
    artifactPath: text("artifact_path"),
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
    // County Manifest Sprint 1 — rail_state enum + verification_method enum
    // + absence_basis-required-when-satisfied-absent. Additive; none of the
    // three checks above are modified.
    railStateIdx: index("county_facet_coverage_rail_state_idx").on(
      t.railState,
    ),
    railStateCheck: check(
      "county_facet_coverage_rail_state_check",
      sql`${t.railState} IS NULL OR ${t.railState} IN ('satisfied-present', 'satisfied-absent', 'not-yet')`,
    ),
    verificationMethodCheck: check(
      "county_facet_coverage_verification_method_check",
      sql`${t.verificationMethod} IS NULL OR ${t.verificationMethod} IN ('sweep', 'sample', 'roster-load', 'unverified')`,
    ),
    absenceBasisRequiredCheck: check(
      "county_facet_coverage_absence_basis_required_check",
      sql`${t.railState} IS DISTINCT FROM 'satisfied-absent' OR ${t.absenceBasis} IS NOT NULL`,
    ),
  }),
);

export type CountyFacetCoverageRow = typeof countyFacetCoverage.$inferSelect;
export type CountyFacetCoverageInsert =
  typeof countyFacetCoverage.$inferInsert;
