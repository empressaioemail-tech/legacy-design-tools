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
import { users } from "./users";

export const CRM_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
export type CrmStatus = (typeof CRM_STATUSES)[number];

/**
 * Tenant-scoped saved parcels for Property Explorer.
 * Isolation keyed on (tenantId, ownerUserId, parcelNodeId).
 * crmStatus / note are MCP CRM columns. Do not put them in snapshot.
 *
 * OPS-16 P-111 (A-075/A-076) — `ownerUserId` FK added 2026-09-04. This table
 * previously had NO foreign key at all, so deleting a `users` row orphaned
 * every saved property permanently. Cascade matches the other thirteen
 * `users.id` references in this schema (e.g. `pePropertyUnlocks`,
 * `peWorkbenchState`): `onDelete: "cascade"`. Per the operator's same-day
 * ruling, this is beta data and does not need a careful backfill — see
 * migration 0097, which deletes existing orphans before adding the
 * constraint.
 */
export const peSavedProperties = pgTable(
  "pe_saved_properties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
