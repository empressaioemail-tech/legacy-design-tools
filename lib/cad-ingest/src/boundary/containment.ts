/**
 * Spatial containment helpers for Texas city and county boundary polygons,
 * and for published extraterritorial-jurisdiction rings.
 *
 * Pure logic (no db, no network): given an in-memory index of boundary
 * polygons and a query point or parcel geometry, resolve the containing
 * city (or an explicit honest unincorporated absence) and/or county, and
 * resolve ETJ against published ETJ rings.
 *
 * Reuses the dependency-free geometry math from `../txgio/geo.ts` (bbox
 * pre-filter + even-odd ray-cast `pointInGeometry`), same pattern as
 * `zoning-stamp.ts`.
 *
 * Unincorporated territory is the CORRECT answer for most of Texas by
 * area when the incorporated-place index is populated — returned as
 * `{ status: 'unincorporated', basis: ... }`, never as null, blank, or
 * a guessed city name. An empty index is a different state: unmeasured.
 * This helper never derives an ETJ ring or offset buffer.
 */

import {
  bboxOfGeometry,
  bboxesIntersect,
  pointInGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";
// TYPE-ONLY, deliberately: this module keeps its "no db, no network" purity at
// runtime (the whole point of `@workspace/cad-ingest/boundary`), while the
// served-status vocabulary stays owned by the table that stores it. `import
// type` is erased, so nothing from `@workspace/db` loads here.
import type { EtjServedStatus } from "@workspace/db/schema";

export interface CityBoundaryIndexEntry {
  geoId: string;
  cityName: string;
  gnis: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

export interface CountyBoundaryIndexEntry {
  countyFips: string;
  countyName: string;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

/**
 * ETJ disposition for a query point. Until P-241 this type had exactly one
 * member, `"unresolved"`, and eight sites across three repos served that
 * literal string because no ETJ geometry existed anywhere in the product.
 * The three members are now earned:
 *
 *   - `present`    — a published ETJ ring from a registered publisher
 *                    contains the point;
 *   - `absent`     — at least one registered publisher's own published ETJ
 *                    extent covers the point and none of that publisher's
 *                    rings contains it. This is a CHECKED answer;
 *   - `unresolved` — no source covers the point at all: no ETJ data has been
 *                    ingested, or the point lies outside every registered
 *                    publisher's published extent, or its city is enumerated
 *                    as publishing no ETJ layer. This is "no source to
 *                    check", and it is NOT a confirmed absence.
 *
 * `absent` and `unresolved` must never be collapsed: the first is a fact
 * about the land, the second is a fact about our coverage.
 */
export type EtjStatus = "present" | "absent" | "unresolved";

export type CityContainmentResult =
  | {
      status: "incorporated";
      cityName: string;
      geoId: string;
      gnis: string | null;
      etjStatus: EtjStatus;
      basis: string;
    }
  | {
      status: "unincorporated";
      etjStatus: EtjStatus;
      basis: string;
    }
  | {
      status: "unmeasured";
      etjStatus: EtjStatus;
      basis: string;
    };


export type CountyContainmentResult =
  | {
      status: "resolved";
      countyFips: string;
      countyName: string;
      basis: string;
    }
  | {
      status: "unresolved";
      basis: string;
    };

/** Build a city index from normalized records or DB rows. */
export function buildCityBoundaryIndex(
  entries: Array<{
    geoId: string;
    cityName: string;
    gnis?: string | null;
    geometry: GeoJsonGeometry;
    bbox?: GeoBbox;
  }>,
): CityBoundaryIndexEntry[] {
  const out: CityBoundaryIndexEntry[] = [];
  for (const e of entries) {
    const bbox = e.bbox ?? bboxOfGeometry(e.geometry);
    if (!bbox) continue;
    out.push({
      geoId: e.geoId,
      cityName: e.cityName,
      gnis: e.gnis ?? null,
      geometry: e.geometry,
      bbox,
    });
  }
  return out;
}

export function buildCountyBoundaryIndex(
  entries: Array<{
    countyFips: string;
    countyName: string;
    geometry: GeoJsonGeometry;
    bbox?: GeoBbox;
  }>,
): CountyBoundaryIndexEntry[] {
  const out: CountyBoundaryIndexEntry[] = [];
  for (const e of entries) {
    const bbox = e.bbox ?? bboxOfGeometry(e.geometry);
    if (!bbox) continue;
    out.push({
      countyFips: e.countyFips,
      countyName: e.countyName,
      geometry: e.geometry,
      bbox,
    });
  }
  return out;
}

function isPosition(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number"
  );
}

/** Representative interior point for a parcel polygon (centroid with vertex fallback). */
export function representativePoint(
  geometry: GeoJsonGeometry,
): [number, number] | null {
  const rings: [number, number][][] = [];
  function collectPolygon(poly: unknown): void {
    if (!Array.isArray(poly) || poly.length === 0) return;
    const outer = poly[0];
    if (Array.isArray(outer) && outer.length >= 3) {
      const ring: [number, number][] = [];
      for (const pt of outer) {
        if (isPosition(pt)) ring.push(pt);
      }
      if (ring.length >= 3) rings.push(ring);
    }
  }
  if (geometry.type === "Polygon") {
    collectPolygon(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    for (const poly of geometry.coordinates) collectPolygon(poly);
  }
  if (rings.length === 0) return null;

  let best: [number, number][] | null = null;
  let bestArea = -1;
  for (const ring of rings) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    const abs = Math.abs(area);
    if (abs > bestArea) {
      bestArea = abs;
      best = ring;
    }
  }
  if (!best || best.length === 0) return null;

  let cx = 0;
  let cy = 0;
  let signedArea = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const [x0, y0] = best[j];
    const [x1, y1] = best[i];
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(signedArea) > 1e-12) {
    const f = 1 / (3 * signedArea);
    const lng = cx * f;
    const lat = cy * f;
    if (pointInGeometry(lng, lat, geometry)) return [lng, lat];
  }
  return best[0] ?? null;
}

function etjUnresolved(): EtjStatus {
  return "unresolved";
}
/** Resolve city containment for a WGS84 point against an in-memory index. */
export function resolveCityContainmentAtPoint(
  longitude: number,
  latitude: number,
  index: CityBoundaryIndexEntry[],
): CityContainmentResult {
  if (index.length === 0) {
    return {
      status: "unmeasured",
      etjStatus: etjUnresolved(),
      basis:
        "tx_city_boundary index is empty; city limits are unmeasured, not unincorporated",
    };
  }
  const queryBbox: GeoBbox = {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
  for (const entry of index) {
    if (!bboxesIntersect(queryBbox, entry.bbox)) continue;
    if (pointInGeometry(longitude, latitude, entry.geometry)) {
      return {
        status: "incorporated",
        cityName: entry.cityName,
        geoId: entry.geoId,
        gnis: entry.gnis,
        etjStatus: etjUnresolved(),
        basis: `point-in-polygon against tx_city_boundary geo_id=${entry.geoId}`,
      };
    }
  }
  return {
    status: "unincorporated",
    etjStatus: etjUnresolved(),
    basis:
      "no incorporated-place polygon contains the query point " +
      "(tx_city_boundary statewide index; unincorporated is the honest answer)",
  };
}

/** Resolve city containment for a parcel geometry or point. */
export function resolveCityContainment(
  query: { longitude: number; latitude: number } | GeoJsonGeometry,
  index: CityBoundaryIndexEntry[],
): CityContainmentResult {
  if ("type" in query && "coordinates" in query) {
    const pt = representativePoint(query);
    if (pt === null) {
      return {
        status: "unmeasured",
        etjStatus: etjUnresolved(),
        basis:
          "parcel geometry yielded no representative point; city limits are unmeasured",
      };
    }
    return resolveCityContainmentAtPoint(pt[0], pt[1], index);
  }
  return resolveCityContainmentAtPoint(query.longitude, query.latitude, index);
}

/** Resolve county containment for a WGS84 point. Every TX point should resolve. */
export function resolveCountyContainmentAtPoint(
  longitude: number,
  latitude: number,
  index: CountyBoundaryIndexEntry[],
): CountyContainmentResult {
  const queryBbox: GeoBbox = {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
  for (const entry of index) {
    if (!bboxesIntersect(queryBbox, entry.bbox)) continue;
    if (pointInGeometry(longitude, latitude, entry.geometry)) {
      return {
        status: "resolved",
        countyFips: entry.countyFips,
        countyName: entry.countyName,
        basis: `point-in-polygon against tx_county_boundary fips=${entry.countyFips}`,
      };
    }
  }
  return {
    status: "unresolved",
    basis:
      "no county polygon contains the query point " +
      "(outside Texas or index incomplete)",
  };
}

export function resolveCountyContainment(
  query: { longitude: number; latitude: number } | GeoJsonGeometry,
  index: CountyBoundaryIndexEntry[],
): CountyContainmentResult {
  if ("type" in query && "coordinates" in query) {
    const pt = representativePoint(query);
    if (pt === null) {
      return {
        status: "unresolved",
        basis: "parcel geometry yielded no representative point",
      };
    }
    return resolveCountyContainmentAtPoint(pt[0], pt[1], index);
  }
  return resolveCountyContainmentAtPoint(query.longitude, query.latitude, index);
}

// ---------------------------------------------------------------------- ETJ
// P-241 (feat/p241-etj-acquisition). ETJ resolution lives in this module
// rather than a sibling because this module already owns the ETJ vocabulary
// (`EtjStatus`, and the `etjUnresolved()` that was unconditional until P-241).
// A sibling module would have had to declare a second ETJ status type, and a
// duplicated vocabulary is the failure OPS-23 names explicitly. Widening
// `EtjStatus` from one member to three is additive: every existing caller
// assigns the literal `"unresolved"`, so the city-limits path is unchanged and
// still honest about not having checked ETJ.
//
// P-359 (an ETJ ring that swallows its own city is a drawing convention, not an
// answer). The reader no longer indexes "whatever geometry is in the row". It
// indexes the SERVED geometry of a ring that has been through the ingest's
// derivation pass, and REFUSES everything else as a declaration:
//
//   - a ring whose `served_status` is `underived`, `excluded` or `withheld` is
//     never tested. `underived` means no derivation pass has run, `excluded`
//     means `ST_MakeValid` moved the published area beyond the declared
//     tolerance, `withheld` means the ring contains its own city and the
//     subtraction left nothing usable;
//   - `ST_Contains` against an INVALID polygon is undefined in GEOS, so "the
//     store happens to hold valid geometry" is not something a reader may
//     assume. The refusal is here, in the reader, not in a hope about the store;
//   - a refusal is not a miss. If a publisher whose own extent covers the query
//     point has a ring the reader could not test, the answer is `unresolved`
//     and it NAMES the refused ring — never `absent`. "I could not look" must
//     not be served as "it is not there".
//   - a refusal is consulted only where the refused ring COULD have held the
//     point: the ring's own published envelope has to reach the query point.
//     The envelope is a node envelope, i.e. a superset of any polygon built from
//     those nodes, so the narrowing can never hide a ring that could have
//     contained the point — while refusing to answer a point 40 km away would
//     subtract an answer the reader is able to give. Measured on the real store
//     (2026-09-18), 24 invalid rings are excluded and several belong to
//     publishers with many rings, so the unnarrowed form would turn a whole
//     publisher's verified absences into refusals.
//
// The set below is the reader's contract and the ingest writes to it; there is
// exactly one list (the table's `served_status` doc names it), so a status
// cannot be servable in one place and refused in another.

/** The only `served_status` values containment may run against. */
export const ETJ_SERVABLE_STATUSES = [
  "verbatim",
  "derived",
  "repaired",
] as const satisfies readonly EtjServedStatus[];

/**
 * True when the reader may run containment against a ring with this
 * `tx_etj_boundary.served_status`. Everything else is refused and declared.
 */
export function statusIsServable(
  status: string,
): status is (typeof ETJ_SERVABLE_STATUSES)[number] {
  return (ETJ_SERVABLE_STATUSES as readonly string[]).includes(status);
}

/** One published ETJ ring, as the reader may TEST it. */
export interface EtjBoundaryIndexEntry {
  /** `<cityKey>:<publisher object id>`. */
  etjId: string;
  cityKey: string;
  cityName: string;
  /** The publisher's own ring label, verbatim. */
  ringLabel: string;
  /**
   * The geometry containment may run against: `served_geometry` for a ring that
   * was derived or repaired, the publisher's own `geometry` when it is served
   * verbatim. NEVER a polygon that has not been through the derivation pass.
   */
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
  /** The publisher's layer URL this ring came from. */
  sourceCitation: string;
  /** How this served geometry came to be, carried through to the answer. */
  servedStatus: (typeof ETJ_SERVABLE_STATUSES)[number];
  /** The derivation's own sentence about this ring, when it wrote one. */
  derivationNote: string | null;
}

/** A ring the reader REFUSES to test, carried as a declaration, never served. */
export interface EtjRingRefusal {
  etjId: string;
  cityKey: string;
  cityName: string;
  ringLabel: string;
  /** `underived`, `excluded` or `withheld`. */
  servedStatus: EtjServedStatus;
  /** Why nothing may be tested: the derivation's own note, or the contract violation. */
  reason: string;
  /**
   * The PUBLISHED geometry's envelope, when the row carries one. A refusal only
   * changes an answer where the refused ring could have contained the query
   * point: a ring whose envelope does not reach the point cannot be the reason
   * the answer is unknown, and saying "unresolved" there would subtract an
   * answer the reader is able to give. `null` means the envelope is unknown, and
   * the refusal is then kept conservatively — an unknown extent can always reach.
   * Never null for a ring the builder turned into a RING; only a refused row
   * whose geometry yielded no bbox has it.
   */
  bbox: GeoBbox | null;
}

/**
 * The reader's input: what may be tested, and what was refused and why. Both
 * halves are required, so a caller cannot hand the resolver only the rings it
 * likes and let a refusal silently become an absence.
 */
export interface EtjBoundaryIndex {
  rings: EtjBoundaryIndexEntry[];
  refusals: EtjRingRefusal[];
}

/** One `tx_etj_boundary` row, or its equivalent from the live acquisition instrument. */
export interface EtjBoundarySourceRow {
  etjId: string;
  cityKey: string;
  cityName: string;
  ringLabel: string;
  /** `tx_etj_boundary.geometry` — the publisher's geometry, verbatim. */
  geometry: unknown;
  /** `tx_etj_boundary.served_geometry` — the derived or repaired geometry. */
  servedGeometry?: unknown;
  /**
   * `tx_etj_boundary.served_status`. Required, with no default: a caller has to
   * say what the row's status is rather than inherit "servable" by omission.
   */
  servedStatus: EtjServedStatus;
  /** `tx_etj_boundary.derivation` — the pass's own record. */
  derivation?: unknown;
  bbox?: GeoBbox | null;
  sourceCitation?: string;
}

/** A geometry this reader is willing to test: Polygon or MultiPolygon. */
function asTestablePolygon(value: unknown): GeoJsonGeometry | null {
  // A ring is a polygon. Anything else (a stray point, line or collection that
  // reached the index) can never contain a query point, and keeping it would add
  // a ring that can only ever answer "no" — a phantom in ringsConsulted.
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: unknown };
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    return value as GeoJsonGeometry;
  }
  return null;
}

/** The derivation record's own sentence, when the row carries one. */
function derivationNoteOf(derivation: unknown): string | null {
  if (!derivation || typeof derivation !== "object") return null;
  const note = (derivation as { note?: unknown }).note;
  return typeof note === "string" && note.trim().length > 0 ? note.trim() : null;
}

function refusalReasonFor(
  row: EtjBoundarySourceRow,
  fallback: string,
): string {
  const note = derivationNoteOf(row.derivation);
  if (note !== null) return note;
  if (row.servedStatus === "underived") {
    return (
      "no derivation pass has run for this ring, so it has not been proven " +
      "testable; containment is refused rather than run against an unproven polygon"
    );
  }
  return fallback;
}

/**
 * Build the reader's index from rows, partitioning servable rings from
 * declarations. `served_status` decides everything: only `verbatim`, `derived`
 * and `repaired` are indexed, and each of those names the geometry to test
 * (`geometry` for verbatim, `served_geometry` for the derived and repaired).
 * Anything else — including a row that claims a servable status but carries no
 * testable polygon — becomes a refusal with its reason attached.
 */
export function buildEtjBoundaryIndex(
  rows: readonly EtjBoundarySourceRow[],
): EtjBoundaryIndex {
  const rings: EtjBoundaryIndexEntry[] = [];
  const refusals: EtjRingRefusal[] = [];
  for (const row of rows) {
    if (!statusIsServable(row.servedStatus)) {
      refusals.push({
        etjId: row.etjId,
        cityKey: row.cityKey,
        cityName: row.cityName,
        ringLabel: row.ringLabel,
        servedStatus: row.servedStatus,
        reason: refusalReasonFor(
          row,
          `served_status=${row.servedStatus}: nothing is served for this ring`,
        ),
        // The envelope is derived from the PUBLISHED geometry's own nodes, so it
        // is a superset of any polygon built from them — valid or invalid, whole
        // or partly removed — and the narrowing can therefore never hide a ring
        // that could have contained the point. The row's declared `bbox` is only
        // a fallback for a row whose geometry is missing: a refusal must be
        // narrowed against the drawing itself, not against a column that could
        // have gone stale, or the narrowing would be a hope about the store.
        bbox: bboxOfGeometry(row.geometry) ?? row.bbox ?? null,
      });
      continue;
    }
    const served = row.servedStatus !== "verbatim";
    const geometry = asTestablePolygon(
      served ? row.servedGeometry : row.geometry,
    );
    if (geometry === null) {
      refusals.push({
        etjId: row.etjId,
        cityKey: row.cityKey,
        cityName: row.cityName,
        ringLabel: row.ringLabel,
        servedStatus: row.servedStatus,
        reason:
          `served_status=${row.servedStatus} but the ` +
          `${served ? "served" : "published"} geometry is not a Polygon or ` +
          `MultiPolygon, so there is nothing safe to test`,
        bbox: bboxOfGeometry(row.geometry) ?? row.bbox ?? null,
      });
      continue;
    }
    const bbox = row.bbox ?? bboxOfGeometry(geometry);
    if (!bbox) {
      refusals.push({
        etjId: row.etjId,
        cityKey: row.cityKey,
        cityName: row.cityName,
        ringLabel: row.ringLabel,
        servedStatus: row.servedStatus,
        reason: "geometry yielded no bbox, so it cannot be pre-filtered safely",
        bbox: null,
      });
      continue;
    }
    rings.push({
      etjId: row.etjId,
      cityKey: row.cityKey,
      cityName: row.cityName,
      ringLabel: row.ringLabel,
      geometry,
      bbox,
      sourceCitation: row.sourceCitation ?? "",
      servedStatus: row.servedStatus,
      derivationNote: derivationNoteOf(row.derivation),
    });
  }
  return { rings, refusals };
}


/**
 * What one registered publisher's ETJ layer covers, from `tx_etj_source`.
 * `bbox` is the publisher's own published extent of its ETJ selection, read
 * in WGS84 at ingest. `hasEtjRings` is false for a city enumerated as
 * publishing city limits only.
 */
export interface EtjSourceCoverageEntry {
  cityKey: string;
  cityName: string;
  cityGeoId: string | null;
  mode: string;
  hasEtjRings: boolean;
  bbox: GeoBbox | null;
}

export type EtjContainmentResult =
  | {
      status: "present";
      cityKey: string;
      cityName: string;
      etjId: string;
      ringLabel: string;
      sourceCitation: string;
      /**
       * How the ring that contains the point was served (P-359): `verbatim`,
       * `derived` (the ring minus its own city's limits) or `repaired`. A
       * `present` that rests on a derived or repaired geometry says so, so the
       * answer names its own derivation instead of looking like any other ring.
       */
      servedStatus: (typeof ETJ_SERVABLE_STATUSES)[number];
      /** The derivation's own sentence about the ring, when it wrote one. */
      derivationNote: string | null;
      basis: string;
    }
  | {
      status: "absent";
      /** Publishers whose own extent covered the query point. */
      coveredBy: string[];
      ringsConsulted: number;
      basis: string;
    }
  | {
      status: "unresolved";
      basis: string;
      /**
       * Rings the reader refused to test whose publisher's own extent covers
       * the query point, with the derivation's own reason (P-359). Present
       * exactly when the refusal is WHY the answer is unresolved, so a caller
       * can tell "nobody publishes here" from "a ring could not be tested".
       */
      refusedRings?: Array<{
        etjId: string;
        servedStatus: EtjServedStatus;
        reason: string;
      }>;
    };

/** Degenerate point bbox, for the bbox pre-filter. */
function pointBbox(longitude: number, latitude: number): GeoBbox {
  return {
    westLng: longitude,
    southLat: latitude,
    eastLng: longitude,
    northLat: latitude,
  };
}

/**
 * The publisher register rows that answer for a named city: matched by CPA
 * geo_id when both sides carry one, else by display name. Used only to say
 * WHY a point has no source, so a miss never reads as a bare failure.
 */
function coverageRowForCity(
  coverage: EtjSourceCoverageEntry[],
  city: { cityName?: string | null; geoId?: string | null },
): EtjSourceCoverageEntry | null {
  const geoId = city.geoId ?? null;
  if (geoId !== null) {
    const byGeo = coverage.find((c) => c.cityGeoId === geoId);
    if (byGeo) return byGeo;
  }
  const name = city.cityName ?? null;
  if (name !== null) {
    const want = name.trim().toLowerCase();
    return coverage.find((c) => c.cityName.toLowerCase() === want) ?? null;
  }
  return null;
}

/**
 * Resolve ETJ for a WGS84 point against published ETJ rings plus the source
 * register's coverage.
 *
 * `coverage` is the whole register (every enumerated city, including those
 * with no ETJ layer); `index` holds the ingested rings. `containing` is the
 * already-resolved containing city, when the caller has it.
 *
 * The containing city dominates the miss case, and that ordering is the whole
 * point of this function. A publisher's extent is a loose box around its rings,
 * so a point inside *another* city's limits can easily fall inside a
 * neighbouring publisher's box: Round Rock sits inside the box of Austin's
 * published ETJ extent, so a box-only rule would answer "absent" there — a
 * confirmed absence of ETJ in a city that publishes no ETJ at all, which is
 * exactly the false negative the mission's third falsifier forbids. When the
 * containing city is known, its OWN register row decides:
 *
 *   - enumerated city_limits_only  -> unresolved, naming the mode;
 *   - not in the register at all   -> unresolved, naming the city;
 *   - publishes rings but the point is outside its published extent
 *                                  -> unresolved (its rings were not reached);
 *   - publishes rings that cover the point and none contains it -> absent.
 *
 * Only an unincorporated point (no containing city) falls back to the box:
 * `absent` when at least one registered publisher's own extent covers it, and
 * `unresolved` when none does.
 *
 * REFUSALS DOMINATE THE ABSENT ANSWER (P-359). `index` carries both the rings
 * the reader may test and the rings it refused, with reasons. A refusal is only
 * consulted where the answer would otherwise be `absent`, so every existing
 * "no source to check" answer reads exactly as it did before — but a point that
 * would have been called a VERIFIED absence while a ring covering it was never
 * tested is `unresolved`, naming the refused ring. Refusing is not measuring:
 * it must not be reported as a measurement.
 */
export function resolveEtjAtPoint(
  longitude: number,
  latitude: number,
  index: EtjBoundaryIndex,
  coverage: EtjSourceCoverageEntry[],
  containing: { cityName?: string | null; geoId?: string | null } | null = null,
): EtjContainmentResult {
  if (index.rings.length === 0 && index.refusals.length === 0 && coverage.length === 0) {
    return {
      status: "unresolved",
      basis:
        "tx_etj_source and tx_etj_boundary are both empty; ETJ is unmeasured, " +
        "not absent — no ETJ source has been acquired",
    };
  }

  const query = pointBbox(longitude, latitude);
  const covering = coverage.filter(
    (c) => c.bbox !== null && c.hasEtjRings && bboxesIntersect(query, c.bbox),
  );
  const coveringKeys = new Set(covering.map((c) => c.cityKey));
  const rings = index.rings.filter((e) => coveringKeys.has(e.cityKey));
  // A refusal is consulted only where the refused ring COULD have contained the
  // point (its own published envelope reaches it) and the publisher's extent
  // covers it. The narrowing is not a hope about the store: the envelope is read
  // from the row, and a superset of an untestable polygon can only over-include,
  // so every ring that could have held the point still refuses to answer.
  const refused = index.refusals.filter(
    (r) =>
      coveringKeys.has(r.cityKey) &&
      (r.bbox === null || bboxesIntersect(query, r.bbox)),
  );

  for (const ring of rings) {
    if (!bboxesIntersect(query, ring.bbox)) continue;
    if (pointInGeometry(longitude, latitude, ring.geometry)) {
      return {
        status: "present",
        cityKey: ring.cityKey,
        cityName: ring.cityName,
        etjId: ring.etjId,
        ringLabel: ring.ringLabel,
        sourceCitation: ring.sourceCitation,
        servedStatus: ring.servedStatus,
        derivationNote: ring.derivationNote,
        basis:
          `point-in-polygon against tx_etj_boundary etj_id=${ring.etjId} ` +
          `(${ring.cityName}: "${ring.ringLabel}", ring ${ring.etjId.split(":")[1]}) ` +
          `served ${ring.servedStatus}` +
          (ring.derivationNote !== null ? ` — ${ring.derivationNote}` : ""),
      };
    }
  }

  const containingRow =
    containing === null ? null : coverageRowForCity(coverage, containing);

  if (containingRow !== null) {
    if (!containingRow.hasEtjRings) {
      return {
        status: "unresolved",
        basis:
          `no source to check: ${containingRow.cityName} is enumerated in the ETJ register ` +
          `as mode=${containingRow.mode} — its publisher exposes city limits and no ETJ layer. ` +
          `This is a checked absence of a SOURCE, not a confirmed absence of ETJ` +
          (coveringKeys.size > 0
            ? ` (the publisher(s) ${[...coveringKeys].join(", ")} whose published extent does ` +
              `cover this point publish no ring that reaches it)`
            : ""),
      };
    }
    if (!coveringKeys.has(containingRow.cityKey)) {
      return {
        status: "unresolved",
        basis:
          `no source covers this point: ${containingRow.cityName} publishes an ETJ layer ` +
          `(mode=${containingRow.mode}) but the query point lies outside the extent that layer ` +
          `publishes; ETJ here is unmeasured, not absent`,
      };
    }
  } else if (containing !== null && (containing.cityName ?? null) !== null) {
    return {
      status: "unresolved",
      basis:
        `no source to check: ${containing.cityName} is not in the ETJ register at all, so its ` +
        `ETJ is unmeasured. This is a checked absence of a SOURCE, not a confirmed absence of ETJ` +
        (coveringKeys.size > 0
          ? ` (the registered publisher(s) ${[...coveringKeys].join(", ")} covering this point ` +
            `publish no ring that reaches it)`
          : ""),
    };
  }

  if (coveringKeys.size === 0) {
    return {
      status: "unresolved",
      basis:
        `no source covers this point: 0 of ${coverage.length} registered ETJ publishers' ` +
        `published extents contain it; the register does not reach this location, so ETJ is ` +
        `unresolved rather than absent`,
    };
  }

  // The refusal declaration sits HERE, between "there is a source" and "verified
  // absent", because those are the only two answers a refusal may change: a
  // servable ring that contains the point has already answered `present` above,
  // and every "no source to check" answer above is about coverage, not rings.
  if (refused.length > 0) {
    return {
      status: "unresolved",
      basis:
        `${refused.length} published ETJ ring(s) from the publisher(s) whose own ` +
        `published extent covers this point could not be tested and reach this ` +
        `point's own envelope, so ETJ here is unresolved rather than a verified ` +
        `absence: ` +
        refused
          .map((r) => `${r.etjId} (${r.servedStatus}: ${r.reason})`)
          .join("; "),
      refusedRings: refused.map((r) => ({
        etjId: r.etjId,
        servedStatus: r.servedStatus,
        reason: r.reason,
      })),
    };
  }

  return {
    status: "absent",
    coveredBy: [...coveringKeys],
    ringsConsulted: rings.length,
    basis:
      `point-in-polygon against ${rings.length} published ETJ ring(s) from ` +
      `${coveringKeys.size} publisher(s) whose own published extent covers this point ` +
      `(${[...coveringKeys].join(", ")}); no published ETJ ring contains it, so ETJ is ` +
      `verified absent here`,
  };
}

/** Resolve ETJ for a parcel geometry or point. */
export function resolveEtj(
  query: { longitude: number; latitude: number } | GeoJsonGeometry,
  index: EtjBoundaryIndex,
  coverage: EtjSourceCoverageEntry[],
  containing: { cityName?: string | null; geoId?: string | null } | null = null,
): EtjContainmentResult {
  if ("type" in query && "coordinates" in query) {
    const pt = representativePoint(query);
    if (pt === null) {
      return {
        status: "unresolved",
        basis:
          "parcel geometry yielded no representative point; ETJ is unmeasured",
      };
    }
    return resolveEtjAtPoint(pt[0], pt[1], index, coverage, containing);
  }
  return resolveEtjAtPoint(
    query.longitude,
    query.latitude,
    index,
    coverage,
    containing,
  );
}
