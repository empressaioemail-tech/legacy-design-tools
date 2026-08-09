/**
 * TxGIO land-parcel shapefile feature -> normalized `txgio_parcel`
 * record.
 *
 * Field names follow the TNRIS/TxGIO land-parcel schema
 * (cdn.tnris.org/documents/tnris-land-parcel-schema.pdf), verified
 * against the DBF headers of the real stratmap25 Hays (48209) and
 * Comal (48091) downloads 2026-07-13:
 *
 *   Prop_ID, GEO_ID, OWNER_NAME, NAME_CARE, LEGAL_AREA, LGL_AREA_U,
 *   GIS_AREA, GIS_AREA_U, LEGAL_DESC, STAT_LAND_, LOC_LAND_U,
 *   LAND_VALUE, IMP_VALUE, MKT_VALUE, SITUS_ADDR, SITUS_NUM,
 *   SITUS_STRE, SITUS_ST_1, SITUS_ST_2, SITUS_CITY, SITUS_STAT,
 *   SITUS_ZIP, MAIL_*, SOURCE, DATE_ACQ, FIPS, COUNTY, TAX_YEAR,
 *   YEAR_BUILT, OBJECTID_1, Shape_Leng, Shape_Area
 *
 * The store keeps identity + situs (the map layer's display fields
 * and the point->prop_id join); values/owner-mail attributes belong
 * to the `cad_property` roll store and are NOT duplicated here beyond
 * OWNER_NAME (which the #242 county-GIS map providers also expose).
 */

import type {
  DeclineReason,
  DeclinedFeature,
  ParseCounters,
} from "../types";
import { recordDecline } from "../types";
import {
  bboxOfGeometry,
  cellCountForBbox,
  cellKeysForBbox,
  isPlausibleTexasWgs84Bbox,
  TEXAS_WGS84_BOUNDS,
  TXGIO_MAX_FEATURE_CELLS,
  type GeoBbox,
  type GeoJsonGeometry,
} from "./geo";
import { reprojectGeometry, type SupportedSourceCrs } from "./reproject";

/** A normalized parcel feature bound for `txgio_parcel` (pre-bucketing). */
export interface TxgioParcelRecord {
  countyFips: string;
  featureIndex: number;
  propId: string | null;
  geoId: string | null;
  ownerName: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  situsState: string | null;
  situsZip: string | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
  /** Grid cells the feature's bbox intersects — one row per cell. */
  tileKeys: string[];
}

/** Shapefile sidecar entries we need out of the TxGIO zip's shp/ copy. */
export const TXGIO_ENTRY_FILTER = (name: string): boolean =>
  /\.(shp|dbf|prj)$/i.test(name);

/**
 * WGS84-GEOGRAPHIC guard. The land-parcel program publishes
 * GCS_WGS_1984 (verified against the real Hays/Comal .prj files);
 * anything else means TxGIO changed the published SR and this ingest
 * must grow a real reprojection step (proj4 with the exact EPSG)
 * before loading that county — never silently store non-WGS84
 * coordinates.
 *
 * TWO conditions, and the first one is the fix for the 202505 vintage
 * defect (`_inbox/2026-08-08_SWEEP_statewide_readiness.md` section 3).
 *
 * 1. The CRS must not be PROJECTED. A projected WKT nests its base
 *    datum, so the real 202505 StratMap file —
 *    `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",
 *     GEOGCS["GCS_WGS_1984", ...]]` — CONTAINS the `GCS_WGS_1984`
 *    substring and passed the old datum-only test while shipping
 *    coordinates in METERS (EPSG:3857), not degrees. 12 of 12 sampled
 *    202505 counties are Web Mercator; 57 of the 235 unloaded counties
 *    are on that vintage. Projected coordinates are not ingestible
 *    without a reprojection step this pipeline does not have.
 * 2. The datum must be WGS84, as before.
 *
 * This guard is necessary but NOT sufficient — it can only read a
 * declaration, and the `.prj` may be absent entirely. The coordinate
 * range assertion below (`assertTexasWgs84Bbox`, applied per feature in
 * `normalizeTxgioFeature`) is the durable guard because it tests the
 * coordinates themselves.
 */
