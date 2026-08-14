import { pgTable, text, jsonb, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * L18 (P-14) — materialized county-ledger GET payload.
 *
 * GET /api/county-ledger used to recompute the 254 x N grid, scan
 * county_facet_coverage, and run COUNT DISTINCT probes on cad_property /
 * txgio_parcel on every request. Under an atoms drain that hung 300s with
 * zero bytes; a prior 200 could sit in the client as a silent days-old
 * grid. This singleton is the write-time materialization the GET serves
 * in constant time. `computed_at` is the freshness stamp; the route adds
 * `servedAt` at read time so a stale view is visible, never silently
 * plausible.
 *
 * Writers of county_rail / county_facet_coverage invoke
 * countyLedgerMaterializeCli --apply after scoring. No trigger: the
 * materialize includes heavy COUNT DISTINCT probes and must not fire on
 * every scorer upsert.
 *
 * id is constrained to 'current' — one row, overwritten in place.
 */
export const COUNTY_LEDGER_SNAPSHOT_ID = "current" as const;

export const countyLedgerSnapshot = pgTable(
  "county_ledger_snapshot",
  {
    id: text("id").primaryKey(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Full GET body minus servedAt (counties, manifestCells, railCapabilities, summary). */
    payload: jsonb("payload").notNull(),
  },
  (t) => [
    check(
      "county_ledger_snapshot_id_check",
      sql`${t.id} = 'current'`,
    ),
  ],
);

export type CountyLedgerSnapshotRow = typeof countyLedgerSnapshot.$inferSelect;
export type CountyLedgerSnapshotInsert =
  typeof countyLedgerSnapshot.$inferInsert;
