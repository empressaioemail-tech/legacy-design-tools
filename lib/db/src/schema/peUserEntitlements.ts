import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Property Explorer access tier — distinct from brokerage install-scoped tiers. */
export type PeAccessTier = "free" | "paid";

/**
 * User-scoped entitlement for Property Explorer deep routes.
 * Defaults to free on first OIDC sign-in; paid unlocks R1–R10 deep work.
 */
export const peUserEntitlements = pgTable(
  "pe_user_entitlements",
  {
    ownerUserId: text("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull().default("default"),
    accessTier: text("access_tier")
      .notNull()
      .default("free")
      .$type<PeAccessTier>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("pe_user_entitlements_tenant_idx").on(t.tenantId)],
);

export type PeUserEntitlement = typeof peUserEntitlements.$inferSelect;
