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
 * Server-persisted, shareable workspace spaces (Phase 2 shell experience).
 *
 * A named, updatable workspace-layout template (the NamedLayout model), stored
 * server-side so it survives a browser and can be shared by link. Replaces the
 * localStorage-only saved-spaces store.
 *
 * Tenancy-ready. Tenancy/auth is not live yet (anonymous default tenant); rows
 * are keyed today by the default tenant + the resolved owner id. The
 * (tenantId, ownerUserId) shape + the unique index make the table tenant-private
 * cleanly when the auth build lands — per-user isolation becomes a WHERE-clause
 * tightening, not a schema change.
 */
export const savedWorkspaceSpaces = pgTable(
  "saved_workspace_spaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Default tenant today; becomes the tenant-private partition under auth. */
    tenantId: text("tenant_id").notNull().default("default"),
    /** Resolved owner (anonymous or internal id today; real user under auth). */
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    /** Full SpaceSnapshot: tileIds, layoutId, colFr, rowFr, layoutMode. */
    snapshot: jsonb("snapshot").notNull(),
    /** Non-null, unique share token → read-only fetch by link. */
    shareToken: text("share_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("saved_workspace_spaces_owner_name_uidx").on(
      t.tenantId,
      t.ownerUserId,
      t.name,
    ),
    index("saved_workspace_spaces_owner_idx").on(
      t.tenantId,
      t.ownerUserId,
      t.updatedAt,
    ),
    // Share-link lookup. A plain unique index on a nullable column: Postgres
    // treats NULLs as distinct, so many un-shared rows (share_token NULL)
    // coexist while any minted token is unique. Declared here (not just in the
    // migration) so the drizzle-kit push the fixture-drift check runs produces
    // it, keeping the committed schema fixture in sync.
    uniqueIndex("saved_workspace_spaces_share_token_uidx").on(t.shareToken),
  ],
);

export type SavedWorkspaceSpaceRow = typeof savedWorkspaceSpaces.$inferSelect;
