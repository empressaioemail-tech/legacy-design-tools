import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * P-86 share grant registry. The resolvable URL carries this id.
 * HMAC tokens are not stored here and never appear in the path.
 */
export const peShareGrants = pgTable(
  "pe_share_grants",
  {
    id: text("id").primaryKey(),
    grantorUserId: text("grantor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantorTenantId: text("grantor_tenant_id").notNull(),
    parcelNodeId: text("parcel_node_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("pe_share_grants_grantor_idx").on(t.grantorUserId, t.createdAt),
    index("pe_share_grants_parcel_idx").on(t.parcelNodeId),
  ],
);

export type PeShareGrant = typeof peShareGrants.$inferSelect;
