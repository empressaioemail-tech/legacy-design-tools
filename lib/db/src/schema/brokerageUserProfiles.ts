import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export type BrokeragePackageTier = "free" | "pro" | "max";

export const brokerageUserProfiles = pgTable(
  "brokerage_user_profiles",
  {
    ownerUserId: text("owner_user_id").primaryKey(),
    tenantSlug: text("tenant_slug").notNull().default("default"),
    packageTier: text("package_tier")
      .notNull()
      .default("free")
      .$type<BrokeragePackageTier>(),
    buyBoxJson: jsonb("buy_box_json").notNull().default({}),
    investorProfileJson: jsonb("investor_profile_json").notNull().default({}),
    dialogueByClipJson: jsonb("dialogue_by_clip_json").notNull().default({}),
    depthMeterRemaining: integer("depth_meter_remaining").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("brokerage_user_profiles_tenant_idx").on(t.tenantSlug)],
);

export type BrokerageUserProfile = typeof brokerageUserProfiles.$inferSelect;
export type NewBrokerageUserProfile =
  typeof brokerageUserProfiles.$inferInsert;