export function assertWgs84Prj(prjText: string, prjPath: string): void {
  const t = prjText.toUpperCase();
  if (t.trimStart().startsWith("PROJCS")) {
    throw new Error(
      `${prjPath} declares a PROJECTED coordinate system — refusing to ` +
        `ingest projected coordinates (meters/feet) without a reprojection ` +
        `step. Only a geographic WGS84 CRS (degrees) is ingestible. ` +
        `.prj: ${prjText.slice(0, 200)}`,
    );
  }
  if (!t.includes("GCS_WGS_1984") && !t.includes('GEOGCS["WGS 84"')) {
    throw new Error(
      `${prjPath} is not GCS_WGS_1984 — refusing to ingest non-WGS84 ` +
        `coordinates without a reprojection step. .prj: ${prjText.slice(0, 200)}`,
    );
  }
}

/**
 * What a `.prj` declares, as far as this ingest is concerned.
 *
 * `wgs84-geographic`  degrees, ingestible as-is.
 * `web-mercator`      EPSG:3857 metres — ingestible ONLY with an
 *                     explicit `--reproject=3857`.
 * `unsupported`       anything else (state plane, NAD83, a projection
 *                     we have no inverse for). Never ingestible.
 */
export type TxgioPrjKind =
  | "wgs84-geographic"
  | "web-mercator"
  | "unsupported";

/**
 * CLASSIFY a `.prj` rather than merely accepting or refusing it, so the
 * CLI can tell "this county is projected and I know how to convert it"
 * apart from "this county is projected and I do not".
 *
 * `assertWgs84Prj` above is unchanged and still the strict gate: a
 * caller that has not been given explicit operator permission to
 * reproject calls IT, and a PROJCS still throws. This function exists
 * only so that the `--reproject=3857` path can recognize the ONE
 * projection we can invert, and so that a DIFFERENT projection — a
 * state-plane county, say — still fails closed even when the operator
 * passed the flag. The flag authorizes converting Web Mercator; it does
 * not authorize converting whatever happens to show up.
 *
 * The detection is deliberately narrow: `Mercator_Auxiliary_Sphere`
 * with a WGS84 datum and metre units, which is exactly what the 202505
 * StratMap vintage ships. A Mercator on a different sphere or datum is
 * NOT this, and must not be silently swept in.
 */
export function classifyPrj(prjText: string): TxgioPrjKind {
  const t = prjText.toUpperCase();
  const isProjected = t.trimStart().startsWith("PROJCS");
  const isWgs84Datum =
    t.includes("GCS_WGS_1984") || t.includes('GEOGCS["WGS 84"');
  if (!isProjected) {
    return isWgs84Datum ? "wgs84-geographic" : "unsupported";
  }
  const isAuxSphereMercator =
    t.includes("MERCATOR_AUXILIARY_SPHERE") ||
    t.includes("WGS_1984_WEB_MERCATOR") ||
    t.includes("PSEUDO-MERCATOR");
  const isMetres = t.includes('UNIT["METER"') || t.includes('UNIT["METRE"');
  if (isAuxSphereMercator && isWgs84Datum && isMetres) return "web-mercator";
  return "unsupported";
}

/** Thrown when a feature's coordinates are not plausible Texas degrees. */
export class TxgioProjectionError extends Error {
  readonly bbox: GeoBbox;
  constructor(message: string, bbox: GeoBbox) {
    super(message);
    this.name = "TxgioProjectionError";
    this.bbox = bbox;
  }
}

