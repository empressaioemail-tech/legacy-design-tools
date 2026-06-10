import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { brokerageBriefRuns } from "./brokerageBriefRuns";

export const brokerageWorkspaces = pgTable(
  "brokerage_workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installId: text("install_id").notNull(),
    /** Set when install history is claimed by an authenticated user. */
    ownerUserId: text("owner_user_id"),
    listingKey: text("listing_key").notNull(),
    address: text("address").notNull(),
    sourceListingUrl: text("source_listing_url"),
    latestRunId: uuid("latest_run_id").references(() => brokerageBriefRuns.id),
    llUuid: text("ll_uuid"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("brokerage_workspaces_install_listing_key_uidx").on(
      t.installId,
      t.listingKey,
    ),
    index("brokerage_workspaces_install_opened_idx").on(
      t.installId,
      t.openedAt,
    ),
    index("brokerage_workspaces_owner_user_id_idx").on(
      t.ownerUserId,
      t.openedAt,
    ),
  ],
);

export type BrokerageAttachmentKind = "link" | "image" | "pdf" | "note";

export const brokerageWorkspaceAttachments = pgTable(
  "brokerage_workspace_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => brokerageWorkspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<BrokerageAttachmentKind>(),
    uri: text("uri"),
    body: text("body"),
    title: text("title"),
    createdByInstallId: text("created_by_install_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("brokerage_workspace_attachments_workspace_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
  ],
);

export const brokerageWorkspaceShares = pgTable(
  "brokerage_workspace_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => brokerageWorkspaces.id, { onDelete: "cascade" }),
    ownerInstallId: text("owner_install_id").notNull(),
    shareToken: text("share_token").notNull(),
    collaboratorInstallId: text("collaborator_install_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("brokerage_workspace_shares_token_uidx").on(t.shareToken),
  ],
);
