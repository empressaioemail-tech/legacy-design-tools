import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { parcelBriefings } from "./parcelBriefings";
import { briefingSources } from "./briefingSources";
import { engagements } from "./engagements";
import { snapshots } from "./snapshots";

/**
 * The eight element kinds the materialization layer knows about. The first
 * seven are the Spec 51a §2.4 / Spec 53 §4 briefing-derived geometry kinds
 * the C# Revit add-in materializes — terrain, property-line, setback-plane,
 * buildable-envelope, floodplain, wetland, neighbor-mass. Mirrors the
 * `DXF_LAYER_KINDS` tuple in `artifacts/api-server/src/lib/converterClient.ts`:
 * every briefing-derived element either points at a converted glb (terrain,
 * setback-plane, buildable-envelope, neighbor-mass) or carries polygon
 * coordinates the add-in reconstructs natively (property-line, floodplain,
 * wetland).
 *
 * The eighth kind, `as-built-ifc`, is the IFC-ingest discriminator (Track B
 * sprint): rows with this `elementKind` are produced by the server-side
 * web-ifc parser when an architect pushes a Revit-exported IFC. The C# add-in
 * does NOT need to mirror this value — IFC rows are filtered out at the
 * add-in-facing read path in `routes/bimModels.ts:loadElementsForBriefing`.
 */
export const MATERIALIZABLE_ELEMENT_KINDS = [
  "terrain",
  "property-line",
  "setback-plane",
  "buildable-envelope",
  "floodplain",
  "wetland",
  "neighbor-mass",
  "as-built-ifc",
] as const;

export type MaterializableElementKind =
  (typeof MATERIALIZABLE_ELEMENT_KINDS)[number];

/**
 * Closed tuple of provenance/lens values for `source_kind`. This is the
 * one-table-many-lenses discriminator (Track B sprint): the same physical
 * table holds briefing-derived design requirements and as-built IFC rows;
 * read paths filter by `source_kind` to project the lens they need.
 *
 * Values:
 *   - `briefing-derived`: the originally-intended row, emitted by the
 *     briefing engine from parcel-briefing sourced overlays.
 *   - `as-built-ifc`: per-IFC-entity row produced by the IFC-ingest parser.
 *     Carries the IFC GUID, IFC type, and Pset_*Common attributes; geometry
 *     is held off-row in the consolidated glTF cache (see
 *     `as-built-ifc-bundle`).
 *   - `as-built-ifc-bundle`: a single synthetic per-IFC-ingest row that
 *     carries the consolidated glTF object path. The viewer renders this
 *     row's GLB; per-entity `as-built-ifc` rows stay lean (no GLB).
 */
export const MATERIALIZABLE_ELEMENT_SOURCE_KINDS = [
  "briefing-derived",
  "as-built-ifc",
  "as-built-ifc-bundle",
] as const;

export type MaterializableElementSourceKind =
  (typeof MATERIALIZABLE_ELEMENT_SOURCE_KINDS)[number];

/**
 * A *materializable-element* (DA-PI-5 / Spec 51a §2.4) is one piece
 * of geometry the materialization pipeline tracks — either a briefing-
 * derived design requirement the C# Revit add-in reconstructs (a Toposolid
 * surface, a setback plane, a buildable-envelope mass, etc.) or an IFC-
 * derived as-built entity ingested from an architect's Revit IFC export.
 *
 * `source_kind` discriminates the provenance lens (briefing-derived vs.
 * as-built IFC). `element_kind` discriminates the geometry payload shape:
 * one of the seven Spec-defined briefing-derived kinds, or `as-built-ifc`
 * for IFC-derived rows.
 *
 * `geometry` (jsonb) carries the structured payload the add-in reconstructs
 * from — for `buildable-envelope` it is a polygon ring of (x, y, z) tuples
 * lifted from the briefing's glb artifact; for `setback-plane` it is the
 * plane normal + offset; for `as-built-ifc` rows it is `{}` and the
 * geometry lives in the consolidated `as-built-ifc-bundle` row's glTF.
 *
 * `briefingSourceId` is the cited source the geometry came from
 * (Spec 51 §4 reconciliation contract — every materialized element
 * is auditable back to the briefing source it was derived from).
 * Null for engine-synthesized briefing-derived elements (e.g. a setback
 * plane derived from zoning rules + the parcel polygon — neither is the
 * unique source) and for as-built IFC rows.
 */
