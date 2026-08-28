import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const CRM_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
export type CrmStatus = (typeof CRM_STATUSES)[number];

/**
 * Tenant-scoped saved parcels for Property Explorer.
 * Isolation keyed on (tenantId, ownerUserId, parcelNodeId).
 * crmStatus / note are MCP CRM columns. Do not put them in snapshot.
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
    crmStatus: text("crm_status"),
    note: text("note"),
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
    check(
      "pe_saved_properties_crm_status_chk",
      sql`${t.crmStatus} IS NULL OR ${t.crmStatus} IN ('New', 'Watching', 'Chasing', 'Passed')`,
    ),
  ],
);

export type PeSavedProperty = typeof peSavedProperties.$inferSelect;
