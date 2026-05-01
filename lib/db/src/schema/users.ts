import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * User-profile lookup table for hydrating actor identities surfaced on
 * timeline / audit-trail responses.
 *
 * The `id` column is plain `text` (not a UUID, not an FK to anything) on
 * purpose: the api-server records actors as `{ kind, id }` where `id` is
 * whatever opaque identifier the upstream identity layer hands us — the
 * `pr_session` cookie carries arbitrary strings (`"u1"`, `"u_abc123"`,
 * eventually a Clerk/Replit Auth subject id), and the same id is later
 * written into `atom_events.actor.id`. We intentionally do NOT FK
 * `atom_events.actor.id → users.id` so a future identity-source swap or
 * a deleted profile cannot retroactively break the audit log — events
 * are the source of truth, the profile table is best-effort
 * presentation metadata.
 *
 * Only `kind === "user"` actors are looked up here. `agent` and `system`
 * actors carry their own stable display labels in code (e.g.
 * `snapshot-ingest`, `engagement-edit`) and are passed through unchanged
 * by the hydration helper.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
