import {
  pgTable,
  text,
  jsonb,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Published extraterritorial-jurisdiction (ETJ) ring store — per-publisher
 * ETJ layers (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * ETJ does not exist as a statewide layer the way city limits do. TxGIO
 * City_Boundaries publishes incorporated places only, and the eight sites
 * that serve ETJ in the product today return the literal string
 * `unresolved` because no ETJ geometry has ever been acquired. Each
 * municipality publishes its own ETJ layer on its own ArcGIS host, so this
 * table holds rings acquired one publisher at a time through
 * `@workspace/cad-ingest`'s etj-ingest CLI, keyed by the publishing city.
 *
 * Mirrors `tx_city_boundary`'s column shape (geo-key + name + GeoJSON +
 * per-feature bbox + source bookkeeping) because that shape is the working
 * precedent one file away; the differences are the ones ETJ actually forces:
 *
 *   - the key is `etj_id` = `<city_key>:<publisher object id>`, since rings
 *     are identified by their publisher, never by a statewide place code;
 *   - `ring_label` stores the publisher's own label verbatim
 *     (`AUSTIN 2 MILE ETJ`, `KYLE ETJ`, ...). Nothing here is derived from
 *     a statute: Texas Government Code §42.021 buffers are deliberately NOT
 *     computed, because Austin's real ETJ is shaped by individual
 *     development agreements and disannexation actions a formula contradicts;
 *   - `city_geo_id` carries the CPA place id when the publisher's city can
 *     be joined to `tx_city_boundary` (nullable — the join is informational,
 *     never required, and never invented).
 *
 * A zero-row table is `unresolved` (no ETJ source has been ingested), never
 * "not in the ETJ". `tx_etj_source` carries per-publisher coverage so
 * "checked, no ETJ here" and "no source to check" stay distinguishable.
 *
 * P-359 — THE SERVED GEOMETRY (migration 0104). An ETJ is by definition
 * OUTSIDE city limits, and three publishers in the six Phase 0 counties
 * (`georgetown-tx:9644`, `leander-tx:1`, `dripping-springs-tx:1`) drew one
 * shape for "city plus ETJ": their published ring CONTAINS its own city's
 * representative point, so the serve path answered `present` for parcels
 * inside the city limits (74,785 of them, measured by P-332). Separately, 24
 * of 355 rings fail `ST_IsValid`, and `ST_Contains` against an invalid polygon
 * is undefined in GEOS.
 *
 * So this table now carries the publisher's geometry AND the geometry the
 * reader may test:
 *
 *   - `geometry` stays the PUBLISHER'S GEOMETRY, VERBATIM. Acquisition and
 *     interpretation are different acts, and nothing derived overwrites the
 *     source.
 *   - `servedGeometry` is what containment may run against: the ring minus its
 *     own city's limits (self-containing ring), the repaired polygon (invalid
 *     ring), NULL when the publisher's geometry is served unchanged.
 *   - `servedStatus` is the reader's contract and DEFAULTS TO 'underived'.
 *     That default is load-bearing: a row that reaches this table without
 *     passing the derivation pass is REFUSED by the reader and declared,
 *     rather than served as if it had been proven safe. Fail closed.
 *   - `derivation` carries the record: what was subtracted and which city
 *     boundary and vintage it came from, `ST_IsValidReason`, validity after
 *     repair, and the areas before and after. A transformation without its
 *     record is the defect class this column exists to prevent.
 */
