import { pgTable, text, date, integer, primaryKey } from "drizzle-orm/pg-core";

/** Per-user usage counters for self-serve metering (rail-quiet). */
export const userUsageMetering = pgTable(
  "user_usage_metering",
  {
    ownerUserId: text("owner_user_id").notNull(),
    meterKey: text("meter_key").notNull(),
    periodStart: date("period_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.ownerUserId, t.meterKey, t.periodStart],
    }),
  }),
);

export type UserUsageMeteringRow = typeof userUsageMetering.$inferSelect;
