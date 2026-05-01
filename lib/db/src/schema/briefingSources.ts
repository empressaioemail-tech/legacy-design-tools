import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { parcelBriefings } from "./parcelBriefings";

/**
 * A *briefing source* is one cited overlay/data feed that contributed to
 * a parcel briefing — e.g. a manually-uploaded QGIS zoning export, a
 * federally-sourced ground-snow-load grid, etc. (Spec 51a §2.12).
 *
 * Two producers populate this table:
 *   - DA-PI-1B (this sprint): the manual-QGIS upload route accepts a
 *     file from the architect, stores it via object storage, and inserts
 *     a row with `sourceKind = "manual-upload"`.
 *   - DA-PI-2 (next sprint): the federal-data adapters fetch overlays
 *     from public APIs and insert rows with
 *     `sourceKind = "federal-adapter"`. Both producers share the same
 *     supersession contract below so the Site Context tab can render
 *     either kind without a producer-specific code path.
 *
 * Per-layer supersession (Spec 51 §4 reconciliation contract): a new
 * source for the same `(briefing_id, layer_kind)` pair *supersedes* the
 * prior one rather than replacing it in place. The prior row's
 * `superseded_by_id` points at the new row's id and `superseded_at` is
 * stamped; both rows stay readable so the timeline preserves the full
 * history while the "current" view is `WHERE superseded_by_id IS NULL`.
 *
 * `payload` (jsonb) holds the structured data the briefing engine will
 * read at resolution time: for a manual upload it carries the parsed
 * GeoJSON / GIS metadata (or just a small descriptor when the bytes
 * live in object storage); for an adapter fetch it is the adapter's
 * raw response. The `upload_*` columns are populated only on the
 * manual-upload branch and capture the file the user actually picked
 * (object storage path + original filename + content type + byte
 * size) so the UI can render a "1.3 MB zoning.geojson" tile without
 * re-fetching the bytes.
 */
export const briefingSources = pgTable(
  "briefing_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    briefingId: uuid("briefing_id")
      .notNull()
      .references(() => parcelBriefings.id, { onDelete: "cascade" }),
    /**
     * Slug identifying the overlay layer this source provides — e.g.
     * `qgis-zoning`, `qgis-parcel`, `fema-flood`, `nws-snow-load`.
     * Free-form text rather than a closed enum so DA-PI-2's adapters
     * can register new layer kinds without a schema migration; the
     * supersession unique index treats each distinct value as its own
     * "current source" slot.
     */
    layerKind: text("layer_kind").notNull(),
    /**
     * Producer flavor — `manual-upload` (DA-PI-1B) or `federal-adapter`
     * (DA-PI-2 and onward). Used for filtering and badge rendering.
     */
    sourceKind: text("source_kind").notNull(),
    /** Optional human-readable provider label (e.g. "City of Boulder QGIS export"). */
    provider: text("provider"),
    /**
     * The data's effective date — for a manual upload this is the
     * snapshot date the architect supplied (defaults to "now" when
     * absent); for an adapter it is the upstream feed's effective date.
     */
    snapshotDate: timestamp("snapshot_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    payload: jsonb("payload").notNull().default({}),
    /**
     * Object storage path (`/objects/<id>`) the manual upload landed at.
     * Null on the adapter branch.
     */
    uploadObjectPath: text("upload_object_path"),
    uploadOriginalFilename: text("upload_original_filename"),
    uploadContentType: text("upload_content_type"),
    uploadByteSize: integer("upload_byte_size"),
    /**
     * Optional free-text note from the producer (e.g. "exported from
     * QGIS 3.34 with the city's basemap layer applied").
     */
    note: text("note"),
    /**
     * Per-layer supersession pointer. Null while this row is still the
     * current source for its `(briefing_id, layer_kind)` slot; set to
     * the new row's id when a fresh upload of the same layer arrives.
     * Cycles cannot form since the supersession is strictly forward-in-
     * time (a row's superseder is always inserted later than itself).
     */
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => briefingSources.id,
      { onDelete: "set null" },
    ),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    briefingIdx: index("briefing_sources_briefing_idx").on(t.briefingId),
    /**
     * "Current source per layer" guard — at most one non-superseded row
     * per `(briefing_id, layer_kind)`. The write path stamps the prior
     * row's `supersededAt` *before* inserting the new row (and patches
     * the new row's id back into the prior row's `supersededById`
     * after), so this partial unique index enforces the contract even
     * under concurrent writes.
     *
     * The condition is on `superseded_at` rather than `superseded_by_id`
     * so the supersession write does not have to assign a real value to
     * `superseded_by_id` *before* the new row exists. (`superseded_by_id`
     * is the consumer-facing pointer; `superseded_at` is the
     * "no-longer-current" flag.)
     */
    currentPerLayerUniq: uniqueIndex("briefing_sources_current_layer_uniq")
      .on(t.briefingId, t.layerKind)
      .where(sql`${t.supersededAt} IS NULL`),
  }),
);

export const briefingSourcesRelations = relations(
  briefingSources,
  ({ one }) => ({
    briefing: one(parcelBriefings, {
      fields: [briefingSources.briefingId],
      references: [parcelBriefings.id],
    }),
    supersededBy: one(briefingSources, {
      fields: [briefingSources.supersededById],
      references: [briefingSources.id],
    }),
  }),
);

export type BriefingSource = typeof briefingSources.$inferSelect;
export type NewBriefingSource = typeof briefingSources.$inferInsert;
