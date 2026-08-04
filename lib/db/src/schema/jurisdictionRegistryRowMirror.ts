import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * OPS-9 S1 onboarding ledger, a read-side MIRROR of hauska-engine's frozen
 * `JurisdictionRegistryRow` (engine `src/registry/jurisdiction-registry.ts`,
 * which stays the source of truth). Written by the pinned
 * `POST /api/onboarding-ledger/ingest` contract's `rowMirror` payload so the
 * Command Center County Ledger panel can join a row's onboarding-ledger
 * state without legacy-design-tools reaching into the engine repo's
 * registry directly. Upserted on every ingest call that carries a
 * `rowMirror` entry for that row.
 */
export const jurisdictionRegistryRowMirror = pgTable(
  "jurisdiction_registry_row_mirror",
  {
    rowId: text("row_id").primaryKey(),
    fips: text("fips").notNull(),
    countyName: text("county_name").notNull(),
    status: text("status").notNull(),
    zoningRegime: text("zoning_regime").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export type JurisdictionRegistryRowMirrorRow =
  typeof jurisdictionRegistryRowMirror.$inferSelect;
export type JurisdictionRegistryRowMirrorInsert =
  typeof jurisdictionRegistryRowMirror.$inferInsert;
