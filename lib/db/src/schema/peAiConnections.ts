import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * MCP clients that have authenticated against a Smart Site account (P-87).
 *
 * One row per (account, client name). Written by the Smart Site MCP server
 * from the JSON-RPC `initialize` handshake, which is the only message that
 * carries `clientInfo`. Claude performs that handshake the moment a custom
 * connector finishes its OAuth approval, so the row appears at connect time
 * rather than at first tool call.
 *
 * `clientName` is NOT NULL with no default. An initialize with no resolvable
 * `clientInfo.name` writes no row at all — see the migration header. The Claude
 * Sync card reads this table to choose between its setup state and its sync
 * state, so a fabricated or defaulted name here would render a Sync button for
 * a connection nobody ever made.
 *
 * `lastSeenAt` is the most recent initialize, NOT the most recent tool call.
 * Present it as "last seen"; "last used" would be a claim this table cannot
 * support.
 */
export const peAiConnections = pgTable(
  "pe_ai_connections",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientName: text("client_name").notNull(),
    clientVersion: text("client_version"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pe_ai_connections_owner_client_uidx").on(
      t.ownerUserId,
      t.clientName,
    ),
    index("pe_ai_connections_owner_idx").on(t.ownerUserId),
  ],
);

export type PeAiConnection = typeof peAiConnections.$inferSelect;
