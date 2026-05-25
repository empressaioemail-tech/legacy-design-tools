import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { engagements } from "./engagements";

export const coverageRequests = pgTable(
  "coverage_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    jurisdictionState: text("jurisdiction_state"),
    jurisdictionCity: text("jurisdiction_city"),
    jurisdictionFips: text("jurisdiction_fips"),
    note: text("note"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    openIdx: index("coverage_requests_open_idx").on(t.status, t.createdAt),
    engagementIdx: index("coverage_requests_engagement_idx").on(t.engagementId),
  }),
);

export type CoverageRequest = typeof coverageRequests.$inferSelect;