export const txEtjBoundary = pgTable(
  "tx_etj_boundary",
  {
    /** `<city_key>:<publisher object id>`, e.g. `austin-tx:22`. Primary key. */
    etjId: text("etj_id").notNull(),
    /** Registry key of the publishing city, e.g. `austin-tx`. */
    cityKey: text("city_key").notNull(),
    /** Display name of the publishing city, e.g. `Austin`. */
    cityName: text("city_name").notNull(),
    /** CPA place geo_id when the publisher's city joins to tx_city_boundary. */
    cityGeoId: text("city_geo_id"),
    /** Publisher's own ring label, verbatim, e.g. `AUSTIN 2 MILE ETJ`. */
    ringLabel: text("ring_label").notNull(),
    /** GeoJSON geometry (WGS84). */
    geometry: jsonb("geometry").notNull(),
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    /** Owning organization label as published, e.g. `City of Austin`. */
    source: text("source").notNull(),
    /** Acquisition vintage label recorded at ingest. */
    sourceVintage: text("source_vintage").notNull(),
    /** Canonical service URL citation (layer-specific). */
    sourceCitation: text("source_citation").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // ----------------------------------------------------------------- P-359
    /**
     * The geometry the reader may run containment against: the ring minus its
     * own city's limits when the ring contains its city, the `ST_MakeValid`
     * polygon when the publisher's geometry was invalid, NULL when the
     * publisher's geometry is served unchanged. Never a replacement of
     * `geometry`. GeoJSON in WGS84 — the canonical type is `GeoJsonGeometry`
     * in `@workspace/cad-ingest`'s `txgio/geo.ts` (this package stores
     * geometry as opaque jsonb; it does not own a second copy of the shape).
     */
    servedGeometry: jsonb("served_geometry"),
    /**
     * Reader contract, written by the ingest's derivation pass. `verbatim`,
     * `derived` and `repaired` are servable; `excluded`, `withheld` and the
     * default `underived` are NOT — the reader refuses them and declares why
     * instead of testing a polygon that was never proven testable.
     */
    servedStatus: text("served_status")
      .$type<EtjServedStatus>()
      .default("underived")
      .notNull(),
    /** The derivation/repair record. See {@link EtjRingDerivation}. */
    derivation: jsonb("derivation").$type<EtjRingDerivation | null>(),
    /** Square metres (spheroidal) of the published geometry, as published. */
    areaPublished: doublePrecision("area_published"),
    /** Square metres (spheroidal) of the served geometry, when one exists. */
    areaServed: doublePrecision("area_served"),
    /** When the derivation pass last wrote this row. */
    derivedAt: timestamp("derived_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.etjId] }),
    bboxIdx: index("tx_etj_boundary_bbox_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
    cityIdx: index("tx_etj_boundary_city_idx").on(t.cityKey),
    servedStatusIdx: index("tx_etj_boundary_served_status_idx").on(
      t.servedStatus,
    ),
  }),
);

/**
 * What the reader may do with one ring, decided once by the derivation pass
 * (`@workspace/cad-ingest`'s `boundary/etjDerive.ts`) and written to
 * `served_status`. Only `verbatim`, `derived` and `repaired` are servable.
 *
 *   verbatim  `ST_IsValid` true and the ring does not contain its own city;
 *             `geometry` is served unchanged.
 *   derived   the ring contains its own city; `served_geometry` is the ring
 *             minus that city's limits.
 *   repaired  `ST_IsValid` was false and `ST_MakeValid` moved the area inside
 *             the declared tolerance; `served_geometry` is the repaired polygon.
 *   excluded  `ST_IsValid` was false and the repair moved more area than the
 *             tolerance allows; NOTHING is served.
 *   withheld  the ring contains its own city but the subtraction produced no
 *             usable polygon; NOTHING is served.
 *   underived no derivation pass has run for this row. NOT served.
 */
export type EtjServedStatus =
  | "verbatim"
  | "derived"
  | "repaired"
  | "excluded"
  | "withheld"
  | "underived";

// Which of these the reader may run containment against is the READER's
// contract, and it lives with the reader: `ETJ_SERVABLE_STATUSES` /
// `statusIsServable` in `@workspace/cad-ingest`'s boundary/containment.ts.
// Declaring the set here as well would be a second list to forget.

/**
 * The derivation record, one JSON object per row. Every field is written by
 * the same pass that wrote the served geometry, so a reader can always ask
 * `why` and get the pass's own answer rather than an inference.
 */
export type EtjRingDerivation = {
  /** What the pass decided. One per served status. */
  kind: "clean" | "self_containing" | "invalid" | "invalid_repair" | "none";
  /** When the pass ran (ISO 8601). */
  at: string;
  /** `ST_IsValid` on the publisher's geometry as published. */
  isValidPublished?: boolean;
  /** `ST_IsValidReason` as Postgres reported it, when it was invalid. */
  isValidReason?: string;
  /** `ST_IsValid` on the served geometry, when one exists. */
  isValidServed?: boolean;
  /** True when the served geometry came from `ST_MakeValid`. */
  repaired?: boolean;
  /** The city limits subtracted from a self-containing ring. */
  subtracted?: {
    table: "tx_city_boundary";
    /** Joined on the ring's own city_name, per P-332's validated method. */
    matchedBy: "city_name_normalized";
    cityGeoId: string | null | undefined;
    cityName: string | null;
    /** `tx_city_boundary.source_vintage` — the boundary's own vintage. */
    boundaryVintage: string | null;
  };
  /** Spheroidal square metres, as published. */
  areaPublished?: number;
  /** Spheroidal square metres, served. Equal to published when verbatim. */
  areaServed?: number;
  /** areaPublished - areaServed: what the derivation removed. */
  areaRemoved?: number;
  /** Relative area moved, against the declared tolerance. Repairs only. */
  areaDeltaFraction?: number;
  /** The declared tolerance this pass applied. */
  toleranceFraction?: number;
  /** The honest statement of why nothing is served. */
  note?: string;
};

export type TxEtjBoundaryRow = typeof txEtjBoundary.$inferSelect;
export type TxEtjBoundaryInsert = typeof txEtjBoundary.$inferInsert;
