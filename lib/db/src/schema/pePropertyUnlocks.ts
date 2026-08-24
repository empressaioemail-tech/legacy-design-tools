import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * R1 paywall (LOCK 2026-07-29) — per-property $15 unlock record.
 *
 * One row per (ownerUserId, tenantId, parcelNodeId): "this user unlocked
 * this property" — bounded by `expires_at` (30 days for Stripe purchases per
 * the LOCKED 2026-08-10 ladder; `null` = unbounded legacy/dev rows). A
 * property is entitled when the user is a subscriber
 * (`pe_user_entitlements.access_tier = 'paid'`) OR an unexpired row exists here.
 * `source` records what wrote the unlock: `'stub'` (default), `'dev'`
 * (operator dev-unlock route), later `'stripe'` when the one-time payment
 * flow lands — the writer interface is the same, live charging is a
 * separate isolated wave.
 */
export const pePropertyUnlocks = pgTable(
  "pe_property_unlocks",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull().default("default"),
    parcelNodeId: text("parcel_node_id").notNull(),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    source: text("source").notNull().default("stub"),
    /**
     * 30-day bound per the LOCKED 2026-08-10 ladder ("$15, 30 days — not
     * forever"; migration 0083). `null` = no expiry: legacy rows written
     * before the bound existed, and operator dev unlocks. Stripe-sourced
     * unlocks always carry `unlocked_at + 30 days`. Entitlement reads
     * treat an expired row as absent.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.ownerUserId, t.tenantId, t.parcelNodeId] })],
);

export type PePropertyUnlock = typeof pePropertyUnlocks.$inferSelect;
