import { pgTable, text, integer, primaryKey } from "drizzle-orm/pg-core";

/**
 * PLR-11 — atomic, tenant-scoped permit-number counter. One row per
 * `(tenantId, year)`; `lastIssuedSeq` is incremented by an
 * `INSERT ... ON CONFLICT DO UPDATE RETURNING` so concurrent
 * approvals are serialized by the row lock and never collide.
 */
export const permitCounters = pgTable(
  "permit_counters",
  {
    tenantId: text("tenant_id").notNull(),
    year: integer("year").notNull(),
    lastIssuedSeq: integer("last_issued_seq").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.year] }),
  }),
);

export type PermitCounter = typeof permitCounters.$inferSelect;
