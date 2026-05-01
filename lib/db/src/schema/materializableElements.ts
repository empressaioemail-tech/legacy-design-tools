import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { parcelBriefings } from "./parcelBriefings";
import { briefingSources } from "./briefingSources";

/**
 * The seven Spec 51a §2.4 / Spec 53 §4 element kinds the C# Revit
 * add-in knows how to materialize. Mirrors the `DXF_LAYER_KINDS`
 * tuple in `artifacts/api-server/src/lib/converterClient.ts`: every
 * materializable element either points at a converted glb (terrain,
 * setback-plane, buildable-envelope, neighbor-mass) or carries
 * polygon coordinates the add-in reconstructs natively (property-
 * line, floodplain, wetland).
 */
export const MATERIALIZABLE_ELEMENT_KINDS = [
  "terrain",
  "property-line",
  "setback-plane",
  "buildable-envelope",
  "floodplain",
  "wetland",
  "neighbor-mass",
] as const;

export type MaterializableElementKind =
  (typeof MATERIALIZABLE_ELEMENT_KINDS)[number];

/**
 * A *materializable-element* (DA-PI-5 / Spec 51a §2.4) is one piece
 * of geometry the C# Revit add-in materializes into the architect's
 * active model — a Toposolid surface, a setback plane, a buildable-
 * envelope mass, etc. The briefing engine (DA-PI-3) emits one row
 * per geometric feature it derives from the parcel briefing's
 * sourced overlays; the C# side reads them via
 * `GET /api/engagements/:id/bim-model` to drive its materialization
 * passes.
 *
 * `elementKind` discriminates the geometry payload (the seven Spec
 * 53 §4 kinds). `geometry` (jsonb) carries the structured payload
 * the C# add-in reconstructs from — for `buildable-envelope` it is
 * a polygon ring of (x, y, z) tuples lifted from the briefing's glb
 * artifact; for `setback-plane` it is the plane normal + offset; etc.
 *
 * `briefingSourceId` is the cited source the geometry came from
 * (Spec 51 §4 reconciliation contract — every materialized element
 * is auditable back to the briefing source it was derived from).
 * Null for elements the briefing engine synthesizes without a single
 * upstream source (e.g. a setback plane derived from zoning rules
 * + the parcel polygon — neither is the unique source).
 */
export const materializableElements = pgTable(
  "materializable_elements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    briefingId: uuid("briefing_id")
      .notNull()
      .references(() => parcelBriefings.id, { onDelete: "cascade" }),
    /**
     * One of {@link MATERIALIZABLE_ELEMENT_KINDS}. Stored as text
     * so DA-PI-3 can extend the discriminator without a schema
     * migration; the route layer validates against the closed tuple
     * before insert.
     */
    elementKind: text("element_kind").notNull(),
    /**
     * Optional pointer at the briefing source this element was
     * derived from. Null for engine-synthesized elements (see file
     * docstring).
     */
    briefingSourceId: uuid("briefing_source_id").references(
      () => briefingSources.id,
      { onDelete: "set null" },
    ),
    /**
     * Free-text label the C# side surfaces in the Revit UI — e.g.
     * "Front setback (15 ft)". Optional; the discriminator + a
     * synthesized fallback covers the case when the briefing engine
     * has nothing better to offer.
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
     */
    glbObjectPath: text("glb_object_path"),
    /**
     * Locked elements cannot be unpinned in Revit without emitting
     * a `briefing-divergence` event back to design-tools. Defaults
     * to `true` because most briefing-derived geometry is meant to
     * be authoritative; the engine can opt elements out by setting
     * `false` for advisory-only overlays.
     */
    locked: boolean("locked").notNull().default(true),
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
  }),
);

export type MaterializableElement =
  typeof materializableElements.$inferSelect;
export type NewMaterializableElement =
  typeof materializableElements.$inferInsert;
