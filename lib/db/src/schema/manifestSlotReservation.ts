import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manifestRun } from "./manifestRun";

/**
 * Active heavy-scan slot reservation for the County Manifest LIVE panel.
 *
 * `resourceKey` is an extensible string (default `heavy-scan-atoms-neon`) so
 * a parallel Neon advisory-lock design can add keys without a migration. At
 * most one OPEN reservation (`releasedAt IS NULL`) per resourceKey.
 */
export const manifestSlotReservation = pgTable(
  "manifest_slot_reservation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceKey: text("resource_key").notNull(),
    holderRunId: uuid("holder_run_id")
      .notNull()
      .references(() => manifestRun.id, { onDelete: "cascade" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("manifest_slot_reservation_active_uniq")
      .on(t.resourceKey)
      .where(sql`${t.releasedAt} IS NULL`),
    index("manifest_slot_reservation_holder_idx").on(t.holderRunId),
  ],
);

export type ManifestSlotReservationRow =
  typeof manifestSlotReservation.$inferSelect;
export type ManifestSlotReservationInsert =
  typeof manifestSlotReservation.$inferInsert;
