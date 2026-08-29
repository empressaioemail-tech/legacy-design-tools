import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/** Property Explorer access tier — distinct from brokerage install-scoped tiers. */
export type PeAccessTier = "free" | "paid";

/**
 * Which rung of the LOCKED 2026-08-10 Smart Site ladder a paid subscription
 * is on (doc_repo `_inbox/2026-08-10_smartsite_pricing_and_gtm_LOCKED.md`).
 * `null` for free users and for users whose only entitlement is a
 * per-property unlock. `access_tier` stays the binary is-a-subscriber flag
 * every existing gate reads; this column carries the rung so Studio-only
 * surfaces (CAD, terrain, owner data) can gate on studio|team.
 */
export type PeSubscriptionTier = "solo" | "studio" | "team";

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
    /**
     * Ladder rung for `access_tier = 'paid'` subscribers (migration 0083).
     * Written only by the Stripe webhook. `null` = free, unlock-only, or a
     * legacy pre-ladder subscription (treated as solo at read time by the
     * entitlement snapshot, never silently upgraded to studio/team).
     */
    subscriptionTier: text("subscription_tier").$type<PeSubscriptionTier>(),
    /**
     * Checkout seat count on a Team subscription. NULL means unknown —
     * omit the field on the wire. Never store 0 to mean "we did not read
     * Stripe". A stored 0 is a fact (zero seats purchased).
     */
    seatsPurchased: integer("seats_purchased"),
  },
  (t) => [index("pe_user_entitlements_tenant_idx").on(t.tenantId)],
);

export type PeUserEntitlement = typeof peUserEntitlements.$inferSelect;
