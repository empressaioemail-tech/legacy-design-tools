import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Tenant-scoped saved parcels for Property Explorer.
 * Isolation keyed on (tenantId, ownerUserId, parcelNodeId).
 */
export const peSavedProperties = pgTable(
  "pe_saved_properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    ownerUserId: text("owner_user_id").notNull(),
    /** Stable baked-node id, e.g. "48055:10068". */
    parcelNodeId: text("parcel_node_id").notNull(),
    label: text("label"),
    snapshot: jsonb("snapshot").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pe_saved_properties_owner_parcel_uidx").on(
      t.tenantId,
      t.ownerUserId,
      t.parcelNodeId,
    ),
    index("pe_saved_properties_owner_idx").on(
      t.tenantId,
      t.ownerUserId,
      t.updatedAt,
    ),
  ],
);

export type PeSavedProperty = typeof peSavedProperties.$inferSelect;