/**
 * THE DURABLE PROJECTION GUARD. Asserts a parsed feature's bbox falls
 * inside the plausible Texas WGS84 degree envelope, and that it buckets
 * into a sane number of grid cells.
 *
 * Unlike `assertWgs84Prj` this depends on no WKT parsing and no sidecar
 * file, so it catches every way the declaration can be wrong or absent:
 * a projected CRS (Web Mercator meters land near x=-11,200,000), a
 * MISSING `.prj` (which the CLI only warns about), a swapped lat/lng
 * axis order, and any future change to what the StratMap program
 * publishes. It is fail-closed by construction: a county whose
 * coordinates are not degrees cannot be loaded at all.
 *
 * This throws rather than counting a skip. A projection error is a
 * WHOLE-COUNTY property, not a per-feature data defect; skipping would
 * silently load zero or a handful of rows and report success.
 */
export function assertTexasWgs84Bbox(
  bbox: GeoBbox,
  context: string,
): void {
  if (!isPlausibleTexasWgs84Bbox(bbox)) {
    throw new TxgioProjectionError(
      `${context}: bbox [${bbox.westLng}, ${bbox.southLat}, ${bbox.eastLng}, ` +
        `${bbox.northLat}] falls outside the plausible Texas WGS84 envelope ` +
        `[${TEXAS_WGS84_BOUNDS.westLng}, ${TEXAS_WGS84_BOUNDS.southLat}, ` +
        `${TEXAS_WGS84_BOUNDS.eastLng}, ${TEXAS_WGS84_BOUNDS.northLat}] — ` +
        `coordinates are not WGS84 degrees (projected meters? swapped axes?). ` +
        `Refusing to ingest.`,
      bbox,
    );
  }
  const cells = cellCountForBbox(bbox);
  if (!Number.isFinite(cells) || cells > TXGIO_MAX_FEATURE_CELLS) {
    throw new TxgioProjectionError(
      `${context}: bbox [${bbox.westLng}, ${bbox.southLat}, ${bbox.eastLng}, ` +
        `${bbox.northLat}] buckets into ${cells} grid cells, above the ` +
        `${TXGIO_MAX_FEATURE_CELLS} per-feature ceiling — no real parcel ` +
        `spans that area. Refusing to ingest.`,
      bbox,
    );
  }
}

/**
 * HALT CEILING for the COORDINATE defect specifically — how many
 * out-of-envelope null placeholders a county may decline before the run
 * aborts. Measured against the real family: the worst observed county
 * (Henderson 48213, Liberty 48291) declines 2 of 108,484 and 164,178
 * respectively. Ten is comfortably above every measured case and orders
 * of magnitude below any plausible whole-county projection failure,
 * which puts EVERY feature outside the envelope. Paired with the
 * fraction ceiling below so the rule holds at both ends of the
 * county-size range.
 *
 * SCOPED DELIBERATELY. This ceiling counts only
 * `out-of-envelope-null-placeholder`, because that is the class this
 * change introduces and the one that must stay vanishingly rare — an
 * out-of-envelope coordinate is the signature of the failure the guard
 * exists to catch. The pre-existing geometry-absence classes are
 * governed separately below; folding them into one number would let a
 * county's 1,776 empty-geometry rows mask a genuine coordinate problem,
 * and would equally make a coordinate ceiling unreachable in practice.
 */
export const TXGIO_MAX_DECLINED_ABSOLUTE = 10;

