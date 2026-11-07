import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

/**
 * T2-WATCH (Smart Site mobile, 2026-10-22) — the Watching tab.
 *
 * Every saved property (`pe_saved_properties`) is watched. A scheduled job in
 * cortex (`artifacts/api-server/src/lib/peWatching.ts`) reads each saved
 * parcel through the same one-door record read the card uses, compares the
 * watched facts with the last snapshot here, and writes one
 * `pe_watch_changes` row per detected change. The first read of a parcel
 * only snapshots; it never alerts.
 *
 * All three tables cascade off `users`, so account delete clears them; the
 * duplicate-account merge moves them (`peAccountMerge.ts` TABLES).
 */

/**
 * The last watched-fact snapshot for one (user, parcel).
 *
 * `facts` maps a watched key (a one-door rail key, or `recordsRequest`) to
 * `{ c, w }`: `c` the canonical value (a sha256 for plan-gated rails, so no
 * dollar figure is stored here) and `w` the reader's own words. `facts_hash`
 * is NULL until the first successful read (a claimed, never-read row).
 * `checked_at` is the claim time (the per-row scheduler lease);
 * `last_read_at` the last successful read, which is what the UI shows.
 */
export const peWatchSnapshots = pgTable(
  "pe_watch_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parcelNodeId: text("parcel_node_id").notNull(),
    factsHash: text("facts_hash"),
    facts: jsonb("facts").notNull().default({}),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pe_watch_snapshots_owner_parcel_uidx").on(
      t.ownerUserId,
      t.parcelNodeId,
    ),
    index("pe_watch_snapshots_checked_idx").on(t.checkedAt),
  ],
);

export const PE_WATCH_CHANGE_KINDS = [
  "flood_map",
  "zoning_case",
  "appraisal",
  "records_request",
  "record_update",
] as const;
export type PeWatchChangeKind = (typeof PE_WATCH_CHANGE_KINDS)[number];

/** One detected change on a watched parcel. `seen_at` is set by the Watching tab. */
export const peWatchChanges = pgTable(
  "pe_watch_changes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parcelNodeId: text("parcel_node_id").notNull(),
    kind: text("kind").notNull().$type<PeWatchChangeKind>(),
    title: text("title").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    sourceUrl: text("source_url"),
  },
  (t) => [
    index("pe_watch_changes_owner_detected_idx").on(
      t.ownerUserId,
      t.detectedAt,
    ),
    check(
      "pe_watch_changes_kind_chk",
      sql`${t.kind} IN ('flood_map', 'zoning_case', 'appraisal', 'records_request', 'record_update')`,
    ),
  ],
);

/**
 * A Web Push subscription (one browser/device). `endpoint` is unique: a
 * device re-subscribing under another account moves to that account. A 404 or
 * 410 from the push service deletes the row; any other failure counts up.
 */
export const pePushSubscriptions = pgTable(
  "pe_push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    /** `{ p256dh, auth }` from PushSubscription.toJSON().keys. */
    keys: jsonb("keys").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    failures: integer("failures").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("pe_push_subscriptions_endpoint_uidx").on(t.endpoint),
    index("pe_push_subscriptions_owner_idx").on(t.ownerUserId),
  ],
);

export type PeWatchSnapshot = typeof peWatchSnapshots.$inferSelect;
export type PeWatchChange = typeof peWatchChanges.$inferSelect;
export type PePushSubscription = typeof pePushSubscriptions.$inferSelect;
