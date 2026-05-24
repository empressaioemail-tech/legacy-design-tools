import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { engagements } from "./engagements";
import { snapshots } from "./snapshots";
import { submissions } from "./submissions";

export const PACKAGE_TEMPLATE_VALUES = [
  "client-presentation",
  "client-review",
  "publisher-handoff",
  "jurisdiction-manifest",
] as const;
export type PackageTemplateValue = (typeof PACKAGE_TEMPLATE_VALUES)[number];

export const PACKAGE_STATUS_VALUES = [
  "draft",
  "exported",
  "shared",
  "handed-off",
  "closed",
] as const;
export type PackageStatusValue = (typeof PACKAGE_STATUS_VALUES)[number];

export interface PackageSelectionJson {
  includeIntake?: boolean;
  includeBriefing?: boolean;
  renderIds?: string[];
  videoIds?: string[];
  sheetIds?: string[];
  heroRenderId?: string | null;
}

export interface PackageFormSnapshotJson {
  publisherIntake?: Record<string, unknown>;
  clientHeadline?: string;
  clientTalkingPoints?: string;
  clientReviewNote?: string;
}

export const engagementPackages = pgTable(
  "engagement_packages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    template: text("template").notNull(),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull(),
    snapshotId: uuid("snapshot_id").references(() => snapshots.id, {
      onDelete: "set null",
    }),
    selection: jsonb("selection").notNull().default({}),
    formSnapshot: jsonb("form_snapshot"),
    clientReviewDeadline: timestamp("client_review_deadline", {
      withTimezone: true,
    }),
    linkedSubmissionId: uuid("linked_submission_id").references(
      () => submissions.id,
      { onDelete: "set null" },
    ),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index("engagement_packages_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
  }),
);

export const packageShares = pgTable(
  "package_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => engagementPackages.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tokenUniq: uniqueIndex("package_shares_token_uniq").on(t.token),
    packageIdx: index("package_shares_package_idx").on(t.packageId),
  }),
);

export const packageShareComments = pgTable(
  "package_share_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shareId: uuid("share_id")
      .notNull()
      .references(() => packageShares.id, { onDelete: "cascade" }),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    sheetId: uuid("sheet_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    shareCreatedIdx: index("package_share_comments_share_created_idx").on(
      t.shareId,
      t.createdAt,
    ),
  }),
);

export type EngagementPackage = typeof engagementPackages.$inferSelect;
export type NewEngagementPackage = typeof engagementPackages.$inferInsert;
export type PackageShare = typeof packageShares.$inferSelect;
export type PackageShareComment = typeof packageShareComments.$inferSelect;