/**
 * HALT CEILING for GEOMETRY-ABSENCE declinations (no polygon, empty
 * geometry, degenerate bbox) as a fraction of the county.
 *
 * This class is NOT new — it is the path that fired 148 times across 9
 * landed counties as a bare integer. Measuring it properly for the first
 * time (probe 2026-08-09) shows it is far larger than the 148 suggested,
 * because those 9 counties were simply the ones that happened to land:
 *
 *   48499 Wood           0 of  44,576
 *   48213 Henderson  1,776 of 108,484  (1.64%) — none carry identity
 *   48291 Liberty    1,903 of 164,178  (1.16%) — 1,145 DO carry identity
 *
 * Those 1,145 identified Liberty parcels are real records the ingest has
 * always dropped silently; they are now named in the declined roster,
 * which is the entire point of this change. They are attribute rows the
 * publisher shipped without geometry, and this pipeline stores geometry,
 * so declining them remains correct — but declining them INVISIBLY was
 * not.
 *
 * The ceiling is therefore set to tolerate the measured real world (a
 * couple of percent) while still catching a county that is largely
 * geometry-less, which would mean a truncated or wrong download rather
 * than publisher sloppiness. It is a fraction only: an absolute ceiling
 * cannot work across a 254-county range from ~1,600 to ~700,000 parcels.
 *
 * EVALUATED AT END OF RUN, NOT MID-STREAM, and that distinction is
 * load-bearing. These features are CLUSTERED in the source: Henderson
 * ships 473 of its first 1,000 records without geometry (47%) while the
 * county-wide rate is 1.64%. A mid-stream fraction test reads that
 * prefix as a 47%-broken county and halts a county that is in fact fine.
 * Only the whole-county rate is meaningful for this class, so it is
 * checked once, after the last feature. The COORDINATE class is the
 * opposite and stays mid-stream: it must abort before loading garbage.
 */
export const TXGIO_MAX_GEOMETRY_ABSENT_FRACTION = 0.05;

/**
 * The same ceiling as a fraction, which is what actually protects a
 * SMALL county. Loving County ships roughly 1,600 parcels, so a flat
 * absolute-only ceiling of 10 would let a genuinely broken small county
 * decline 0.6 percent of itself and still report success. A projection
 * error is not subtle — it is 100 percent of features — so 0.1 percent
 * separates the two cases with enormous margin.
 */
export const TXGIO_MAX_DECLINED_FRACTION = 0.001;

/**
 * The fraction ceiling is meaningless on a handful of records — at 1
 * declination of 1 read it is trivially 100 percent. It therefore only
 * engages once enough of the county has been read for the ratio to carry
 * information. Below this, the absolute ceiling is the only rule, which
 * is the correct posture: 10 declinations in the first 1,000 features is
 * already over the absolute ceiling and halts anyway.
 */
export const FRACTION_CEILING_MIN_SAMPLE = 1_000;

/**
 * Thrown when declinations breach the ceiling — i.e. when the evidence
 * says this is not a handful of publisher placeholders but a broken
 * county. Distinct from `TxgioProjectionError` so a caller can tell
 * "the source CRS is wrong" from "too much of this county is refused".
 */
export class TxgioDeclineCeilingError extends Error {
  readonly declinedCount: number;
  readonly featuresRead: number;
  constructor(message: string, declinedCount: number, featuresRead: number) {
    super(message);
    this.name = "TxgioDeclineCeilingError";
    this.declinedCount = declinedCount;
    this.featuresRead = featuresRead;
  }
}

/**
 * THE HALT-VERSUS-DECLINE RULE, enforced as the stream advances.
 *
 * Declining a feature is only defensible while declinations stay a
 * bounded anomaly. Past the ceiling the right reading flips: this is not
 * a publisher emitting a couple of placeholders, it is a county whose
 * data cannot be trusted, and the run must fail closed exactly as it did
 * before this path existed.
 *
 * Called per declination (cheap, and it must fire mid-stream rather than
 * at the end — a run that would decline 100,000 features should die on
 * the eleventh, not after loading a garbage county).
 *
 * The absolute term catches large counties, the fraction term catches
 * small ones, and the fraction is only applied once enough features have
 * been read for it to mean anything — otherwise the very first
 * declination, at 1 of 1 read, is trivially 100 percent and every county
 * with a placeholder in its first records would halt.
 */
