import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * P-98 next-action rail — the activation event store, scoped to the PE USER.
 *
 * `gtm_events` is keyed on `install_id`, which is the browser extension's
 * anonymous install. A signed-in funnel cannot be measured on it: two
 * installs are one account, one install is two accounts after a sign-out,
 * and neither maps to the entitlement row the ladder actually reads. So this
 * is a separate table on the account spine (`users.id`), not a column added
 * to a store built for a different subject.
 *
 * WHAT A ROW MEANS. One rung of the next-action ladder was SHOWN to this
 * account, or its control was ACTED on. Nothing else. It is not a page view,
 * not a session, and not a conversion — a purchase is recorded by Stripe and
 * by `pe_property_unlocks`, and reading `acted` as revenue would be counting
 * an intent as an outcome.
 *
 * `event_type` carries BOTH a database CHECK and a TypeScript union. The
 * union stops every insert call site in this monorepo at compile time; the
 * CHECK stops anything the compiler never sees, including a raw connection
 * and any future job. The grammar is closed at two values and is not
 * expected to grow, which is what makes it safe to freeze in DDL.
 *
 * `action_id` is deliberately NOT constrained to a value list in DDL, and the
 * asymmetry is the point. The ladder's vocabulary grows every time a rung is
 * added, and a value list in the schema would mean a new rung silently loses
 * its events until a migration lands — the client drops failed events on
 * purpose, so that loss would be invisible. The closed set is enforced at the
 * route instead (see `peActivationEventsValidate.ts`), where a refusal is a
 * 400 the caller can read. The DDL check here is narrower and permanent: the
 * id may not be the empty string. That kills the sentinel, which is the case
 * a "not null" test would have passed.
 *
 * `surface` is NULLABLE WITH NO DEFAULT. `gtm_events.source_surface` defaults
 * to `'api'`, which invents an attribution for every event that never carried
 * one; an activation event whose surface was not sent is UNMEASURED, and that
 * is a different fact from one that happened on a surface named `api`. The
 * check permits null and forbids the empty string, so absent and present are
 * the only two states and neither can be faked by a blank.
 */

/** The event grammar. Closed at two values; mirrored by the DDL check. */
export type PeActivationEventType = "shown" | "acted";

export const peActivationEvents = pgTable(
  "pe_activation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull().$type<PeActivationEventType>(),
    actionId: text("action_id").notNull(),
    /** Absent = unmeasured. Never defaulted; see the file header. */
    surface: text("surface"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pe_activation_events_owner_user_id_created_at_idx").on(
      t.ownerUserId,
      t.createdAt,
    ),
    index("pe_activation_events_action_id_created_at_idx").on(
      t.actionId,
      t.createdAt,
    ),
    check("pe_activation_events_action_id_chk", sql`${t.actionId} <> ''`),
    check(
      "pe_activation_events_event_type_chk",
      sql`${t.eventType} IN ('shown', 'acted')`,
    ),
    check(
      "pe_activation_events_surface_chk",
      sql`${t.surface} IS NULL OR ${t.surface} <> ''`,
    ),
  ],
);

export type PeActivationEvent = typeof peActivationEvents.$inferSelect;
