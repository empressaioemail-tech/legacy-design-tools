import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { snapshots } from "./snapshots";

/**
 * One row per snapshot that has had an IFC pushed to it (Track B sprint).
 * The Revit add-in POSTs `multipart/form-data` to
 * `POST /api/snapshots/:id/ifc` and the route persists the raw IFC bytes
 * to object storage, inserts a row here, and hands the row to the
 * web-ifc parser worker. The worker fills in `parsed_at` + `gltf_object_path`
 * on success or `parse_error` on failure.
 *
 * Identity: the FK on `snapshot_id` is `UNIQUE`, enforcing one IFC per
 * snapshot. Re-uploads (same snapshot, fresh IFC) upsert this row,
 * replace the blob, and re-parse — see the route for the upsert flow.
 */
export const snapshotIfcFiles = pgTable(
  "snapshot_ifc_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The snapshot this IFC was pushed against. UNIQUE — one IFC per
     * snapshot. Cascade-delete so dropping a snapshot cleans up its
     * IFC blob row (the GCS objects are best-effort cleaned by the
     * route's upsert path; dangling objects are tolerable).
     */
    snapshotId: uuid("snapshot_id")
      .notNull()
      .unique()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    /**
     * `/objects/uploads/<uuid>` path returned by ObjectStorageService
     * for the raw .ifc bytes. Always set — if storage upload fails
     * we don't insert this row.
     */
    blobObjectPath: text("blob_object_path").notNull(),
    /**
     * `/objects/uploads/<uuid>` path for the consolidated glTF cache
     * the parser produces from the IFC. Null until parse succeeds.
     */
    gltfObjectPath: text("gltf_object_path"),
    /**
     * Total bytes of the raw IFC file as reported by the multipart
     * stream. Captured for observability + capacity planning.
     */
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    /**
     * IFC schema version parsed from the file header (`IFC4`, `IFC2X3`,
     * `IFC4X3`, etc.). Null until the parser reads the header.
     */
    ifcVersion: text("ifc_version"),
    /**
     * Wall-clock duration the Revit add-in spent producing the IFC
     * export, reported in the multipart `metadata` part. Optional —
     * null when the add-in doesn't include it.
     */
    exportDurationMs: integer("export_duration_ms"),
    /**
     * Count of IFC entities the parser materialized into
     * `materializable_elements` rows. Null until parse succeeds; useful
     * for triage when a parse looks suspiciously sparse.
     */
    parseEntityCount: integer("parse_entity_count"),
    /**
     * When the parser finished writing atoms + glTF for this row.
     * Null while parse is pending; null on parse failure.
     */
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    /**
     * Failure message from the parser worker, if any. Null on success;
     * populated on web-ifc throw, OOM, or worker timeout. The blob is
     * preserved on error so we can re-attempt or hand-debug.
     */
    parseError: text("parse_error"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    parsedAtIdx: index("snapshot_ifc_files_parsed_at_idx").on(t.parsedAt),
  }),
);

export const snapshotIfcFilesRelations = relations(
  snapshotIfcFiles,
  ({ one }) => ({
    snapshot: one(snapshots, {
      fields: [snapshotIfcFiles.snapshotId],
      references: [snapshots.id],
    }),
  }),
);

export type SnapshotIfcFile = typeof snapshotIfcFiles.$inferSelect;
export type NewSnapshotIfcFile = typeof snapshotIfcFiles.$inferInsert;
