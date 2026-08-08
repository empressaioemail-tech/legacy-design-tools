import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  boolean,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * County Manifest Sprint 1 (feat/county-manifest-sprint1) — the missing
 * denominator.
 *
 * One row per Texas county (254), seeded from
 * `artifacts/api-server/data/texas_county_roster_v1.json` (a counties-only
 * extract of doc_repo's `_catalog/texas_roster_v1.json`) by
 * `countyManifestSeedCli.ts`. Without this table there is nothing to LEFT
 * JOIN from and "254" cannot exist as anything but a hardcoded literal
 * (see doc_repo `_inbox/2026-08-08_LEDGER_schema_audit.md` section 3).
 *
 * This is NOT a copy of the full roster JSON — per-rail roster fields
 * (geometry.*, cadastral.*, zoning_regime.*, rails.*) seed
 * `county_facet_coverage` cells directly where a rail's atom family is
 * `present` (see 0069 migration + `countyRail`), not this table. This
 * table carries identity/sort/display fields plus the roster facts that
 * do NOT map onto a specific rail cell (CAD verification, join-key kind,
 * risk class, cost estimate) — see
 * doc_repo `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md` section 1/7.
 *
 * Columns are a load from a roster snapshot, not a live sync;
 * `rosterSchemaVersion` / `rosterGeneratedAt` carry the snapshot's own
 * provenance so a re-seed is traceable (MEMORY.md
 * migration-merged-not-applied-to-deployment-neon).
 */
export const countyManifest = pgTable(
  "county_manifest",
  {
    /** 5-digit county FIPS, e.g. `48491` (Williamson). Matches countyFacetCoverage.countyFips so joins need no cast. */
    countyFips: text("county_fips").primaryKey(),
    countyName: text("county_name").notNull(),
    /** Roster `identity.parcel_count_est`; NULL where the roster itself carries no estimate (e.g. Donley). */
    parcelCountEst: integer("parcel_count_est"),
    /** Roster `identity.population.value`; mostly NULL — roster documents this as "not probed this session". */
    populationEst: integer("population_est"),
    /** Roster `identity.population.status`. */
    populationStatus: text("population_status").notNull().default("unverified"),
    /** Roster `geometry.in_stratmap`. */
    inStratmap: boolean("in_stratmap").notNull().default(false),
    /** Roster `geometry.vintage_yyyymm`. */
    stratmapVintage: text("stratmap_vintage"),
    /** Roster `cadastral.verification`: verified | partial | honestly_absent | pending. Metadata only — CAD has no atom family, so it never seeds a rail cell (see county_rail.cad). */
    cadVerification: text("cad_verification"),
    /** Roster `cadastral.vendor_pattern`. */
    cadVendorPattern: text("cad_vendor_pattern"),
    /** Roster `join_quality.join_key`: prop_id | geo_id_or_address_crosswalk. Closes contract-audit S8 — a place to flag crosswalk counties. */
    joinKeyKind: text("join_key_kind").notNull().default("prop_id"),
    /** Roster `join_quality.prop_id_bad_rate`. */
    propIdBadRate: numeric("prop_id_bad_rate", { precision: 6, scale: 4 }),
    /** Roster `join_quality.owner_match_gate_required`; always true per OPS-1. */
    ownerMatchGateRequired: boolean("owner_match_gate_required")
      .notNull()
      .default(true),
    /** Roster `risk_class[]`, e.g. `['bis-field-template']`. Native text[] — Sprint 1 does not need independent querying of risk classes; promote to a child table if that changes. */
    riskClass: text("risk_class")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Roster `cost_estimate.estimated_usd`. UNVERIFIED — spine compute only per the 2026-08-08 ruling; always render with that disclaimer. */
    costEstimateUsd: numeric("cost_estimate_usd", { precision: 10, scale: 2 }),
    /** Roster `cost_estimate.method`, literal `engine_250_heuristic`. */
    costEstimateMethod: text("cost_estimate_method"),
    /** Roster top-level `schema_version` (e.g. `t6_roster_v1`) at seed time. */
    rosterSchemaVersion: text("roster_schema_version").notNull(),
    /** Roster top-level `generated_at` at seed time. */
    rosterGeneratedAt: timestamp("roster_generated_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("county_manifest_parcel_count_idx").on(
      sql`${t.parcelCountEst} DESC NULLS LAST`,
    ),
    index("county_manifest_in_stratmap_idx").on(t.inStratmap),
    check(
      "county_manifest_population_status_check",
      sql`${t.populationStatus} IN ('verified', 'unverified')`,
    ),
    check(
      "county_manifest_join_key_kind_check",
      sql`${t.joinKeyKind} IN ('prop_id', 'geo_id_or_address_crosswalk')`,
    ),
    check(
      "county_manifest_cad_verification_check",
      sql`${t.cadVerification} IS NULL OR ${t.cadVerification} IN ('verified', 'partial', 'honestly_absent', 'pending')`,
    ),
  ],
);

export type CountyManifestRow = typeof countyManifest.$inferSelect;
export type CountyManifestInsert = typeof countyManifest.$inferInsert;
