import {
  pgTable,
  uuid,
  text,
  integer,
  customType,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { snapshots } from "./snapshots";
import { engagements } from "./engagements";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const sheets = pgTable(
  "sheets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    sheetNumber: text("sheet_number").notNull(),
    sheetName: text("sheet_name").notNull(),
    viewCount: integer("view_count"),
    revisionNumber: text("revision_number"),
    revisionDate: text("revision_date"),
    thumbnailPng: bytea("thumbnail_png").notNull(),
    thumbnailWidth: integer("thumbnail_width").notNull(),
    thumbnailHeight: integer("thumbnail_height").notNull(),
    fullPng: bytea("full_png").notNull(),
    fullWidth: integer("full_width").notNull(),
    fullHeight: integer("full_height").notNull(),
    sortOrder: integer("sort_order").notNull(),
    /**
     * Optional vision-pipeline output: free-text body of in-sheet
     * notes / callouts. Drives PLR-8 cross-reference link extraction.
     * Null until the vision/OCR pipeline lands and starts populating.
     */
    contentBody: text("content_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    snapshotSortIdx: index("sheets_snapshot_sort_idx").on(
      t.snapshotId,
      t.sortOrder,
    ),
    engagementNumberIdx: index("sheets_engagement_number_idx").on(
      t.engagementId,
      t.sheetNumber,
    ),
    snapshotNumberUnique: uniqueIndex("sheets_snapshot_number_unique").on(
      t.snapshotId,
      t.sheetNumber,
    ),
  }),
);

export const sheetsRelations = relations(sheets, ({ one }) => ({
  snapshot: one(snapshots, {
    fields: [sheets.snapshotId],
    references: [snapshots.id],
  }),
  engagement: one(engagements, {
    fields: [sheets.engagementId],
    references: [engagements.id],
  }),
}));

export type Sheet = typeof sheets.$inferSelect;
export type NewSheet = typeof sheets.$inferInsert;
