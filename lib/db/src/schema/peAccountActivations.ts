import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, index, check, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * P-100 item 4 — the first time an account did a thing.
 *
 * WHY THIS IS NOT `pe_activation_events`. That table (migration 0091) records
 * "a next-action ladder rung was SHOWN, or its control was ACTED on": many
 * rows per account per rung, with `event_type` frozen at shown/acted. A
 * once-per-account milestone is a different subject, and folding it in would
 * make every P-98 shown/acted ratio wrong by counting milestones as
 * impressions. Two subjects, two tables.
 *
 * ONCE PER ACCOUNT IS THE COMPOSITE PRIMARY KEY, not a route check and not a
 * SELECT-then-INSERT. The writer uses ON CONFLICT DO NOTHING and reads the
 * surviving row back, so a re-fire returns the ORIGINAL `firstAt` and reports
 * that it was not the first time. A second row is unrepresentable.
 *
 * THE MILESTONE SET IS CLOSED IN DDL, unlike `pe_activation_events.action_id`,
 * and the asymmetry is the same reasoning inverted. The ladder's action
 * vocabulary grows once per rung added, so a DDL value list there would
 * silently drop a new rung's events until a migration landed. This vocabulary
 * is three values fixed by the card that asked for it and is not expected to
 * grow, which is what makes it safe to freeze — and freezing it stops writers
 * the TypeScript union never sees: a raw connection, a future job, psql.
 */

/** The milestone grammar. Closed at three; mirrored by the DDL check. */
export type PeAccountActivationMilestone =
  | "first_parcel_inspected"
  | "first_property_saved"
  | "first_report_opened";

export const peAccountActivations = pgTable(
  "pe_account_activations",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    milestone: text("milestone").notNull().$type<PeAccountActivationMilestone>(),
    /** `null` = the caller sent no surface. NEVER a default. */
    surface: text("surface"),
    firstAt: timestamp("first_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "pe_account_activations_pkey",
      columns: [t.ownerUserId, t.milestone],
    }),
    index("pe_account_activations_milestone_first_at_idx").on(
      t.milestone,
      t.firstAt,
    ),
    check(
      "pe_account_activations_milestone_chk",
      sql`${t.milestone} IN ('first_parcel_inspected', 'first_property_saved', 'first_report_opened')`,
    ),
    check(
      "pe_account_activations_surface_chk",
      sql`${t.surface} IS NULL OR ${t.surface} <> ''`,
    ),
  ],
);

export type PeAccountActivation = typeof peAccountActivations.$inferSelect;