export function assertDeclineCeiling(
  counters: ParseCounters,
  countyFips: string,
): void {
  const read = Math.max(counters.rowsRead, 1);
  const names = (reason: DeclineReason): string =>
    counters.declined
      .filter((d) => d.reason === reason)
      .slice(0, 5)
      .map((d) => `#${d.featureIndex}(prop_id=${d.propId ?? "-"})`)
      .join(", ");

  // 1. THE COORDINATE CLASS — must stay vanishingly rare, because an
  //    out-of-envelope coordinate is the signature of the whole-county
  //    failure the envelope guard exists to catch.
  const placeholders = counters.declined.filter(
    (d) => d.reason === "out-of-envelope-null-placeholder",
  ).length;
  const placeholderFraction = placeholders / read;
  // Both terms guard a different end of the size range: the absolute
  // ceiling catches large counties, the fraction catches small ones.
  const overAbsolute = placeholders > TXGIO_MAX_DECLINED_ABSOLUTE;
  const overFraction =
    read >= FRACTION_CEILING_MIN_SAMPLE &&
    placeholderFraction > TXGIO_MAX_DECLINED_FRACTION;
  if (overAbsolute || overFraction) {
    throw new TxgioDeclineCeilingError(
      `county ${countyFips}: ${placeholders} out-of-envelope null-placeholder ` +
        `features declined out of ${read} read ` +
        `(${(placeholderFraction * 100).toFixed(3)}%), above the ceiling of ` +
        `${TXGIO_MAX_DECLINED_ABSOLUTE} absolute / ` +
        `${(TXGIO_MAX_DECLINED_FRACTION * 100).toFixed(1)}% — this is no ` +
        `longer a handful of publisher placeholders but a county whose ` +
        `coordinates cannot be trusted. Refusing to load it; the declined ` +
        `roster names every refused feature. Declined so far: ` +
        `${names("out-of-envelope-null-placeholder")}`,
      placeholders,
      read,
    );
  }

  // The GEOMETRY-ABSENCE class is deliberately NOT checked here — see
  // `assertFinalDeclineCeiling`, which runs once at end of stream.
}

/**
 * END-OF-RUN ceiling for the geometry-absence class.
 *
 * Separate from `assertDeclineCeiling` because the two classes need
 * opposite timing. An out-of-envelope coordinate must abort the run
 * immediately — loading half a mis-projected county is the failure mode
 * the guard exists to prevent. Geometry absence is the reverse: it is
 * clustered in the source (Henderson's first 1,000 records are 47%
 * empty against a 1.64% county-wide rate), so only the final whole-county
 * rate carries information, and testing it early halts good counties.
 */
