import { boolean, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Property Explorer access tier — distinct from brokerage install-scoped tiers. */
export type PeAccessTier = "free" | "paid";

/**
 * Provenance of a paid entitlement (WDLL 2026-08-05 item 1). `null` for
 * free-tier rows. `stripe_unlock` is informational — the row of record for
 * a per-property unlock is `pe_property_unlocks.source`, not this column.
 */
export type PeEntitlementSource =
  | "stripe_sub"
  | "stripe_promo"
  | "stripe_unlock"
  | "dev";

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
    /**
     * Operator-grantable dev role (WDLL 2026-08-05 item 4). Replaces the
     * PE_DEV_PAID_EMAILS / PE_DEV_PAID_SUBJECTS env allowlists as the source
     * `hasPeDevPaidBypass` reads — flip via the internal service-key route,
     * no deploy required, revocation closes gates within one entitlement
     * refresh.
     */
    devRole: boolean("dev_role").notNull().default(false),
    entitlementSource: text("entitlement_source").$type<PeEntitlementSource>(),
    /** Stripe Customer id, set on first checkout session for this user. */
    stripeCustomerId: text("stripe_customer_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("pe_user_entitlements_tenant_idx").on(t.tenantId)],
);

export type PeUserEntitlement = typeof peUserEntitlements.$inferSelect;
