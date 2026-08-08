import {
  pgTable,
  text,
  smallint,
  numeric,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * County Manifest Sprint 1 (feat/county-manifest-sprint1) — the rail
 * dimension.
 *
 * The 13 rails ruled required at
 * doc_repo `_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md`,
 * in ruled order. A lookup TABLE rather than a hardcoded TS constant,
 * because:
 *
 *  - threshold values are explicitly unfixed by the ruling and due for
 *    tuning; a table lets threshold tuning be a data UPDATE with an audit
 *    trail instead of a code deploy per tuning pass.
 *  - `atomFamilyState` / `hasWriter` are exactly the two facts that will
 *    change over time (a contract publish flips a rail from `unpublished`
 *    to `present`; a new scorer flips a rail's writer bit) — a table
 *    makes that a live queryable fact instead of a doc-layer claim that
 *    drifts from code.
 *  - introducing a NEW hardcoded 13-entry TS constant would repeat the
 *    exact anti-pattern this sprint retires (`COUNTY_NAMES`, the
 *    hardcoded 10-entry map this sprint replaces in
 *    `countyCoverageScoreCli.ts`).
 *
 * `atomFamilyState` / `hasWriter` are DECLARED FACTS, not enforcement —
 * updating them here does not create an atom or wire a writer. See
 * doc_repo `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md` section 2.
 *
 * Query-time precedence (implemented in `countyLedger.ts`'s
 * `readManifestGrid`): if `atomFamilyState != 'present'` the cell
 * displays `no-atom` regardless of any `county_facet_coverage` row; else
 * if `hasWriter = false` the cell displays `no-writer`; else the cell
 * falls through to the stored `rail_state` (or `not-yet` if no row
 * exists). `no-atom` / `no-writer` are deliberately NOT stored per-cell —
 * they are rail-level facts true for all 254 counties simultaneously, so
 * storing them per-cell would need 254 identical writes on every
 * atom/writer status change and would create a second source of truth
 * for a fact this table already holds once.
 */
export const countyRail = pgTable(
  "county_rail",
  {
    /** e.g. `geometry`, `cad`, `zoning`. Matches countyFacetCoverage.facet values for the 3 rails that already have writers. */
    railKey: text("rail_key").primaryKey(),
    displayName: text("display_name").notNull(),
    /** Ruled display order, 1-13. */
    ordinal: smallint("ordinal").notNull().unique("county_rail_ordinal_unique"),
    /** The OPS-1 rail letter (A/B/C/D) for the 4 rails that carry one; NULL for rails outside that lettering. */
    railLetter: text("rail_letter"),
    /** spine | derived. */
    kind: text("kind").notNull(),
    /** SATISFIED-vs-PARTIAL comparison point, ruling 3's tuning start (95 spine / 90 derived). Not fixed — a one-row UPDATE, no migration, to retune. */
    thresholdPct: numeric("threshold_pct", { precision: 5, scale: 2 }).notNull(),
    /** present | missing | partial | unpublished. Query-time no-atom precedence key — see class doc above. */
    atomFamilyState: text("atom_family_state").notNull(),
    /** The atom contract type(s) backing this rail, when any; free text (e.g. `zoning-fact, setback-rule (contract)`). */
    atomFamilyRef: text("atom_family_ref"),
    /** Whether a scorer/writer emits this facet today. Query-time no-writer precedence key. */
    hasWriter: boolean("has_writer").notNull().default(false),
    /** Where the writer lives, when one exists (file:line or CLI name). */
    writerRef: text("writer_ref"),
    /** The declared acquisition source for this rail (e.g. "TxGIO StratMap bulk zip per FIPS"). */
    declaredSource: text("declared_source").notNull(),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check("county_rail_kind_check", sql`${t.kind} IN ('spine', 'derived')`),
    check(
      "county_rail_atom_family_state_check",
      sql`${t.atomFamilyState} IN ('present', 'missing', 'partial', 'unpublished')`,
    ),
  ],
);

export type CountyRailRow = typeof countyRail.$inferSelect;
export type CountyRailInsert = typeof countyRail.$inferInsert;
