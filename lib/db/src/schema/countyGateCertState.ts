import { pgTable, text, integer, jsonb, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * OPS-9 S1 onboarding ledger, per-registry-row OPS-8 pre-flight gate state
 * + cert-grade state, written by the pinned
 * `POST /api/onboarding-ledger/ingest` contract's `gateSummary` /
 * `certSummary` payloads (hauska-engine's preflight-and-report.mjs /
 * cert-grade-and-report.mjs). One row per `rowId`, upserted on every
 * ingest call for that row.
 *
 * This table is the successor to reading gate/cert state off
 * `county_facet_coverage.onboarded` / `.certState` for the OPS-9 onboarding
 * surface: the GET /api/county-ledger extension in countyLedger.ts treats
 * those two columns as DEPRECATED for the new per-row gate/cert view (their
 * data is not migrated or deleted, they still serve their original
 * coverage-scorecard purpose on `county_facet_coverage` itself).
 */
export const countyGateCertState = pgTable("county_gate_cert_state", {
  rowId: text("row_id").primaryKey(),
  fips: text("fips").notNull(),
  gatePassCount: integer("gate_pass_count"),
  gateDeclineCount: integer("gate_decline_count"),
  /** Array of `{ id, outcome, reason? }` per the pinned contract's `gateSummary.checks`. */
  gateChecks: jsonb("gate_checks"),
  certLabel: text("cert_label"),
  certBlockPass: boolean("cert_block_pass"),
  /** Array of `{ rail, declineReason, defectClass }` per `deriveScopeAnnotations` in the engine. */
  certScopeAnnotations: jsonb("cert_scope_annotations"),
  certGradedAt: timestamp("cert_graded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type CountyGateCertStateRow = typeof countyGateCertState.$inferSelect;
export type CountyGateCertStateInsert =
  typeof countyGateCertState.$inferInsert;
