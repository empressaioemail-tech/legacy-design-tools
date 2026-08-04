import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * OPS-9 S1 onboarding ledger, the persisted record behind the pinned
 * `POST /api/onboarding-ledger/ingest` contract (hauska-engine's
 * preflight-and-report.mjs / cert-grade-and-report.mjs wrappers are the
 * writers; the Command Center County Ledger panel is the reader via the
 * additive GET /api/county-ledger extension).
 *
 * One row per finding: a pre-flight rail decline, a cert-grade
 * block13-quarantine parcel, or a future warden-sweep finding. `sourceKind`
 * names which of those wrote it. Distinct from `county_facet_coverage`
 * (coverage/correctness scorecard), this ledger is the onboarding-process
 * defect backlog, keyed on registry rows and parcels, not facets.
 *
 * Idempotent re-ingest: a natural key of
 * (rowId, parcelNodeId, defectClass, railOrCheck/checkId, status='open')
 * is deduped so re-running the same preflight/cert-grade pass never
 * duplicates an already-open finding; a re-seen finding instead bumps
 * `lastSeenAt`. See the partial unique index below (status='open' only ,
 * a resolved finding that recurs opens a fresh row, which is the desired
 * "regression" signal).
 */
export const onboardingLedgerEvent = pgTable(
  "onboarding_ledger_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    fips: text("fips").notNull(),
    rowId: text("row_id").notNull(),
    /** NULL for a row-level/rail-level finding (e.g. a pre-flight decline); set for a parcel-level finding (e.g. block13-quarantine). */
    parcelNodeId: text("parcel_node_id"),
    /** `preflight` | `cert-grade` | `block13-quarantine` | `warden-sweep`, matches the pinned contract's `sourceKind`. */
    sourceKind: text("source_kind").notNull(),
    /** The OPS-8 pre-flight check id (e.g. `railASourceReachable`), when this event came from a preflight rail. */
    railOrCheck: text("rail_or_check"),
    /** Alias carried alongside `railOrCheck` on the wire contract; stored separately since a future sourceKind may set one without the other. */
    checkId: text("check_id"),
    sweepId: text("sweep_id"),
    declineReason: text("decline_reason"),
    defectClass: text("defect_class").notNull(),
    severity: text("severity"),
    evidence: jsonb("evidence"),
    artifactRef: text("artifact_ref"),
    /** `open` | `resolved`. Defaults open; a future resolve-sweep flips this and stamps `resolvedAt`. */
    status: text("status").notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Bumped on every idempotent re-ingest that matches the open natural key, so the ledger can show "still failing as of". */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("onboarding_ledger_event_row_idx").on(t.rowId),
    index("onboarding_ledger_event_fips_idx").on(t.fips),
    index("onboarding_ledger_event_defect_class_idx").on(t.defectClass),
    index("onboarding_ledger_event_status_idx").on(t.status),
    // Idempotent-re-ingest dedupe key: only one OPEN finding per
    // (row, parcel, defect class, rail/check). A NULL parcelNodeId,
    // railOrCheck, or checkId still participates in the uniqueness (Postgres
    // treats NULLs as distinct in a unique index by default, which is safe
    // here because within one sourceKind the NULL-ness of these columns is
    // consistent, a preflight event always sets railOrCheck, a quarantine
    // event never does).
    uniqueIndex("onboarding_ledger_event_open_natural_key_idx")
      .on(t.rowId, t.parcelNodeId, t.defectClass, t.railOrCheck, t.checkId)
      .where(sql`${t.status} = 'open'`),
    check(
      "onboarding_ledger_event_source_kind_check",
      sql`${t.sourceKind} IN ('preflight', 'cert-grade', 'block13-quarantine', 'warden-sweep')`,
    ),
    check(
      "onboarding_ledger_event_status_check",
      sql`${t.status} IN ('open', 'resolved')`,
    ),
  ],
);

export type OnboardingLedgerEventRow =
  typeof onboardingLedgerEvent.$inferSelect;
export type OnboardingLedgerEventInsert =
  typeof onboardingLedgerEvent.$inferInsert;