export function assertFinalDeclineCeiling(
  counters: ParseCounters,
  countyFips: string,
): void {
  const read = Math.max(counters.rowsRead, 1);
  const geometryAbsent = counters.declined.filter(
    (d) =>
      d.reason === "no-polygon-geometry" ||
      d.reason === "empty-geometry" ||
      d.reason === "degenerate-bbox",
  ).length;
  const absentFraction = geometryAbsent / read;
  if (
    read >= FRACTION_CEILING_MIN_SAMPLE &&
    absentFraction > TXGIO_MAX_GEOMETRY_ABSENT_FRACTION
  ) {
    throw new TxgioDeclineCeilingError(
      `county ${countyFips}: ${geometryAbsent} of ${read} features read ` +
        `(${(absentFraction * 100).toFixed(2)}%) carry no usable geometry, ` +
        `above the ${(TXGIO_MAX_GEOMETRY_ABSENT_FRACTION * 100).toFixed(0)}% ` +
        `ceiling — a county this empty means a truncated or wrong download, ` +
        `not publisher sloppiness. Refusing to load a county that would be ` +
        `mostly absent. Declined: ${counters.declined
          .filter((d) => d.reason !== "out-of-envelope-null-placeholder")
          .slice(0, 5)
          .map((d) => `#${d.featureIndex}(${d.reason})`)
          .join(", ")}`,
      geometryAbsent,
      read,
    );
  }
}

/**
 * THE DISCRIMINATOR. True only for a feature that carries NO source
 * identity at all — the null-placeholder shape that the StratMap 202503
 * vintage emits.
 *
 * MEASURED, not assumed (probe 2026-08-09 over the three halting
 * counties, reading every record of each live archive):
 *
 *   county          records    out-of-envelope   all placeholders?
 *   48499 Wood       44,576          1                 yes
 *   48213 Henderson 108,484          2                 yes
 *   48291 Liberty   164,178          2                 yes
 *
 * The identity test alone is NOWHERE NEAR sufficient, and that is the
 * single most important property of this predicate. The same probe found
 * placeholder-shaped ATTRIBUTES on features whose geometry is perfectly
 * valid Texas land:
 *
 *   48499 Wood        1,168 placeholder-attribute features INSIDE the envelope
 *   48213 Henderson   8,026
 *   48291 Liberty     1,643
 *
 * That is 10,837 real, mapped parcels across three counties that an
 * attributes-only rule would silently destroy — a 1,168-to-1 over-drop
 * in Wood alone. Those features have geometry the map serves; only their
 * CAD attribute join is empty. They MUST load.
 *
 * So the decline predicate is the CONJUNCTION, and `normalizeTxgioFeature`
 * applies it only on the out-of-envelope branch: a feature is declined
 * when its coordinates are impossible AND it has no identity to lose.
 * Out-of-envelope with a real `Prop_ID` still throws — that is either a
 * projection failure or a real parcel with broken geometry, and both
 * must halt rather than quietly vanish.
 *
 * Value fields are deliberately NOT part of the test. A zero-value
 * parcel is ordinary (exempt, or not yet appraised); it is the absence
 * of every IDENTIFIER that marks a placeholder, and adding a value term
 * would only narrow the predicate on an irrelevant axis.
 */
export function isNullPlaceholderFeature(
  properties: Record<string, unknown> | null | undefined,
): boolean {
  const p = properties ?? {};
  const propId = (str(p.Prop_ID) ?? "").trim();
  const geoId = (str(p.GEO_ID) ?? "").trim();
  // "0" is the publisher's null Prop_ID; a real parcel never carries it.
  const hasPropId = propId !== "" && propId !== "0";
  const hasGeoId = geoId !== "";
  return !hasPropId && !hasGeoId;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  }
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

export interface TxgioFeature {
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

/** Per-run parse options. */
export interface TxgioNormalizeOptions {
  /**
   * Source CRS to convert FROM before the Texas envelope assertion.
   * Undefined (the default) means NO conversion: coordinates are taken
   * as WGS84 degrees and a projected county fails closed, exactly as
   * before. This is opt-in by construction — there is no detection
   * inside the parser that can turn it on.
   */
  reprojectFrom?: SupportedSourceCrs;
}

/**
 * Normalize one shapefile feature. Returns null (and counts a skip)
 * when the feature carries no usable polygon geometry — an
 * attribute-only row cannot serve either read path.
 *
 * REPROJECTION ORDERING. When `opts.reprojectFrom` is set, coordinates
 * are converted FIRST and every downstream step — bbox, the Texas
 * envelope assertion, cell bucketing, the stored geometry — sees only
 * degrees. The assertion therefore still runs, on the CONVERTED
 * coordinates, and a county that reprojects to somewhere other than
 * Texas fails closed exactly as an unconverted projected county does.
 * Reprojection is a step before the guard, never a way around it.
 */
export function normalizeTxgioFeature(
  countyFips: string,
  featureIndex: number,
  feature: TxgioFeature,
  counters: ParseCounters,
  opts: TxgioNormalizeOptions = {},
): TxgioParcelRecord | null {
  const props = feature.properties ?? {};
  // Identity is captured UP FRONT so every decline path below can name
  // the feature it refused. This is the fix for the 148 features that
  // were dropped across 9 landed counties as a bare integer.
  const identify = (
    reason: DeclinedFeature["reason"],
    detail: string,
  ): DeclinedFeature => ({
    countyFips,
    featureIndex,
    propId: str(props.Prop_ID),
    geoId: str(props.GEO_ID),
    objectId: str(props.OBJECTID_1),
    ownerName: str(props.OWNER_NAME),
    reason,
    detail,
  });

  const sourceGeometry = feature.geometry;
  if (
    !sourceGeometry ||
    (sourceGeometry.type !== "Polygon" &&
      sourceGeometry.type !== "MultiPolygon")
  ) {
    recordDecline(
      counters,
      identify(
        "no-polygon-geometry",
        `geometry type ${sourceGeometry?.type ?? "null"}`,
      ),
    );
    return null;
  }
  // Convert BEFORE the guard, never instead of it (see the note above).
  // A throw here is a whole-county property like a projection error, so
  // it propagates rather than counting a skip.
  const geometry = opts.reprojectFrom
    ? reprojectGeometry(sourceGeometry, opts.reprojectFrom)
    : sourceGeometry;
  const bbox = bboxOfGeometry(geometry);
  if (!bbox) {
    recordDecline(counters, identify("empty-geometry", "no bbox derivable"));
    return null;
  }
  // Fail-closed projection guard — see assertTexasWgs84Bbox. Throws
  // (does NOT skip): non-degree coordinates are a whole-county
  // property, so the run must abort rather than load a partial county.
  //
  // THE ONE EXCEPTION, and it is deliberately narrow. A feature whose
  // coordinates are impossible AND which carries no identity whatsoever
  // is a publisher null placeholder (`isNullPlaceholderFeature` above,
  // measured across 48499/48213/48291). Refusing THAT feature and
  // loading the other 44,575 is strictly more honest than refusing the
  // county: the placeholder is recorded with identity in
  // `counters.declined`, so it reads as a named absence rather than
  // either a silent drop or a whole county missing.
  //
  // Everything else about the guard is unchanged. The envelope is not
  // widened, the assertion is not made permissive, and an out-of-envelope
  // feature WITH a real Prop_ID or GEO_ID still throws — the ceiling
  // check in `assertDeclineCeiling` then catches the case where enough
  // features are declined that the county itself must be presumed broken.
  //
  // AND NOT WHEN REPROJECTING. Under `--reproject`, an out-of-envelope
  // result means the CONVERSION is wrong, and a wrong conversion is a
  // whole-county property that would mis-place every feature — including
  // the ones that happen to carry identity and so would still throw.
  // Declining the identity-less subset there would quietly thin a county
  // whose coordinates are all suspect. Reprojected counties therefore
  // keep the original, unconditional fail-closed behaviour.
  try {
    assertTexasWgs84Bbox(bbox, `county ${countyFips} feature ${featureIndex}`);
  } catch (err) {
    if (
      err instanceof TxgioProjectionError &&
      !opts.reprojectFrom &&
      isNullPlaceholderFeature(props)
    ) {
      recordDecline(
        counters,
        identify(
          "out-of-envelope-null-placeholder",
          `bbox [${bbox.westLng}, ${bbox.southLat}, ${bbox.eastLng}, ` +
            `${bbox.northLat}] outside Texas; no Prop_ID and no GEO_ID`,
        ),
      );
      return null;
    }
    throw err;
  }
  const tileKeys = cellKeysForBbox(bbox);
  if (tileKeys === null || tileKeys.length === 0) {
    // Unbounded maxCells is never null; empty means a degenerate bbox.
    recordDecline(counters, identify("degenerate-bbox", "zero tile cells"));
    return null;
  }

  const p = props;
  return {
    countyFips,
    featureIndex,
    propId: str(p.Prop_ID),
    geoId: str(p.GEO_ID),
    ownerName: str(p.OWNER_NAME),
    situsAddress: str(p.SITUS_ADDR),
    situsCity: str(p.SITUS_CITY),
    situsState: str(p.SITUS_STAT),
    situsZip: str(p.SITUS_ZIP),
    geometry,
    bbox,
    tileKeys,
  };
}
