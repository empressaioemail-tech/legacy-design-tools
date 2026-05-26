import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/** Full brief API response + metadata for research chat reload. */
export type BrokerageBriefRunPayload = Record<string, unknown>;

export const brokerageBriefRuns = pgTable(
  "brokerage_brief_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantSlug: text("tenant_slug").notNull().default("default"),
    listingKey: text("listing_key").notNull(),
    address: text("address").notNull(),
    payloadJson: jsonb("payload_json").notNull().$type<BrokerageBriefRunPayload>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("brokerage_brief_runs_listing_key_idx").on(
      t.listingKey,
      t.createdAt,
    ),
  ],
);
