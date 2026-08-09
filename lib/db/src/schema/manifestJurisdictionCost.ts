import {
  pgTable,
  text,
  numeric,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { manifestRun } from "./manifestRun";

/**
 * Dual cost counters per jurisdiction for the County Manifest INTAKE panel.
 *
 * `commitmentCostUsd` — ONLY the first successful acquisition pass scores
 * against the sub-$200/jurisdiction commitment (operator ruling 2026-08-08;
 * re-warms excluded). NULL until that pass completes.
 *
 * `lifetimeCostUsd` — ALL runs including re-warms, because re-warm cost is
 * exactly what the rewarm-strategy question is about. Both numbers are kept
 * separate; never collapsed.
 */
export const manifestJurisdictionCost = pgTable("manifest_jurisdiction_cost", {
  countyFips: text("county_fips").primaryKey(),
  commitmentCostUsd: numeric("commitment_cost_usd", {
    precision: 10,
    scale: 2,
  }),
  lifetimeCostUsd: numeric("lifetime_cost_usd", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  firstAcquisitionRunId: uuid("first_acquisition_run_id").references(
    () => manifestRun.id,
    { onDelete: "set null" },
  ),
  firstAcquisitionRecordedAt: timestamp("first_acquisition_recorded_at", {
    withTimezone: true,
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ManifestJurisdictionCostRow =
  typeof manifestJurisdictionCost.$inferSelect;
export type ManifestJurisdictionCostInsert =
  typeof manifestJurisdictionCost.$inferInsert;
