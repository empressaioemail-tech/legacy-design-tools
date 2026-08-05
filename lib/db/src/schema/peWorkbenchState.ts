import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user Property Explorer workbench tool state (WDLL 2026-08-05 item 6
 * — anonymous claim). Anonymous pre-auth workbench hints (last tool used,
 * panel layout, etc.) are uploaded once via `claim-local-state` on sign-in
 * so they are not orphaned by the auth flip. One row per user; later
 * uploads overwrite (this is UI-state, not user content — unlike
 * `pe_saved_properties`, which is merged, never overwritten).
 */
export const peWorkbenchState = pgTable("pe_workbench_state", {
  ownerUserId: text("owner_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().default("default"),
  state: jsonb("state").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type PeWorkbenchState = typeof peWorkbenchState.$inferSelect;