export const materializableElements = pgTable(
  "materializable_elements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The briefing this element was emitted by. NULLABLE as of the Track B
     * IFC ingest sprint: as-built IFC rows have no briefing. The CHECK
     * constraint below enforces that briefing-derived rows still set this.
     */
    briefingId: uuid("briefing_id").references(() => parcelBriefings.id, {
      onDelete: "cascade",
    }),
    /**
     * Engagement scope. Denormalized so IFC rows (which have no briefing)
     * can be looked up by engagement, and so the viewer's lens-filtered
     * fetch on `(engagement_id, source_kind)` is index-served. Nullable —
     * legacy briefing-derived rows continue to be reachable via
     * `briefing_id → parcel_briefings.engagement_id`. The CHECK constraint
     * below requires it for IFC rows.
     */
    engagementId: uuid("engagement_id").references(() => engagements.id, {
      onDelete: "cascade",
    }),
    /**
     * Provenance/lens discriminator. One of {@link MATERIALIZABLE_ELEMENT_SOURCE_KINDS}.
     * Defaults to `briefing-derived` so existing rows backfill cleanly and
     * tests that only set `briefingId` + `elementKind` continue to insert
     * unchanged.
     */
    sourceKind: text("source_kind")
      .notNull()
      .default("briefing-derived")
      .$type<MaterializableElementSourceKind>(),
    /**
     * One of {@link MATERIALIZABLE_ELEMENT_KINDS}. Stored as text
     * so DA-PI-3 can extend the discriminator without a schema
     * migration; the route layer validates against the closed tuple
     * before insert.
     */
    elementKind: text("element_kind")
      .notNull()
      .$type<MaterializableElementKind>(),
    /**
     * Optional pointer at the briefing source this element was
     * derived from. Null for engine-synthesized briefing-derived
     * elements and for as-built IFC rows.
     */
    briefingSourceId: uuid("briefing_source_id").references(
      () => briefingSources.id,
      { onDelete: "set null" },
    ),
    /**
     * Free-text label the C# side surfaces in the Revit UI — e.g.
     * "Front setback (15 ft)". Optional; the discriminator + a
     * synthesized fallback covers the case when the briefing engine
     * has nothing better to offer. For IFC rows, populated from
     * `IfcRoot.Name` when present.
     */
    label: text("label"),
    /**
     * Structured geometry payload the C# add-in reconstructs from.
     * Shape is discriminator-dependent — see the file docstring for
     * the per-kind conventions. Defaults to `{}` so the briefing
     * engine can register an element before the geometry pass has
     * filled it in.
     */
    geometry: jsonb("geometry").notNull().default({}),
    /**
     * If the element points at a glb artifact rather than carrying
     * polygon data inline, the converted bytes live at this path.
     * Mirrors `briefing_sources.glbObjectPath` and is null for
     * elements whose geometry is fully described by `geometry`.
     *
     * For IFC ingest, only the `as-built-ifc-bundle` row carries this;
     * per-entity `as-built-ifc` rows leave it null and the viewer
     * renders the bundle's consolidated glTF.
     */
    glbObjectPath: text("glb_object_path"),
    /**
     * Locked elements cannot be unpinned in Revit without emitting
     * a `briefing-divergence` event back to design-tools. Defaults
     * to `true` because most briefing-derived geometry is meant to
     * be authoritative; the engine can opt elements out by setting
     * `false` for advisory-only overlays. The IFC ingest path sets
     * `false` for as-built rows — the architect already authored them.
     */
    locked: boolean("locked").notNull().default(true),
    /**
     * IFC `GlobalId` (the stable 22-character GUID encoding) for IFC
     * rows. Null for briefing-derived rows. The CHECK constraint
     * below requires this for `as-built-ifc` and
     * `as-built-ifc-bundle` rows.
     */
    ifcGlobalId: text("ifc_global_id"),
    /**
     * IFC entity type — `IfcWall`, `IfcDoor`, `IfcSpace`, etc. — for
     * IFC rows. Null for briefing-derived rows. The CHECK constraint
     * below requires this for IFC rows.
     */
    ifcType: text("ifc_type"),
    /**
     * Flattened IFC `Pset_*Common` property sets as JSON. Null for
     * briefing-derived rows. Free-form jsonb so the parser can surface
     * whatever IFC metadata is useful without a schema change.
     */
    propertySet: jsonb("property_set"),
    /**
     * Pointer at the snapshot whose IFC ingest produced this row.
     * Null for briefing-derived rows. The CHECK constraint below
     * requires this for IFC rows. Cascade-delete so dropping a snapshot
     * cleans up its derived atoms.
     */
    sourceSnapshotId: uuid("source_snapshot_id").references(
      () => snapshots.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    briefingIdx: index("materializable_elements_briefing_idx").on(t.briefingId),
    kindIdx: index("materializable_elements_kind_idx").on(
      t.briefingId,
      t.elementKind,
    ),
    /**
     * Index for the viewer's lens-filtered fetch — given an engagement
     * and a source_kind ("as-built-ifc" + "as-built-ifc-bundle"), return
     * the most-recent IFC ingest's rows. Partial on engagement_id IS NOT
     * NULL so legacy rows that haven't been backfilled don't pollute it.
     */
    engagementSourceIdx: index("materializable_elements_engagement_source_idx")
      .on(t.engagementId, t.sourceKind)
      .where(sql`${t.engagementId} IS NOT NULL`),
    /**
     * Index for re-upload cleanup — given a snapshot, find the rows it
     * produced so we can delete them before re-parsing.
     */
    snapshotIdx: index("materializable_elements_snapshot_idx")
      .on(t.sourceSnapshotId)
      .where(sql`${t.sourceSnapshotId} IS NOT NULL`),
    /**
     * source_kind closed-tuple guard. Enforced at the DB so a stray
     * write can't introduce an unknown lens.
     */
    sourceKindCheck: check(
      "materializable_elements_source_kind_check",
      sql`${t.sourceKind} IN ('briefing-derived', 'as-built-ifc', 'as-built-ifc-bundle')`,
    ),
    /**
     * Provenance invariants. briefing-derived rows must have a
     * briefing_id; as-built IFC rows must have a source_snapshot_id,
     * an engagement_id, an ifc_global_id, and an ifc_type.
     */
    provenanceInvariantsCheck: check(
      "materializable_elements_provenance_invariants_check",
      sql`(
        (${t.sourceKind} = 'briefing-derived' AND ${t.briefingId} IS NOT NULL)
        OR (${t.sourceKind} IN ('as-built-ifc', 'as-built-ifc-bundle')
            AND ${t.sourceSnapshotId} IS NOT NULL
            AND ${t.engagementId} IS NOT NULL
            AND ${t.ifcGlobalId} IS NOT NULL
            AND ${t.ifcType} IS NOT NULL)
      )`,
    ),
  }),
);

export const materializableElementsRelations = relations(
  materializableElements,
  ({ one }) => ({
    briefing: one(parcelBriefings, {
      fields: [materializableElements.briefingId],
      references: [parcelBriefings.id],
    }),
    briefingSource: one(briefingSources, {
      fields: [materializableElements.briefingSourceId],
      references: [briefingSources.id],
    }),
    engagement: one(engagements, {
      fields: [materializableElements.engagementId],
      references: [engagements.id],
    }),
    sourceSnapshot: one(snapshots, {
      fields: [materializableElements.sourceSnapshotId],
      references: [snapshots.id],
    }),
  }),
);

export type MaterializableElement =
  typeof materializableElements.$inferSelect;
export type NewMaterializableElement =
  typeof materializableElements.$inferInsert;
