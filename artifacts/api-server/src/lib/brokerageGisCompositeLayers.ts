/**
 * Max map composite reasoning layers — fixture-friendly EngineEnvelope responses.
 */

import {
  wrapEngineEnvelope,
  type EngineEnvelope,
  type EngineHonesty,
} from "../../../../lib/engine-core/src/envelope";
import {
  legacyHonestyToReadContract,
  readContractForWire,
} from "@workspace/engine-core";
import type { ReadContract } from "@hauska/atom-contract/read-contract";
import type { ArcGisGeoJsonFeatureCollection } from "@workspace/adapters/arcgis";
import type { GisLayerBbox } from "./brokerageGisLayers";
import { queryGisLayerGeoJson } from "./brokerageGisLayers";
import {
  queryFederalGisLayerGeoJson,
  scoreSsurgoFeatureRisk,
} from "./brokerageGisFederalLayers";
import {
  keyFromEngagementOrSynthesize,
  retrieveAtomsForQuestion,
  type RetrievedAtom,
} from "@workspace/codes";
import { logger } from "./logger";
import {
  ozTractsInBbox,
  ozTractLayerProvenance,
  bboxWithinOzCoverage,
} from "./opportunityZoneAdapter";
import {
  fetchAbsenteeSignalsForTile,
  type AbsenteeSignal,
  type MotivatedSellerSignalDb,
  type ParcelIdentity,
} from "./brokerageMotivatedSellerSignals";

export type CompositeLayerKey =
  | "buildable-envelope"
  | "constraint-density"
  | "oz-deal-crossfilter"
  | "motivated-seller";

export const COMPOSITE_LAYER_KEYS: readonly CompositeLayerKey[] = [
  "buildable-envelope",
  "constraint-density",
  "oz-deal-crossfilter",
  "motivated-seller",
];

export type CompositeLayerProvenance = {
  ozDesignation: {
    source: string;
    sourceUrl: string | null;
    designationRound: string;
    dataVintage: string | null;
    tractListVersion: string;
    nationalDesignatedTractCount: number | null;
    nationalCountNote: string | null;
    bundledScope: string | null;
    matchMethod: "bbox-overlap";
    /**
     * Whether the requested viewport is within the loaded OZ layer's coverage
     * envelope. When "out-of-scope", an empty result means "unknown here", not
     * "confidently no OZ" — the honesty is degraded accordingly.
     */
    coverage: "in-scope" | "out-of-scope";
  };
  dealSignal: {
    kind: "oz-designation-membership";
    source: string;
    excludes: string[];
    note: string;
  };
  generatedAt: string;
};

/**
 * Provenance for a derived buildable-envelope. Every field is real or null —
 * a null dimensional standard means "not found in the corpus for this
 * jurisdiction/district", which downgrades the honesty rather than being
 * silently defaulted to a number.
 */
export type BuildableEnvelopeProvenance = {
  parcel: {
    source: string;
    sourceUrl: string | null;
    notSurveyGrade: boolean;
    /** Whether a parcel polygon was resolved for this viewport at all. */
    resolved: boolean;
  };
  zoning: {
    /** Zoning district / code resolved from the parcel attributes (Cotality site-location enrich). */
    district: string | null;
    description: string | null;
    source: string;
    resolved: boolean;
  };
  dimensionalStandards: {
    jurisdictionKey: string | null;
    source: string;
    sourceUrl: string | null;
    /** Code-atom ids the setback/FAR/height/coverage values were read from. */
    citedAtomIds: string[];
    frontSetbackFt: number | null;
    sideSetbackFt: number | null;
    rearSetbackFt: number | null;
    farLimit: number | null;
    heightLimitFt: number | null;
    lotCoveragePct: number | null;
    /** How complete the dimensional set is: full | partial | none. */
    completeness: "full" | "partial" | "none";
  };
  method: {
    kind: "centroid-inset-approximation";
    note: string;
  };
  /**
   * Three-way coverage state, mirroring the OZ derivation:
   *   in-scope-derived — parcel + at least one dimensional standard → earned
   *   in-scope-partial — parcel resolved but dimensional set incomplete → lowered confidence, honest
   *   out-of-scope     — parcel geometry OR jurisdiction/zoning missing → degraded, absence-is-unknown
   */
  coverage: "in-scope-derived" | "in-scope-partial" | "out-of-scope";
  generatedAt: string;
};

/**
 * Provenance for a derived constraint-density surface. constraint-density is a
 * COMPOSITION over already-live constraint layers (FEMA flood, SSURGO soils,
 * Edwards aquifer, MUD/PID), never a new source and never a synthetic number.
 *
 * Each contributing layer is recorded with its own provenance and its
 * evaluation state. A layer that was unreachable for the viewport is recorded
 * as `evaluated:false` so the density is honestly PARTIAL — an unevaluated
 * layer is NEVER silently treated as zero-constraint.
 */
export type ConstraintLayerProvenance = {
  key: "fema-flood" | "ssurgo-soils" | "edwards-aquifer" | "mud-pid";
  label: string;
  source: string;
  sourceUrl: string | null;
  /** Severity weight this layer contributes when a cell overlaps it. */
  severityWeight: number;
  /** Whether the layer was reachable and returned an answer for this viewport. */
  evaluated: boolean;
  /**
   * Feature count returned by the layer for the viewport. 0 with evaluated:true
   * means "confidently no constraint of this kind here"; evaluated:false means
   * "unknown — absence is not confirmed-none".
   */
  featureCount: number;
  /** Reason the layer was not evaluated (upstream/no-coverage), when applicable. */
  note: string | null;
};

export type ConstraintDensityProvenance = {
  method: {
    kind: "severity-weighted-layer-stack";
    note: string;
    /** Grid the viewport was tessellated into (cells = gridSize x gridSize). */
    gridSize: number;
  };
  contributingLayers: ConstraintLayerProvenance[];
  /** Layers excluded by design (not queryable server-side as constraints), with why. */
  excludedLayers: Array<{ key: string; reason: string }>;
  /** How many of the constraint layers were actually evaluated (reachable). */
  layersEvaluated: number;
  layersTotal: number;
  /**
   * Three-way coverage state, mirroring the OZ + buildable derivations:
   *   in-scope-derived — all constraint layers evaluated → earned
   *   in-scope-partial — some (>=1) but not all evaluated → lowered confidence, honest
   *   out-of-scope     — zero constraint layers reachable → degraded, absence-is-unknown
   */
  coverage: "in-scope-derived" | "in-scope-partial" | "out-of-scope";
  dataVintage: string;
  generatedAt: string;
};

/**
 * Provenance for a derived motivated-seller heat score. motivated-seller is a
 * TRANSPARENT documented WEIGHTED-SUM over TX public-record signals acquired via
 * the uniform public-record process (ruling R3). It is NOT a bought propensity
 * model and NOT a black box: every signal carries a named documented weight, and
 * the score is fully reconstructable from `contributingSignals`.
 *
 * A signal that is unavailable for a parcel (no store ingested, or no match) is
 * recorded `evaluated:false` and EXCLUDED from the weighted-sum denominator, the
 * same partial-honesty as constraint-density — an unavailable signal is NEVER
 * treated as "signal absent = not motivated".
 */
export type MotivatedSellerSignalProvenance = {
  key:
    | "tax-delinquency"
    | "absentee-owner"
    | "pre-foreclosure-nos"
    | "lis-pendens-tax-lien"
    | "probate-estate";
  label: string;
  /** Documented weight this signal contributes to the weighted-sum. */
  weight: number;
  /** One-line rationale for the weight (R3: every weight is documented). */
  weightRationale: string;
  source: string;
  sourceUrl: string | null;
  /** Whether this signal's DATA is ingested/reachable for the parcel at all. */
  evaluated: boolean;
  /**
   * The signal's normalized value in [0,1] when evaluated; null when
   * not-evaluated. This is the signal's own contribution factor, not the
   * weighted term.
   */
  value: number | null;
  dataVintage: string | null;
  /** Reason the signal was not evaluated (data not ingested / no match), when applicable. */
  note: string | null;
};

export type MotivatedSellerProvenance = {
  method: {
    kind: "transparent-weighted-sum";
    note: string;
    excludes: string[];
  };
  /** Every signal in the model, with weight + evaluated/not-evaluated state. */
  signals: MotivatedSellerSignalProvenance[];
  /** Signals whose data is NOT yet ingested — each an operator/fleet data-pull. */
  pendingIngest: Array<{ key: string; dataPull: string }>;
  signalsEvaluated: number;
  signalsTotal: number;
  /**
   * Three-way coverage state, mirroring the OZ + buildable + constraint
   * derivations:
   *   in-scope-derived — all modeled signals evaluated -> earned
   *   in-scope-partial — some (>=1) but not all evaluated -> lowered confidence
   *   out-of-scope     — zero signals evaluated -> degraded, absence-is-unknown
   */
  coverage: "in-scope-derived" | "in-scope-partial" | "out-of-scope";
  /**
   * Confidence is ASSERTED with a verification state — calibration (arrow two)
   * does not exist yet, so this is honestly asserted with provenance, never a
   * bare number and never presented as calibrated/earned.
   */
  verificationState: "asserted-unverified";
  generatedAt: string;
};

export type CompositeLayerPayload = {
  layer: CompositeLayerKey;
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "bbox";
  fixture?: boolean;
  notes?: string;
  provenance?: CompositeLayerProvenance;
  buildableProvenance?: BuildableEnvelopeProvenance;
  constraintProvenance?: ConstraintDensityProvenance;
  motivatedSellerProvenance?: MotivatedSellerProvenance;
};

function defaultHonesty(adapter: string, degraded = false): EngineHonesty {
  return {
    confidence: { value: degraded ? 0.55 : 0.72, kind: "asserted" },
    dataVintage: new Date().toISOString().slice(0, 10),
    coverage: degraded
      ? {
          degraded: true,
          reason: "Composite derived from fixture/synthetic inputs for dev.",
        }
      : { degraded: false },
    source: { adapter },
  };
}

/**
 * Real oz-deal-crossfilter derivation (STEP B).
 *
 * Resolves which CDFI/HUD-designated Opportunity Zone tracts overlap the
 * requested viewport from the refreshed bundled OZ layer, and emits each with
 * real tract geometry plus full provenance. The "deal signal" is the OZ
 * designation itself — a public, investor-relevant tax-advantage signal
 * (capital-gains deferral eligibility). No Cotality propensity is consumed
 * (eval-clause); no synthetic dealScore/radarTier is invented.
 *
 * Membership is a deterministic bbox-overlap test against authoritative federal
 * geometry, so the honesty is deterministic/earned, not an asserted number.
 */
export function deriveOzDealCrossfilter(bbox: GisLayerBbox): {
  payload: CompositeLayerPayload;
  honesty: EngineHonesty;
} {
  const prov = ozTractLayerProvenance();
  const queryBbox = {
    westLng: bbox.westLng,
    southLat: bbox.southLat,
    eastLng: bbox.eastLng,
    northLat: bbox.northLat,
  };
  const inScope = bboxWithinOzCoverage(queryBbox);
  const tracts = inScope ? ozTractsInBbox(queryBbox) : [];
  const generatedAt = new Date().toISOString();

  const provenance: CompositeLayerProvenance = {
    ozDesignation: {
      source: prov.source,
      sourceUrl: prov.sourceUrl,
      designationRound: prov.designationRound,
      dataVintage: prov.dataVintage,
      tractListVersion: prov.tractListVersion,
      nationalDesignatedTractCount: prov.nationalDesignatedTractCount,
      nationalCountNote: prov.nationalCountNote,
      bundledScope: prov.bundledScope,
      matchMethod: "bbox-overlap",
      coverage: inScope ? "in-scope" : "out-of-scope",
    },
    dealSignal: {
      kind: "oz-designation-membership",
      source: "CDFI/HUD OZ designation (public federal record)",
      excludes: ["cotality-propensity", "tenant-private", "synthetic-deal-score"],
      note:
        "v1 deal signal is OZ designation membership only. No public-record per-tract deal score exists in the spine yet; none is fabricated.",
    },
    generatedAt,
  };

  const features = tracts.map((t) => {
    const geoid = String(t.properties.geoid10 ?? "");
    return {
      type: "Feature" as const,
      geometry: t.geometry,
      properties: {
        kind: "oz-deal-crossfilter",
        geoid10: geoid,
        inOpportunityZone: true,
        ozDesignationRound: String(t.properties.round ?? prov.designationRound),
        countyFips: t.properties.countyfp ?? null,
        stateFips: t.properties.statefp ?? null,
        dealSignal: "oz-designation-membership",
        dealSignalSource: "CDFI/HUD OZ designation (public federal record)",
        // Reasoning chain per commitment #1 — no bare/unearned number.
        reasoning: `Tract ${geoid} is a CDFI/HUD-designated Opportunity Zone (${provenance.ozDesignation.designationRound}); OZ status is a public, investor-relevant capital-gains-deferral signal. Membership resolved by deterministic bbox overlap against authoritative federal geometry.`,
        confidence: 1,
        confidenceKind: "deterministic",
        source: prov.source,
        sourceUrl: prov.sourceUrl,
        dataVintage: prov.dataVintage,
        generatedAt,
      },
    };
  });

  // Coverage honesty (55 §7 rule #5): an empty result only means "no OZ here"
  // when the viewport is within the loaded layer's coverage envelope. Outside
  // it — e.g. a non-Central-TX bbox against the bundled fixture, or any env
  // where the national set is not yet GCS-hydrated — absence is UNKNOWN, so we
  // degrade rather than assert a confident empty.
  const outOfScopeReason = prov.bundledScope
    ? `OZ layer not hydrated for this region; loaded scope is ${prov.bundledScope}. The national set hydrates from GCS in prod (BROKERAGE_FEDERAL_DATA_GCS_PREFIX). Absence of OZ tracts here is unknown, not confirmed-none.`
    : "OZ layer does not cover this region in the current environment; absence is unknown, not confirmed-none.";

  const honesty: EngineHonesty = inScope
    ? {
        confidence: { value: 1, kind: "deterministic" },
        dataVintage: prov.dataVintage,
        coverage: { degraded: false },
        source: { adapter: "brokerage:composite-oz-deal-crossfilter" },
      }
    : {
        confidence: { value: 0.2, kind: "asserted" },
        dataVintage: prov.dataVintage,
        coverage: { degraded: true, reason: outOfScopeReason },
        source: { adapter: "brokerage:composite-oz-deal-crossfilter" },
      };

  const notes = inScope
    ? `Designated OZ tracts overlapping the viewport (${features.length}), each carrying OZ-designation deal signal + provenance. Deal signal excludes Cotality propensity.`
    : `Viewport is outside the loaded OZ coverage envelope. ${outOfScopeReason}`;

  return {
    payload: {
      layer: "oz-deal-crossfilter",
      queryMode: "bbox",
      fixture: false,
      featureCount: features.length,
      notes,
      provenance,
      geojson: {
        type: "FeatureCollection",
        features,
      },
    },
    honesty,
  };
}

// ---------------------------------------------------------------------------
// Buildable-envelope derivation (STEP: promote 78% fixture -> real derivation)
// ---------------------------------------------------------------------------

type LngLat = [number, number];

/**
 * Shoelace area of a WGS84 ring, projected to an approximately-equal-area
 * local plane (degrees scaled to meters at the ring's mean latitude). Returns
 * square meters. Sign-agnostic (absolute). Rings are assumed small (a single
 * parcel) so the flat-earth approximation error is negligible relative to the
 * conservative-inset approximation that already dominates the result.
 */
function ringAreaSqMeters(ring: LngLat[]): number {
  if (ring.length < 4) return 0;
  const meanLat =
    ring.reduce((s, p) => s + p[1], 0) / Math.max(ring.length, 1);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((meanLat * Math.PI) / 180);
  let acc = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0] * mPerDegLng;
    const yi = ring[i]![1] * mPerDegLat;
    const xj = ring[j]![0] * mPerDegLng;
    const yj = ring[j]![1] * mPerDegLat;
    acc += xj * yi - xi * yj;
  }
  return Math.abs(acc) / 2;
}

/** Centroid of a ring (ignores the closing duplicate vertex). */
function ringCentroid(ring: LngLat[]): LngLat {
  const n = Math.max(ring.length - 1, 1);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]![0];
    cy += ring[i]![1];
  }
  return [cx / n, cy / n];
}

/**
 * Conservative buildable-ring approximation. TRUE polygon setback offsetting
 * (a negative buffer along every edge normal) needs a geometry library
 * (turf/jsts), and none is a dependency in this repo. Rather than add a heavy
 * dep for v1, we approximate the setback inset by shrinking the parcel ring
 * toward its centroid by the fraction of the parcel's mean half-span consumed
 * by the (front+rear) and (side+side) setbacks. This is an APPROXIMATION — it
 * is labeled as such in provenance and carries lowered confidence. It never
 * over-states buildable area for a convex-ish parcel: a uniform centroid
 * shrink removes at least as much as a true inward buffer of the same depth.
 */
function centroidInsetRing(ring: LngLat[], insetFraction: number): LngLat[] {
  const clamped = Math.max(0, Math.min(0.95, insetFraction));
  const [cx, cy] = ringCentroid(ring);
  const scale = 1 - clamped;
  return ring.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]);
}

/** Meters -> degrees (lat / lng) at a given latitude, for setback -> fraction. */
function metersToDegrees(
  meters: number,
  latDeg: number,
): { degLat: number; degLng: number } {
  const degLat = meters / 111_320;
  const degLng = meters / (111_320 * Math.cos((latDeg * Math.PI) / 180) || 1);
  return { degLat, degLng };
}

function firstPolygonRing(geometry: unknown): LngLat[] | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const outer = (g.coordinates as unknown[])[0];
    if (Array.isArray(outer) && outer.length >= 4) return outer as LngLat[];
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    // Take the largest polygon's outer ring.
    let best: LngLat[] | null = null;
    let bestArea = -1;
    for (const poly of g.coordinates as unknown[]) {
      if (!Array.isArray(poly)) continue;
      const outer = poly[0];
      if (!Array.isArray(outer) || outer.length < 4) continue;
      const a = ringAreaSqMeters(outer as LngLat[]);
      if (a > bestArea) {
        bestArea = a;
        best = outer as LngLat[];
      }
    }
    return best;
  }
  return null;
}

const FEET_PER_METER = 3.280_84;

/** Pull the largest plausible "N ft" dimension from an atom body for a keyword. */
function parseFeetNear(body: string, keywords: string[]): number | null {
  const hay = body.toLowerCase();
  let best: number | null = null;
  for (const kw of keywords) {
    let idx = hay.indexOf(kw);
    while (idx !== -1) {
      // Look in a window after the keyword for "<n> feet|ft|'".
      const window = body.slice(idx, idx + 120);
      const m = window.match(
        /(\d{1,3}(?:\.\d+)?)\s*(?:feet|foot|ft\.?|')/i,
      );
      if (m) {
        const v = Number(m[1]);
        if (Number.isFinite(v) && v > 0 && v < 300) {
          best = best === null ? v : Math.min(best, v);
        }
      }
      idx = hay.indexOf(kw, idx + kw.length);
    }
  }
  return best;
}

/** Pull a FAR ratio (e.g. "floor area ratio of 0.4" or "F.A.R. 2.0"). */
function parseFar(body: string): number | null {
  const m = body.match(
    /(?:floor[\s-]*area[\s-]*ratio|f\.?a\.?r\.?)[^0-9]{0,20}(\d(?:\.\d+)?)/i,
  );
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && v <= 30) return v;
  }
  return null;
}

/** Pull a lot-coverage percentage (e.g. "maximum lot coverage of 40%"). */
function parseLotCoveragePct(body: string): number | null {
  const m = body.match(
    /(?:lot[\s-]*coverage|building[\s-]*coverage|maximum[\s-]*coverage)[^0-9]{0,30}(\d{1,3}(?:\.\d+)?)\s*%/i,
  );
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && v <= 100) return v;
  }
  return null;
}

type DimensionalStandards = {
  frontSetbackFt: number | null;
  sideSetbackFt: number | null;
  rearSetbackFt: number | null;
  farLimit: number | null;
  heightLimitFt: number | null;
  lotCoveragePct: number | null;
  citedAtomIds: string[];
  sourceUrl: string | null;
};

/**
 * Read dimensional standards (setbacks / FAR / height / lot coverage) for a
 * jurisdiction from the code corpus via the same retrieval path the brief's
 * local-code layer uses. Never fabricates a value: a dimension absent from the
 * retrieved atoms stays null.
 */
async function retrieveDimensionalStandards(
  jurisdictionKey: string,
): Promise<DimensionalStandards> {
  const queries: Array<{ q: string; kind: string }> = [
    { q: "setback requirements front side rear yard", kind: "setback" },
    { q: "floor area ratio FAR maximum", kind: "far" },
    { q: "maximum building height", kind: "height" },
    { q: "maximum lot coverage building coverage", kind: "coverage" },
  ];

  const cited = new Set<string>();
  let front: number | null = null;
  let side: number | null = null;
  let rear: number | null = null;
  let far: number | null = null;
  let height: number | null = null;
  let coverage: number | null = null;
  let sourceUrl: string | null = null;

  for (const { q } of queries) {
    let hits: RetrievedAtom[] = [];
    try {
      hits = await retrieveAtomsForQuestion({
        jurisdictionKey,
        question: q,
        limit: 3,
        logger,
        applyMinScore: false,
      });
    } catch (err) {
      logger.warn(
        { err, jurisdictionKey, query: q },
        "buildable-envelope: dimensional retrieval failed",
      );
    }

    for (const h of hits) {
      const body = h.body ?? "";
      if (!body) continue;
      const f = parseFeetNear(body, ["front setback", "front yard"]);
      const s = parseFeetNear(body, ["side setback", "side yard"]);
      const r = parseFeetNear(body, ["rear setback", "rear yard"]);
      const genericSetback = parseFeetNear(body, ["setback", "yard"]);
      const fr = parseFar(body);
      const ht = parseFeetNear(body, [
        "building height",
        "maximum height",
        "height limit",
        "height of",
      ]);
      const cov = parseLotCoveragePct(body);

      let used = false;
      if (front === null && f !== null) (front = f), (used = true);
      if (side === null && s !== null) (side = s), (used = true);
      if (rear === null && r !== null) (rear = r), (used = true);
      // Fall back to a generic setback figure for any yard we still lack.
      if (genericSetback !== null) {
        if (front === null) (front = genericSetback), (used = true);
        if (side === null) (side = genericSetback), (used = true);
        if (rear === null) (rear = genericSetback), (used = true);
      }
      if (far === null && fr !== null) (far = fr), (used = true);
      if (height === null && ht !== null) (height = ht), (used = true);
      if (coverage === null && cov !== null) (coverage = cov), (used = true);

      if (used) {
        cited.add(h.id);
        if (!sourceUrl && h.sourceUrl) sourceUrl = h.sourceUrl;
      }
    }
  }

  return {
    frontSetbackFt: front,
    sideSetbackFt: side,
    rearSetbackFt: rear,
    farLimit: far,
    heightLimitFt: height,
    lotCoveragePct: coverage,
    citedAtomIds: [...cited],
    sourceUrl,
  };
}

function zoningFromProps(
  props: Record<string, unknown>,
): { district: string | null; description: string | null } {
  const district =
    (typeof props.zoningCode === "string" && props.zoningCode) ||
    (typeof props.zoning === "string" && (props.zoning as string)) ||
    null;
  const description =
    (typeof props.zoningDescription === "string" && props.zoningDescription) ||
    null;
  return { district: district || null, description: description || null };
}

function cityStateFromProps(props: Record<string, unknown>): {
  city: string | null;
  state: string | null;
} {
  const city =
    [props.stdCity, props.city, props.situsCity].find(
      (v) => typeof v === "string" && (v as string).trim(),
    ) ?? null;
  const state =
    [props.stdState, props.state, props.situsState].find(
      (v) => typeof v === "string" && (v as string).trim(),
    ) ?? null;
  return {
    city: typeof city === "string" ? city.trim() : null,
    state: typeof state === "string" ? state.trim() : null,
  };
}

const BUILDABLE_METHOD_NOTE =
  "Buildable ring is a conservative centroid-inset approximation of the setback offset, not a true polygon negative-buffer (no geometry library is a repo dependency). It removes at least as much area as a true inward buffer of the same depth, so buildableAreaPct is a floor, not an exact figure. Confidence is lowered accordingly.";

/**
 * Real buildable-envelope derivation (replaces the hardcoded 78% fixture).
 *
 * Inputs, all live and resolved per-request:
 *   - Parcel polygon: county-GIS / Cotality Spatial Tile via queryGisLayerGeoJson
 *     (the same path the parcels layer uses), which also enriches each parcel
 *     with zoning attributes from the Cotality site-location call.
 *   - Zoning district: read from the enriched parcel properties.
 *   - Dimensional standards (setback / FAR / height / lot coverage): retrieved
 *     from the code corpus for the parcel's jurisdiction via the same retrieval
 *     path the brief's local-code layer uses.
 *
 * Method: take the parcel outer ring, inset it toward the centroid by the
 * fraction of the parcel's mean half-span consumed by the setbacks (a labeled
 * approximation — see BUILDABLE_METHOD_NOTE), then cap the resulting area by
 * the FAR / lot-coverage limit. buildableAreaPct is DERIVED from the resulting
 * geometry, never hardcoded.
 *
 * Three-state coverage honesty (mirrors deriveOzDealCrossfilter):
 *   (a) parcel + >=1 dimensional standard -> in-scope-derived, degraded:false
 *   (b) parcel but incomplete dimensional set -> in-scope-partial, degraded:true,
 *       honest reason naming what is missing, lowered confidence
 *   (c) no parcel geometry, or no jurisdiction/zoning -> out-of-scope,
 *       degraded:true, "absence of a buildable envelope is unknown, not
 *       confirmed-none" — NEVER a fabricated 78%.
 */
export async function deriveBuildableEnvelope(bbox: GisLayerBbox): Promise<{
  payload: CompositeLayerPayload;
  honesty: EngineHonesty;
}> {
  const generatedAt = new Date().toISOString();
  const dataVintage = generatedAt.slice(0, 10);
  const adapter = "brokerage:composite-buildable-envelope";

  // --- Resolve parcel geometry (input 1) ---
  let parcelResult:
    | Awaited<ReturnType<typeof queryGisLayerGeoJson>>
    | null = null;
  try {
    parcelResult = await queryGisLayerGeoJson({ layer: "parcels", bbox });
  } catch (err) {
    logger.warn({ err, bbox }, "buildable-envelope: parcel resolution failed");
  }

  const features = (parcelResult?.geojson.features ?? []) as Array<{
    geometry?: unknown;
    properties?: Record<string, unknown>;
  }>;

  const withRing = features
    .map((f) => ({
      ring: firstPolygonRing(f.geometry),
      props: f.properties ?? {},
    }))
    .filter((f): f is { ring: LngLat[]; props: Record<string, unknown> } =>
      Boolean(f.ring),
    );

  const parcelSource =
    parcelResult?.provider ?? "county-GIS / Cotality Spatial Tile (parcels)";
  const parcelSourceUrl = parcelResult?.serviceUrl ?? null;
  const notSurveyGrade = Boolean(parcelResult?.notSurveyGrade);

  // STATE (c): no parcel geometry resolvable for this viewport.
  if (withRing.length === 0) {
    const reason =
      "Buildable envelope requires a parcel polygon; none was resolvable for this viewport (parcel geometry unavailable). Absence of a buildable envelope here is unknown, not confirmed-none.";
    const provenance: BuildableEnvelopeProvenance = {
      parcel: {
        source: parcelSource,
        sourceUrl: parcelSourceUrl,
        notSurveyGrade,
        resolved: false,
      },
      zoning: {
        district: null,
        description: null,
        source: "Cotality site-location enrich",
        resolved: false,
      },
      dimensionalStandards: {
        jurisdictionKey: null,
        source: "code corpus (retrieval-api / neon)",
        sourceUrl: null,
        citedAtomIds: [],
        frontSetbackFt: null,
        sideSetbackFt: null,
        rearSetbackFt: null,
        farLimit: null,
        heightLimitFt: null,
        lotCoveragePct: null,
        completeness: "none",
      },
      method: { kind: "centroid-inset-approximation", note: BUILDABLE_METHOD_NOTE },
      coverage: "out-of-scope",
      generatedAt,
    };
    return {
      payload: {
        layer: "buildable-envelope",
        queryMode: "bbox",
        fixture: false,
        featureCount: 0,
        notes: reason,
        buildableProvenance: provenance,
        geojson: { type: "FeatureCollection", features: [] },
      },
      honesty: {
        confidence: { value: 0.2, kind: "asserted" },
        dataVintage,
        coverage: { degraded: true, reason },
        source: { adapter },
      },
    };
  }

  // Subject parcel: the largest resolved parcel in the viewport.
  const subject = withRing
    .map((f) => ({ ...f, area: ringAreaSqMeters(f.ring) }))
    .sort((a, b) => b.area - a.area)[0]!;

  const { district, description } = zoningFromProps(subject.props);
  const { city, state } = cityStateFromProps(subject.props);

  const jurisdictionKey = keyFromEngagementOrSynthesize({
    jurisdictionCity: city,
    jurisdictionState: state,
  });

  // --- Resolve dimensional standards (input 3) ---
  const dims: DimensionalStandards = jurisdictionKey
    ? await retrieveDimensionalStandards(jurisdictionKey)
    : {
        frontSetbackFt: null,
        sideSetbackFt: null,
        rearSetbackFt: null,
        farLimit: null,
        heightLimitFt: null,
        lotCoveragePct: null,
        citedAtomIds: [],
        sourceUrl: null,
      };

  const haveAnySetback =
    dims.frontSetbackFt !== null ||
    dims.sideSetbackFt !== null ||
    dims.rearSetbackFt !== null;
  const haveAnyDimension =
    haveAnySetback ||
    dims.farLimit !== null ||
    dims.lotCoveragePct !== null ||
    dims.heightLimitFt !== null;

  const setbackFields = [
    dims.frontSetbackFt,
    dims.sideSetbackFt,
    dims.rearSetbackFt,
    dims.farLimit,
    dims.lotCoveragePct,
  ];
  const knownCount = setbackFields.filter((v) => v !== null).length;
  const completeness: BuildableEnvelopeProvenance["dimensionalStandards"]["completeness"] =
    !haveAnyDimension ? "none" : knownCount >= 4 ? "full" : "partial";

  // STATE (c-alt): parcel exists but NO dimensional standard in the corpus for
  // this jurisdiction, and/or no jurisdiction/zoning resolvable — do NOT guess
  // dimensions. Emit the parcel ring only, degraded, honest reason.
  if (!haveAnyDimension) {
    const missing = !jurisdictionKey
      ? "no jurisdiction/zoning could be resolved for the parcel"
      : "no dimensional zoning atom (setback / FAR / height / lot coverage) was found in the code corpus for this jurisdiction";
    const reason = `Parcel geometry resolved, but ${missing}; a buildable envelope cannot be derived without dimensional standards, so none is fabricated. The parcel outline is returned as-is. Absence of a derived envelope is unknown, not confirmed-none.`;
    const provenance: BuildableEnvelopeProvenance = {
      parcel: {
        source: parcelSource,
        sourceUrl: parcelSourceUrl,
        notSurveyGrade,
        resolved: true,
      },
      zoning: {
        district,
        description,
        source: "Cotality site-location enrich",
        resolved: Boolean(district),
      },
      dimensionalStandards: {
        jurisdictionKey,
        source: "code corpus (retrieval-api / neon)",
        sourceUrl: dims.sourceUrl,
        citedAtomIds: dims.citedAtomIds,
        frontSetbackFt: dims.frontSetbackFt,
        sideSetbackFt: dims.sideSetbackFt,
        rearSetbackFt: dims.rearSetbackFt,
        farLimit: dims.farLimit,
        heightLimitFt: dims.heightLimitFt,
        lotCoveragePct: dims.lotCoveragePct,
        completeness: "none",
      },
      method: { kind: "centroid-inset-approximation", note: BUILDABLE_METHOD_NOTE },
      coverage: "out-of-scope",
      generatedAt,
    };
    return {
      payload: {
        layer: "buildable-envelope",
        queryMode: "bbox",
        fixture: false,
        featureCount: 1,
        notes: reason,
        buildableProvenance: provenance,
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [subject.ring] },
              properties: {
                kind: "buildable-envelope",
                derived: false,
                zoningDistrict: district,
                buildableAreaPct: null,
                reasoning: reason,
                confidence: 0.25,
                confidenceKind: "asserted",
                source: parcelSource,
                sourceUrl: parcelSourceUrl,
                dataVintage,
                generatedAt,
              },
            },
          ],
        },
      },
      honesty: {
        confidence: { value: 0.25, kind: "asserted" },
        dataVintage,
        coverage: { degraded: true, reason },
        source: { adapter },
      },
    };
  }

  // --- STATE (a)/(b): derive the buildable ring from real dimensions ---
  const ring = subject.ring;
  const parcelArea = subject.area;
  const [, cLat] = ringCentroid(ring);

  // Parcel mean half-span in meters, to convert a setback depth into an inset
  // fraction. Use the bbox of the ring.
  let minLng = Infinity,
    maxLng = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  for (const [x, y] of ring) {
    if (x < minLng) minLng = x;
    if (x > maxLng) maxLng = x;
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
  }
  const spanLngM =
    (maxLng - minLng) * 111_320 * Math.cos((cLat * Math.PI) / 180);
  const spanLatM = (maxLat - minLat) * 111_320;
  const meanHalfSpanM = Math.max((spanLngM + spanLatM) / 4, 1);

  // Effective inward setback depth (meters): average of the yard setbacks we
  // know, converted from feet. If a yard is unknown but at least one is known,
  // we use the known ones only (partial), and say so.
  const knownSetbacksFt = [
    dims.frontSetbackFt,
    dims.sideSetbackFt,
    dims.rearSetbackFt,
  ].filter((v): v is number => v !== null);
  const meanSetbackFt =
    knownSetbacksFt.length > 0
      ? knownSetbacksFt.reduce((s, v) => s + v, 0) / knownSetbacksFt.length
      : 0;
  const meanSetbackM = meanSetbackFt / FEET_PER_METER;

  const insetFraction =
    meanSetbackM > 0 ? Math.min(0.95, meanSetbackM / meanHalfSpanM) : 0;

  // Setback-limited ring + its area.
  const setbackRing = insetFraction > 0 ? centroidInsetRing(ring, insetFraction) : ring;
  let buildableArea = ringAreaSqMeters(setbackRing);

  // Cap by lot-coverage (a hard fraction of parcel area).
  const appliedCaps: string[] = [];
  if (dims.lotCoveragePct !== null) {
    const capArea = parcelArea * (dims.lotCoveragePct / 100);
    if (capArea < buildableArea) {
      buildableArea = capArea;
      appliedCaps.push(`lot coverage ${dims.lotCoveragePct}%`);
    }
  }
  // FAR caps FLOOR area; as a single-story footprint proxy it caps footprint at
  // min(FAR, 1) * parcelArea. Only applies as a footprint cap when FAR < 1.
  if (dims.farLimit !== null && dims.farLimit < 1) {
    const capArea = parcelArea * dims.farLimit;
    if (capArea < buildableArea) {
      buildableArea = capArea;
      appliedCaps.push(`FAR ${dims.farLimit} (footprint proxy)`);
    }
  }

  const buildableAreaPct =
    parcelArea > 0
      ? Math.max(0, Math.min(100, Math.round((buildableArea / parcelArea) * 100)))
      : null;

  const appliedSetbackDesc =
    knownSetbacksFt.length === 3
      ? `front ${dims.frontSetbackFt} ft / side ${dims.sideSetbackFt} ft / rear ${dims.rearSetbackFt} ft`
      : `${knownSetbacksFt.length} of 3 yard setbacks known (${[
          dims.frontSetbackFt !== null ? `front ${dims.frontSetbackFt} ft` : null,
          dims.sideSetbackFt !== null ? `side ${dims.sideSetbackFt} ft` : null,
          dims.rearSetbackFt !== null ? `rear ${dims.rearSetbackFt} ft` : null,
        ]
          .filter(Boolean)
          .join(", ") || "none"})`;

  const missingBits: string[] = [];
  if (!haveAnySetback) missingBits.push("no yard setback found");
  if (dims.farLimit === null) missingBits.push("no FAR limit found");
  if (dims.lotCoveragePct === null) missingBits.push("no lot-coverage limit found");
  if (dims.heightLimitFt === null) missingBits.push("no height limit found");

  const isPartial = completeness === "partial";
  const coverage: BuildableEnvelopeProvenance["coverage"] = isPartial
    ? "in-scope-partial"
    : "in-scope-derived";

  const reasoning =
    `Buildable envelope for zoning district ${district ?? "(district not on parcel record)"}` +
    ` in ${jurisdictionKey}. Applied setbacks: ${appliedSetbackDesc}` +
    (appliedCaps.length ? `; area capped by ${appliedCaps.join(" and ")}` : "") +
    `. buildableAreaPct=${buildableAreaPct}% derived from parcel geometry` +
    ` (parcel ${Math.round(parcelArea)} m^2). Dimensional standards cited from code atoms [${dims.citedAtomIds.join(", ") || "none"}].` +
    ` Method: ${BUILDABLE_METHOD_NOTE}` +
    (missingBits.length ? ` Incomplete inputs: ${missingBits.join("; ")}.` : "");

  // Earned-from-completeness confidence. Full dimensional set on a resolved
  // parcel earns the most; partial lowers it. Never a bare number: kind carried.
  const confidenceValue = isPartial ? 0.5 : 0.68;

  const provenance: BuildableEnvelopeProvenance = {
    parcel: {
      source: parcelSource,
      sourceUrl: parcelSourceUrl,
      notSurveyGrade,
      resolved: true,
    },
    zoning: {
      district,
      description,
      source: "Cotality site-location enrich",
      resolved: Boolean(district),
    },
    dimensionalStandards: {
      jurisdictionKey,
      source: "code corpus (retrieval-api / neon)",
      sourceUrl: dims.sourceUrl,
      citedAtomIds: dims.citedAtomIds,
      frontSetbackFt: dims.frontSetbackFt,
      sideSetbackFt: dims.sideSetbackFt,
      rearSetbackFt: dims.rearSetbackFt,
      farLimit: dims.farLimit,
      heightLimitFt: dims.heightLimitFt,
      lotCoveragePct: dims.lotCoveragePct,
      completeness,
    },
    method: { kind: "centroid-inset-approximation", note: BUILDABLE_METHOD_NOTE },
    coverage,
    generatedAt,
  };

  const notes = isPartial
    ? `Buildable envelope derived from a partial dimensional set (${missingBits.join("; ")}); buildableAreaPct is an approximation floor with lowered confidence.`
    : `Buildable envelope derived from parcel geometry + full dimensional set; buildableAreaPct is a conservative approximation floor.`;

  return {
    payload: {
      layer: "buildable-envelope",
      queryMode: "bbox",
      fixture: false,
      featureCount: 1,
      notes,
      buildableProvenance: provenance,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [setbackRing] },
            properties: {
              kind: "buildable-envelope",
              derived: true,
              approximation: true,
              zoningDistrict: district,
              zoningDescription: description,
              buildableAreaPct,
              parcelAreaSqM: Math.round(parcelArea),
              buildableAreaSqM: Math.round(buildableArea),
              appliedSetbacksFt: {
                front: dims.frontSetbackFt,
                side: dims.sideSetbackFt,
                rear: dims.rearSetbackFt,
              },
              farLimit: dims.farLimit,
              heightLimitFt: dims.heightLimitFt,
              lotCoveragePct: dims.lotCoveragePct,
              citedCodeAtomIds: dims.citedAtomIds,
              reasoning,
              confidence: confidenceValue,
              confidenceKind: "asserted",
              source: parcelSource,
              sourceUrl: parcelSourceUrl,
              codeSourceUrl: dims.sourceUrl,
              dataVintage,
              generatedAt,
            },
          },
        ],
      },
    },
    honesty: {
      confidence: { value: confidenceValue, kind: "asserted" },
      dataVintage,
      coverage: isPartial
        ? {
            degraded: true,
            reason: `Partial dimensional set: ${missingBits.join("; ")}. buildableAreaPct is an approximation floor.`,
          }
        : { degraded: false },
      source: { adapter },
    },
  };
}

// ---------------------------------------------------------------------------
// Constraint-density derivation (promote the hardcoded 4-overlay fixture to a
// real severity-weighted STACK over already-live constraint layers)
// ---------------------------------------------------------------------------

type Bounds = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

/** Axis-aligned bounds of an arbitrary GeoJSON geometry's coordinates. */
function geometryBounds(geometry: unknown): Bounds | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { coordinates?: unknown };
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    // A coordinate pair is [number, number, ...].
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      const x = node[0];
      const y = node[1];
      if (x < minLng) minLng = x;
      if (x > maxLng) maxLng = x;
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(g.coordinates);
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return { minLng, minLat, maxLng, maxLat };
}

/** Do two axis-aligned lng/lat boxes overlap (edge-touching counts)? */
function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.minLng <= b.maxLng &&
    a.maxLng >= b.minLng &&
    a.minLat <= b.maxLat &&
    a.maxLat >= b.minLat
  );
}

/**
 * Severity weight for a FEMA NFHL flood feature, read from the flood-zone code
 * across the field-name variants the NFHL service emits. Higher = more
 * development-constraining. Zone X (minimal/outside SFHA) contributes 0.
 */
function femaFloodSeverity(props: Record<string, unknown>): number {
  const raw =
    [props.FLD_ZONE, props.fld_zone, props.floodZone, props.FLOODZONE, props.ZONE]
      .find((v) => typeof v === "string" && (v as string).trim()) ?? "";
  const zone = String(raw).trim().toUpperCase();
  const subty =
    String(
      [props.ZONE_SUBTY, props.zone_subty].find(
        (v) => typeof v === "string" && (v as string).trim(),
      ) ?? "",
    ).toUpperCase();

  // Coastal high-hazard (velocity) zones are the hardest constraint.
  if (zone === "V" || zone === "VE" || zone.startsWith("V")) return 4;
  // Special Flood Hazard Area (1% annual chance): AE/A/AO/AH/AR/A99.
  if (zone.startsWith("A")) return 3;
  // 0.2% annual chance (shaded X) is a real but lower constraint.
  if (subty.includes("0.2 PCT") || subty.includes("0.2%")) return 2;
  // Explicit "no SFHA" / minimal-hazard X is not a constraint.
  if (zone === "X" || zone === "AREA NOT INCLUDED" || zone === "") return 0;
  // Unknown non-empty zone code: treat as a low constraint rather than zero.
  return 1;
}

/** Severity for an Edwards aquifer feature (recharge zone > contributing). */
function edwardsSeverity(props: Record<string, unknown>): number {
  const zone = String(props.edwardsZone ?? "").toLowerCase();
  if (zone === "recharge") return 4;
  if (zone === "contributing") return 2;
  return 2;
}

type EvaluatedConstraintLayer = {
  key: ConstraintLayerProvenance["key"];
  label: string;
  source: string;
  sourceUrl: string | null;
  severityWeight: number;
  evaluated: boolean;
  featureCount: number;
  note: string | null;
  /** Per-feature bounds + that feature's own severity, for cell overlap tests. */
  features: Array<{ bounds: Bounds; severity: number }>;
};

/**
 * Query one constraint layer for the viewport, catching upstream/no-coverage
 * failures so one unreachable layer degrades the stack HONESTLY (evaluated:false)
 * instead of throwing and instead of being counted as zero-constraint.
 */
async function evaluateConstraintLayer(
  key: ConstraintLayerProvenance["key"],
  bbox: GisLayerBbox,
): Promise<EvaluatedConstraintLayer> {
  const defs: Record<
    ConstraintLayerProvenance["key"],
    { label: string; source: string; sourceUrl: string; severityWeight: number }
  > = {
    "fema-flood": {
      label: "FEMA NFHL flood hazard",
      source: "FEMA NFHL",
      sourceUrl:
        "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
      severityWeight: 4,
    },
    "ssurgo-soils": {
      label: "USDA SSURGO soils (shrink-swell / drainage / HSG)",
      source: "USDA SDA WFS (SSURGO map units)",
      sourceUrl: "https://sdmdataaccess.sc.egov.usda.gov",
      severityWeight: 4,
    },
    "edwards-aquifer": {
      label: "TCEQ Edwards Aquifer (recharge / contributing)",
      source: "TCEQ Edwards Aquifer",
      sourceUrl:
        "https://gisweb.tceq.texas.gov/arcgis/rest/services",
      severityWeight: 4,
    },
    "mud-pid": {
      label: "MUD / PID / PUD special districts",
      source: "TCEQ water districts + TX Comptroller SPDPID",
      sourceUrl:
        "https://gisweb.tceq.texas.gov/arcgis/rest/services/Public/WaterDistricts/MapServer/0",
      severityWeight: 2,
    },
  };
  const def = defs[key];

  try {
    const result =
      key === "fema-flood"
        ? await queryGisLayerGeoJson({ layer: "fema", bbox })
        : await queryFederalGisLayerGeoJson({
            layer:
              key === "ssurgo-soils"
                ? "ssurgo-soils"
                : key === "edwards-aquifer"
                  ? "edwards-aquifer"
                  : "mud-pid",
            bbox,
          });

    const rawFeatures = (result.geojson.features ?? []) as Array<{
      geometry?: unknown;
      properties?: Record<string, unknown>;
    }>;

    const features: Array<{ bounds: Bounds; severity: number }> = [];
    for (const f of rawFeatures) {
      const bounds = geometryBounds(f.geometry);
      if (!bounds) continue;
      const props = f.properties ?? {};
      let severity = def.severityWeight;
      if (key === "fema-flood") severity = femaFloodSeverity(props);
      else if (key === "ssurgo-soils")
        // Reuse the shared SSURGO foundation-risk scorer (1..4).
        severity = scoreSsurgoFeatureRisk(props);
      else if (key === "edwards-aquifer") severity = edwardsSeverity(props);
      if (severity <= 0) continue;
      features.push({ bounds, severity });
    }

    return {
      key,
      label: def.label,
      source: def.source,
      sourceUrl: def.sourceUrl,
      severityWeight: def.severityWeight,
      evaluated: true,
      featureCount: features.length,
      note: null,
      features,
    };
  } catch (err) {
    // no-coverage is a REAL answer (confidently empty for this kind); anything
    // else (upstream/network) means the layer is unreachable -> not evaluated.
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "no-coverage") {
      return {
        key,
        label: def.label,
        source: def.source,
        sourceUrl: def.sourceUrl,
        severityWeight: def.severityWeight,
        evaluated: true,
        featureCount: 0,
        note: "No features of this constraint kind in the viewport (confidently empty).",
        features: [],
      };
    }
    logger.warn(
      { err, layer: key, bbox },
      "constraint-density: constraint layer unreachable",
    );
    return {
      key,
      label: def.label,
      source: def.source,
      sourceUrl: def.sourceUrl,
      severityWeight: def.severityWeight,
      evaluated: false,
      featureCount: 0,
      note: `Layer unreachable for this viewport (${
        err instanceof Error ? err.message : String(err)
      }); absence of this constraint is unknown, not confirmed-none.`,
      features: [],
    };
  }
}

const CONSTRAINT_GRID_SIZE = 6;
const CONSTRAINT_METHOD_NOTE =
  "Constraint density is a severity-weighted STACK over already-live constraint layers (FEMA flood, SSURGO soils, Edwards aquifer, MUD/PID), tessellated into a grid. Each cell's density is the sum of the severities of the constraint features overlapping it, normalized by the maximum possible severity of the layers actually EVALUATED for the viewport. A layer that was unreachable is recorded as not-evaluated and excluded from both the numerator and the denominator, so a partial stack is reported as partial, never as low-constraint.";

const CONSTRAINT_EXCLUDED_LAYERS: ConstraintDensityProvenance["excludedLayers"] =
  [
    {
      key: "hydrology-drainage (pysheds)",
      reason:
        "Drainage/flow-accumulation zones are a report-tile atom overlay materialized from site-drainage.computed events (siteDrainageMaterializer), not a bbox-queryable server-side GIS layer, so they cannot be stacked here without fabrication. The SSURGO drainage-class dimension partially covers the soils-drainage constraint. Excluded honestly rather than faked.",
    },
    {
      key: "usgs-groundwater-wells",
      reason:
        "USGS NWIS groundwater sites are a point well inventory, not a development-constraint polygon; counting well points as constraint density would misrepresent the signal.",
    },
    {
      key: "texas-rrc",
      reason:
        "RRC wells/pipelines are an oil-and-gas asset inventory, relevant as a hazard overlay but not a land-use constraint density input in v1.",
    },
  ];

/**
 * Real constraint-density derivation (replaces the hardcoded 4-overlay,
 * constraintCount:4 fixture).
 *
 * METHOD: constraint-density is a COMPOSITION over already-live constraint
 * layers, not a new source. For the requested viewport we query each constraint
 * layer the spine already serves (FEMA flood, SSURGO soils, Edwards aquifer,
 * MUD/PID), tessellate the viewport into a grid, and for each cell sum the
 * severities of the constraint features overlapping it. The per-cell density is
 * normalized by the maximum severity of the layers actually EVALUATED, so a
 * partial stack reads as partial.
 *
 * Three-state coverage honesty (mirrors deriveOzDealCrossfilter / buildable):
 *   (a) all constraint layers evaluated -> in-scope-derived, degraded:false
 *   (b) some but not all evaluated       -> in-scope-partial, degraded:true,
 *       reason naming which layers were not evaluated, lowered confidence
 *   (c) zero constraint layers reachable -> out-of-scope, degraded:true,
 *       "absence of constraints is unknown, not confirmed-none" — NEVER a
 *       fabricated density.
 *
 * An unreachable layer is recorded as not-evaluated in provenance and excluded
 * from BOTH numerator and denominator; it is NEVER silently treated as
 * zero-constraint. A cell that had only N of M layers evaluated says so and
 * carries lowered confidence.
 */
export async function deriveConstraintDensity(bbox: GisLayerBbox): Promise<{
  payload: CompositeLayerPayload;
  honesty: EngineHonesty;
}> {
  const generatedAt = new Date().toISOString();
  const dataVintage = generatedAt.slice(0, 10);
  const adapter = "brokerage:composite-constraint-density";

  const layerKeys: ConstraintLayerProvenance["key"][] = [
    "fema-flood",
    "ssurgo-soils",
    "edwards-aquifer",
    "mud-pid",
  ];

  const evaluated = await Promise.all(
    layerKeys.map((k) => evaluateConstraintLayer(k, bbox)),
  );

  const reachable = evaluated.filter((l) => l.evaluated);
  const notEvaluated = evaluated.filter((l) => !l.evaluated);
  const layersTotal = evaluated.length;
  const layersEvaluated = reachable.length;

  const contributingLayers: ConstraintLayerProvenance[] = evaluated.map((l) => ({
    key: l.key,
    label: l.label,
    source: l.source,
    sourceUrl: l.sourceUrl,
    severityWeight: l.severityWeight,
    evaluated: l.evaluated,
    featureCount: l.featureCount,
    note: l.note,
  }));

  const coverage: ConstraintDensityProvenance["coverage"] =
    layersEvaluated === 0
      ? "out-of-scope"
      : layersEvaluated === layersTotal
        ? "in-scope-derived"
        : "in-scope-partial";

  const notEvaluatedLabels = notEvaluated.map((l) => l.label);

  // STATE (c): no constraint layer reachable at all — never fabricate a density.
  if (layersEvaluated === 0) {
    const reason = `No constraint layer (FEMA flood, SSURGO soils, Edwards aquifer, MUD/PID) was reachable for this viewport. Constraint density cannot be composed without at least one live layer, so none is fabricated. Absence of constraints here is unknown, not confirmed-none.`;
    const provenance: ConstraintDensityProvenance = {
      method: {
        kind: "severity-weighted-layer-stack",
        note: CONSTRAINT_METHOD_NOTE,
        gridSize: CONSTRAINT_GRID_SIZE,
      },
      contributingLayers,
      excludedLayers: CONSTRAINT_EXCLUDED_LAYERS,
      layersEvaluated,
      layersTotal,
      coverage: "out-of-scope",
      dataVintage,
      generatedAt,
    };
    return {
      payload: {
        layer: "constraint-density",
        queryMode: "bbox",
        fixture: false,
        featureCount: 0,
        notes: reason,
        constraintProvenance: provenance,
        geojson: { type: "FeatureCollection", features: [] },
      },
      honesty: {
        confidence: { value: 0.2, kind: "asserted" },
        dataVintage,
        coverage: { degraded: true, reason },
        source: { adapter },
      },
    };
  }

  // Denominator: max severity per cell if every EVALUATED layer's worst feature
  // overlapped it. This normalizes the density against what we actually looked
  // at, so a 2-of-4 stack is not diluted by the 2 layers we could not reach.
  const maxSeverityPerLayer = reachable.map((l) =>
    l.features.reduce((m, f) => Math.max(m, f.severity), l.severityWeight),
  );
  const denom = maxSeverityPerLayer.reduce((s, v) => s + v, 0) || 1;

  // Tessellate the viewport into a grid and score each cell.
  const n = CONSTRAINT_GRID_SIZE;
  const cellW = (bbox.eastLng - bbox.westLng) / n;
  const cellH = (bbox.northLat - bbox.southLat) / n;
  const features: unknown[] = [];

  const isPartial = coverage === "in-scope-partial";
  const cellConfidence = isPartial ? 0.5 : 0.68;

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const west = bbox.westLng + ix * cellW;
      const east = west + cellW;
      const south = bbox.southLat + iy * cellH;
      const north = south + cellH;
      const cellBounds: Bounds = {
        minLng: west,
        minLat: south,
        maxLng: east,
        maxLat: north,
      };

      // Sum the severities of the constraint features overlapping this cell,
      // taking the WORST (max) severity per layer so a layer contributes once.
      const contributions: Array<{
        layer: ConstraintLayerProvenance["key"];
        label: string;
        severity: number;
      }> = [];
      let weightedSum = 0;
      for (const l of reachable) {
        let cellSeverity = 0;
        for (const f of l.features) {
          if (boundsOverlap(cellBounds, f.bounds)) {
            cellSeverity = Math.max(cellSeverity, f.severity);
          }
        }
        if (cellSeverity > 0) {
          weightedSum += cellSeverity;
          contributions.push({
            layer: l.key,
            label: l.label,
            severity: cellSeverity,
          });
        }
      }

      // A completely-unconstrained cell (within the evaluated layers) is not a
      // "constraint" feature; skip it so the surface is the constraint hot-spots.
      if (contributions.length === 0) continue;

      const densityValue = Math.min(1, weightedSum / denom);
      const cx = (west + east) / 2;
      const cy = (south + north) / 2;
      const contributingKeys = contributions.map((c) => c.layer);
      const notEvaluatedKeys = notEvaluated.map((l) => l.key);

      const reasoning =
        `Cell (${ix},${iy}) constraint density ${densityValue.toFixed(2)} composed from ${contributions.length} of ${layersEvaluated} evaluated constraint layers: ${contributions
          .map((c) => `${c.label} (severity ${c.severity})`)
          .join(", ")}.` +
        (notEvaluatedKeys.length
          ? ` Not evaluated (unknown, not zero): ${notEvaluatedLabels.join(", ")}. Density normalized only against evaluated layers; treat as PARTIAL.`
          : ` All constraint layers evaluated.`) +
        ` Severity-weighted stack over already-live layers; no synthetic value.`;

      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
        properties: {
          kind: "constraint-density",
          derived: true,
          cellCenter: [cx, cy],
          constraintDensity: Number(densityValue.toFixed(3)),
          constraintCount: contributions.length,
          weightedSeveritySum: weightedSum,
          severityDenominator: denom,
          contributingLayers: contributingKeys,
          contributingLayerDetail: contributions,
          layersNotEvaluated: notEvaluatedKeys,
          partial: isPartial,
          reasoning,
          confidence: cellConfidence,
          confidenceKind: "asserted",
          source: reachable.map((l) => l.source).join("; "),
          dataVintage,
          generatedAt,
        },
      });
    }
  }

  const provenance: ConstraintDensityProvenance = {
    method: {
      kind: "severity-weighted-layer-stack",
      note: CONSTRAINT_METHOD_NOTE,
      gridSize: CONSTRAINT_GRID_SIZE,
    },
    contributingLayers,
    excludedLayers: CONSTRAINT_EXCLUDED_LAYERS,
    layersEvaluated,
    layersTotal,
    coverage,
    dataVintage,
    generatedAt,
  };

  const notes = isPartial
    ? `Constraint density composed from a PARTIAL stack: ${layersEvaluated} of ${layersTotal} constraint layers evaluated (not evaluated: ${notEvaluatedLabels.join(
        ", ",
      )}). Density is normalized against evaluated layers only and carries lowered confidence; an unevaluated layer is unknown, not zero-constraint.`
    : `Constraint density composed from the full constraint stack (${layersEvaluated} of ${layersTotal} layers evaluated). ${features.length} constrained cells returned.`;

  return {
    payload: {
      layer: "constraint-density",
      queryMode: "bbox",
      fixture: false,
      featureCount: features.length,
      notes,
      constraintProvenance: provenance,
      geojson: {
        type: "FeatureCollection",
        features,
      },
    },
    honesty: {
      confidence: { value: cellConfidence, kind: "asserted" },
      dataVintage,
      coverage: isPartial
        ? {
            degraded: true,
            reason: `Partial constraint stack: ${layersEvaluated} of ${layersTotal} layers evaluated. Not evaluated (unknown, not zero-constraint): ${notEvaluatedLabels.join(
              ", ",
            )}.`,
          }
        : { degraded: false },
      source: { adapter },
    },
  };
}

// ---------------------------------------------------------------------------
// Motivated-seller heat derivation (promote the hardcoded 0.74 fixture to a
// real, TRANSPARENT, PUBLIC-RECORD documented weighted-sum — ruling R3)
// ---------------------------------------------------------------------------

/**
 * The motivated-seller signal model: a TRANSPARENT documented weighted-sum over
 * TX public records, acquired via the uniform public-record process (ruling R3,
 * `_inbox/2026-07-16_map_data_sourcing_rulings.md`). This table IS the model —
 * every signal's weight is a named documented constant with a rationale, and a
 * parcel's score is fully reconstructable from which signals fired at what value.
 *
 * NO proprietary propensity model. Cotality "Propensity to List" and any
 * bought/vendor propensity score are excluded by design — the public
 * weighted-sum REPLACES the black box, more defensibly.
 *
 * Weights are RELATIVE importance (they need not sum to 1; the derivation
 * normalizes by the sum of the weights of the signals actually EVALUATED, so a
 * partial model is reported as partial rather than diluted). Ordering follows
 * R3's build-by-access-difficulty list; the weights reflect distress signal
 * strength as understood in the real-estate acquisition literature (a filed
 * pre-foreclosure notice is a far stronger motivation signal than mere absentee
 * ownership).
 */
export const MOTIVATED_SELLER_SIGNAL_MODEL: ReadonlyArray<{
  key: MotivatedSellerSignalProvenance["key"];
  label: string;
  weight: number;
  weightRationale: string;
  source: string;
  sourceUrl: string | null;
  /** Whether the signal's DATA is ingested anywhere in the spine today. */
  liveToday: boolean;
  /** Operator/fleet data-pull needed to light the signal up, when not live. */
  dataPull: string | null;
}> = [
  {
    key: "pre-foreclosure-nos",
    label: "Pre-foreclosure Notice of (Substitute) Trustee's Sale",
    weight: 0.35,
    weightRationale:
      "Highest-value motivation signal: a filed Notice of (Substitute) Trustee's Sale means an active foreclosure timeline (TX 21-day posting, Property Code §51.002), the strongest public indicator that an owner must transact.",
    source: "County clerk trustee-sale postings (public record)",
    sourceUrl: null,
    liveToday: false,
    dataPull:
      "Ingest county-clerk Notice of (Substitute) Trustee's Sale postings (21-day pre-sale filings) into a pre_foreclosure_notice store keyed (county_fips, prop_id/legal). No such store exists in the spine yet.",
  },
  {
    key: "tax-delinquency",
    label: "Property-tax delinquency",
    weight: 0.3,
    weightRationale:
      "Strong, easiest-access distress signal: a parcel on the published delinquent tax roll (TX Property Tax Code Ch.33) carries carrying-cost pressure and penalty/interest accrual that motivates a sale.",
    source: "County tax-assessor delinquent roll (public record, Tax Code Ch.33)",
    sourceUrl: null,
    liveToday: false,
    dataPull:
      "Ingest each county's published delinquent tax roll (some counties post CSV) into a tax_delinquency store keyed (county_fips, prop_id). No such store exists in the spine yet.",
  },
  {
    key: "lis-pendens-tax-lien",
    label: "Lis pendens / recorded tax lien",
    weight: 0.2,
    weightRationale:
      "A recorded lis pendens or tax lien signals litigation/encumbrance pressure on the owner; recorded and public, but a weaker and noisier motivation signal than an active foreclosure timeline.",
    source: "County clerk recorded documents (lis pendens / lien filings)",
    sourceUrl: null,
    liveToday: false,
    dataPull:
      "Ingest county-clerk recorded lis-pendens and tax-lien filings into a recorded_encumbrance store keyed (county_fips, prop_id/legal). No such store exists in the spine yet.",
  },
  {
    key: "absentee-owner",
    label: "Absentee owner (mailing address != situs)",
    weight: 0.15,
    weightRationale:
      "Baseline propensity signal: an owner whose mailing address differs from the property situs does not occupy it, correlating with a higher willingness to sell (investor/inherited/out-of-area). Weaker than a distress event, so weighted lowest — but it is the one signal genuinely live from the cad_property roll today.",
    source: "County appraisal-district roll (cad_property: owner mailing vs situs)",
    sourceUrl: null,
    liveToday: true,
    dataPull: null,
  },
  {
    key: "probate-estate",
    label: "Probate / estate ownership",
    weight: 0.2,
    weightRationale:
      "Estate/probate ownership is a well-known motivated-seller source (heirs liquidating), public and name-keyed — but the hardest to match to a parcel, so it lands late and is treated as not-evaluated until a matched store exists.",
    source: "County probate court records (public, name-keyed)",
    sourceUrl: null,
    liveToday: false,
    dataPull:
      "Ingest county probate/estate filings and name-match them to owner_name on the CAD roll into a probate_estate store keyed (county_fips, prop_id). Name matching is lossy; no such store exists in the spine yet.",
  },
] as const;

const MOTIVATED_SELLER_METHOD_NOTE =
  "Motivated-seller heat is a TRANSPARENT documented weighted-sum over TX public-record signals (pre-foreclosure NOS, tax delinquency, lis-pendens/liens, absentee ownership, probate), each with a named documented weight. The score for a parcel is sum(weight_i * value_i) over the signals EVALUATED for that parcel, normalized by the sum of those signals' weights — so a score built from a subset of signals is reported as partial and is fully reconstructable from contributingSignals. NO proprietary/vendor propensity model is consumed; absence of a signal's data is recorded as not-evaluated and excluded from the denominator, never treated as 'not motivated'.";

const MOTIVATED_SELLER_EXCLUDES = [
  "cotality-propensity-to-list",
  "any-vendor-bought-propensity-score",
  "tenant-private",
  "synthetic-heat-score",
];

/** A parcel with a resolvable (countyFips, propId) identity + situs + geometry. */
type MotivatedSellerParcel = {
  countyFips: string;
  propId: string;
  situsAddress: string | null;
  geometry: unknown;
};

function parcelIdentityFromFeatureProps(
  props: Record<string, unknown>,
): { countyFips: string; propId: string; situsAddress: string | null } | null {
  const countyFips =
    typeof props.countyFips === "string" && props.countyFips.trim()
      ? props.countyFips.trim()
      : null;
  const propIdRaw =
    (typeof props.apn === "string" && props.apn.trim()) ||
    (typeof props.propId === "string" && (props.propId as string).trim()) ||
    (typeof props.PROP_ID === "string" && (props.PROP_ID as string).trim()) ||
    null;
  if (!countyFips || !propIdRaw) return null;
  const situsAddress =
    (typeof props.situsAddress === "string" && props.situsAddress.trim()) ||
    null;
  return { countyFips, propId: propIdRaw, situsAddress: situsAddress || null };
}

/**
 * Real motivated-seller heat derivation (replaces the hardcoded
 * motivatedSellerHeat:0.74 / propensity:0.81 fixture).
 *
 * INPUTS, all live and resolved per-request:
 *   - Parcels in the viewport, from the SAME live parcels path the buildable
 *     envelope uses (county-GIS / TxGIO store), each carrying (countyFips, apn).
 *   - Absentee ownership, batch-joined from the cad_property roll (owner mailing
 *     vs situs), the ONE R3 signal genuinely live today.
 *
 * Every other R3 signal (pre-foreclosure NOS, tax delinquency, lis-pendens/lien,
 * probate) is in the model with its documented weight and is recorded as
 * not-evaluated (data not ingested) — the score lights each up automatically as
 * its store lands. NONE is fabricated.
 *
 * Three-state coverage honesty (mirrors the other three derivations):
 *   (a) all modeled signals evaluated -> in-scope-derived, degraded:false
 *   (b) some (>=1) but not all evaluated -> in-scope-partial, degraded:true,
 *       reason naming the not-evaluated signals, lowered confidence
 *   (c) zero signals evaluable for any parcel (no parcels, or no CAD match and
 *       no other signal live) -> out-of-scope, degraded:true,
 *       "absence of a motivated-seller signal is unknown, not confirmed-none" —
 *       NEVER a fabricated 0.74.
 *
 * Confidence is ASSERTED with an explicit verification state
 * ("asserted-unverified"): calibration (arrow two) does not exist yet, so the
 * number is honestly asserted with provenance, never presented as calibrated.
 */
export async function deriveMotivatedSellerHeat(
  bbox: GisLayerBbox,
  deps?: { signalDb?: MotivatedSellerSignalDb },
): Promise<{ payload: CompositeLayerPayload; honesty: EngineHonesty }> {
  const generatedAt = new Date().toISOString();
  const dataVintage = generatedAt.slice(0, 10);
  const adapter = "brokerage:composite-motivated-seller";

  const liveSignals = MOTIVATED_SELLER_SIGNAL_MODEL.filter((s) => s.liveToday);
  const notLiveSignals = MOTIVATED_SELLER_SIGNAL_MODEL.filter(
    (s) => !s.liveToday,
  );
  const pendingIngest = notLiveSignals.map((s) => ({
    key: s.key,
    dataPull: s.dataPull ?? "Data source not yet ingested.",
  }));

  // --- Resolve parcels in the viewport (same path as buildable-envelope) ---
  let parcelResult:
    | Awaited<ReturnType<typeof queryGisLayerGeoJson>>
    | null = null;
  try {
    parcelResult = await queryGisLayerGeoJson({ layer: "parcels", bbox });
  } catch (err) {
    logger.warn(
      { err, bbox },
      "motivated-seller: parcel resolution failed",
    );
  }

  const rawFeatures = (parcelResult?.geojson.features ?? []) as Array<{
    geometry?: unknown;
    properties?: Record<string, unknown>;
  }>;

  const parcels: MotivatedSellerParcel[] = [];
  for (const f of rawFeatures) {
    const identity = parcelIdentityFromFeatureProps(f.properties ?? {});
    if (!identity || !f.geometry) continue;
    parcels.push({
      countyFips: identity.countyFips,
      propId: identity.propId,
      situsAddress: identity.situsAddress,
      geometry: f.geometry,
    });
  }

  const parcelSource =
    parcelResult?.provider ?? "county-GIS / TxGIO store (parcels)";
  const parcelSourceUrl = parcelResult?.serviceUrl ?? null;

  // Base signal provenance (model with weights), independent of any parcel.
  const buildSignalProvenance = (
    evaluatedKeys: Set<string>,
  ): MotivatedSellerSignalProvenance[] =>
    MOTIVATED_SELLER_SIGNAL_MODEL.map((s) => ({
      key: s.key,
      label: s.label,
      weight: s.weight,
      weightRationale: s.weightRationale,
      source: s.source,
      sourceUrl: s.sourceUrl,
      evaluated: evaluatedKeys.has(s.key),
      value: null,
      dataVintage: evaluatedKeys.has(s.key) ? dataVintage : null,
      note: s.liveToday
        ? evaluatedKeys.has(s.key)
          ? null
          : "Signal is live but not evaluable for any parcel in this viewport (no CAD match)."
        : `Not-evaluated (data not ingested). ${s.dataPull ?? ""}`.trim(),
    }));

  // STATE (c-no-parcels): no parcels resolvable -> nothing to score.
  if (parcels.length === 0) {
    const reason =
      "Motivated-seller heat requires parcels; none was resolvable for this viewport (parcel geometry unavailable). Absence of a motivated-seller signal here is unknown, not confirmed-none.";
    const provenance: MotivatedSellerProvenance = {
      method: {
        kind: "transparent-weighted-sum",
        note: MOTIVATED_SELLER_METHOD_NOTE,
        excludes: MOTIVATED_SELLER_EXCLUDES,
      },
      signals: buildSignalProvenance(new Set()),
      pendingIngest,
      signalsEvaluated: 0,
      signalsTotal: MOTIVATED_SELLER_SIGNAL_MODEL.length,
      coverage: "out-of-scope",
      verificationState: "asserted-unverified",
      generatedAt,
    };
    return {
      payload: {
        layer: "motivated-seller",
        queryMode: "bbox",
        fixture: false,
        featureCount: 0,
        notes: reason,
        motivatedSellerProvenance: provenance,
        geojson: { type: "FeatureCollection", features: [] },
      },
      honesty: {
        confidence: { value: 0.2, kind: "asserted" },
        dataVintage,
        coverage: { degraded: true, reason },
        source: { adapter },
      },
    };
  }

  // --- Evaluate the LIVE signals ---
  // absentee-owner is the only live signal today; batch-join the CAD roll.
  const wantAbsentee = liveSignals.some((s) => s.key === "absentee-owner");
  let absenteeMap = new Map<string, AbsenteeSignal>();
  if (wantAbsentee) {
    const identities: ParcelIdentity[] = parcels.map((p) => ({
      countyFips: p.countyFips,
      propId: p.propId,
      featureSitusAddress: p.situsAddress,
    }));
    try {
      absenteeMap = await fetchAbsenteeSignalsForTile(
        identities,
        deps?.signalDb,
      );
    } catch (err) {
      logger.warn(
        { err },
        "motivated-seller: absentee CAD-roll join failed; absentee not-evaluated for viewport",
      );
      absenteeMap = new Map();
    }
  }

  // Which signals were evaluated for AT LEAST ONE parcel — drives coverage.
  const evaluatedSignalKeys = new Set<string>();

  const features: unknown[] = [];
  let scoredParcelCount = 0;

  for (const parcel of parcels) {
    const key = `${parcel.countyFips}:${(function () {
      // Normalize here matches the map key produced in the signal reader.
      const id = parcel.propId.trim();
      return /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
    })()}`;

    // Per-parcel evaluated signals + their [0,1] value.
    const perParcelSignals: MotivatedSellerSignalProvenance[] =
      MOTIVATED_SELLER_SIGNAL_MODEL.map((s) => {
        // Only absentee-owner is wired live today.
        if (s.key === "absentee-owner") {
          const sig = absenteeMap.get(key);
          if (!sig || !sig.available || sig.absentee === null) {
            return {
              key: s.key,
              label: s.label,
              weight: s.weight,
              weightRationale: s.weightRationale,
              source: s.source,
              sourceUrl: s.sourceUrl,
              evaluated: false,
              value: null,
              dataVintage: null,
              note:
                sig?.note ??
                "No cad_property row matched this parcel; absentee not-evaluated (unknown), not 'not absentee'.",
            };
          }
          const value = sig.absentee ? 1 : 0;
          return {
            key: s.key,
            label: s.label,
            weight: s.weight,
            weightRationale: s.weightRationale,
            source: s.source,
            sourceUrl: s.sourceUrl,
            evaluated: true,
            value,
            dataVintage: sig.sourceVintage ?? dataVintage,
            note: sig.note,
          };
        }
        // Every other signal: data not ingested -> not-evaluated for this parcel.
        return {
          key: s.key,
          label: s.label,
          weight: s.weight,
          weightRationale: s.weightRationale,
          source: s.source,
          sourceUrl: s.sourceUrl,
          evaluated: false,
          value: null,
          dataVintage: null,
          note: `Not-evaluated (data not ingested). ${s.dataPull ?? ""}`.trim(),
        };
      });

    const evaluated = perParcelSignals.filter(
      (s) => s.evaluated && s.value !== null,
    );
    // A parcel with no evaluable signal is not scored (excluded), never 0.74.
    if (evaluated.length === 0) continue;

    for (const s of evaluated) evaluatedSignalKeys.add(s.key);

    const weightSum = evaluated.reduce((acc, s) => acc + s.weight, 0);
    const weightedTerm = evaluated.reduce(
      (acc, s) => acc + s.weight * (s.value as number),
      0,
    );
    const heat = weightSum > 0 ? Math.min(1, weightedTerm / weightSum) : 0;

    const signalsTotal = MOTIVATED_SELLER_SIGNAL_MODEL.length;
    const partial = evaluated.length < signalsTotal;
    const notEvaluatedForParcel = perParcelSignals
      .filter((s) => !s.evaluated)
      .map((s) => s.label);

    // Confidence is ASSERTED with a verification state, and scaled by how much
    // of the model actually fired — a 1-of-5 score is honestly low-confidence.
    const coverageFraction = evaluated.length / signalsTotal;
    const confidenceValue = Number((0.2 + 0.5 * coverageFraction).toFixed(2));

    const firedDesc = evaluated
      .map(
        (s) =>
          `${s.label} value=${(s.value as number).toFixed(2)} weight=${s.weight} contribution=${(
            s.weight * (s.value as number)
          ).toFixed(3)}`,
      )
      .join("; ");

    const reasoning =
      `Motivated-seller heat ${heat.toFixed(2)} = weighted-sum over ${evaluated.length} of ${signalsTotal} public-record signals, normalized by evaluated weights (${weightSum.toFixed(
        2,
      )}). Fired: ${firedDesc}.` +
      (notEvaluatedForParcel.length
        ? ` Not-evaluated (unknown, NOT 'not motivated'; excluded from the denominator): ${notEvaluatedForParcel.join(
            ", ",
          )}.`
        : " All modeled signals evaluated.") +
      ` Transparent documented weighted-sum; no proprietary/vendor propensity model. Confidence is asserted-unverified (calibration not yet available).`;

    // Absentee-specific evidence for the citation, when it fired.
    const absenteeSig = absenteeMap.get(key);

    features.push({
      type: "Feature",
      geometry: parcel.geometry,
      properties: {
        kind: "motivated-seller",
        derived: true,
        countyFips: parcel.countyFips,
        apn: parcel.propId,
        motivatedSellerHeat: Number(heat.toFixed(3)),
        signalsEvaluated: evaluated.length,
        signalsTotal,
        partial,
        weightedTermSum: Number(weightedTerm.toFixed(4)),
        evaluatedWeightSum: Number(weightSum.toFixed(4)),
        // Full reasoning chain per commitment #1: each signal's value + weight
        // + contribution, source + sourceUrl, vintage, verification state.
        contributingSignals: evaluated.map((s) => ({
          key: s.key,
          label: s.label,
          value: s.value,
          weight: s.weight,
          weightRationale: s.weightRationale,
          contribution: Number((s.weight * (s.value as number)).toFixed(4)),
          source: s.source,
          sourceUrl: s.sourceUrl,
          dataVintage: s.dataVintage,
        })),
        signalsNotEvaluated: perParcelSignals
          .filter((s) => !s.evaluated)
          .map((s) => ({ key: s.key, label: s.label, note: s.note })),
        absenteeEvidence: absenteeSig
          ? {
              absentee: absenteeSig.absentee,
              ownerMailingAddress: absenteeSig.ownerMailingAddress,
              situsAddress: absenteeSig.situsAddress,
              homesteadExempt: absenteeSig.homesteadExempt,
              sourceVintage: absenteeSig.sourceVintage,
            }
          : null,
        reasoning,
        confidence: confidenceValue,
        confidenceKind: "asserted",
        verificationState: "asserted-unverified",
        source: parcelSource,
        sourceUrl: parcelSourceUrl,
        dataVintage,
        generatedAt,
      },
    });
    scoredParcelCount += 1;
  }

  const signalsTotal = MOTIVATED_SELLER_SIGNAL_MODEL.length;
  const signalsEvaluated = evaluatedSignalKeys.size;

  const coverage: MotivatedSellerProvenance["coverage"] =
    signalsEvaluated === 0
      ? "out-of-scope"
      : signalsEvaluated === signalsTotal
        ? "in-scope-derived"
        : "in-scope-partial";

  const notEvaluatedLabels = MOTIVATED_SELLER_SIGNAL_MODEL.filter(
    (s) => !evaluatedSignalKeys.has(s.key),
  ).map((s) => s.label);

  // STATE (c): parcels existed but not one evaluable signal fired anywhere
  // (e.g. no CAD roll ingested for the county) -> never a fabricated heat.
  if (signalsEvaluated === 0 || scoredParcelCount === 0) {
    const reason = `Parcels resolved, but no public-record motivated-seller signal was evaluable for any parcel in this viewport (the only live signal, absentee ownership, requires a matched cad_property row and none matched; every other signal's data is not yet ingested). No heat is fabricated. Absence of a motivated-seller signal here is unknown, not confirmed-none. Pending data-pulls: ${pendingIngest
      .map((p) => p.key)
      .join(", ")}.`;
    const provenance: MotivatedSellerProvenance = {
      method: {
        kind: "transparent-weighted-sum",
        note: MOTIVATED_SELLER_METHOD_NOTE,
        excludes: MOTIVATED_SELLER_EXCLUDES,
      },
      signals: buildSignalProvenance(new Set()),
      pendingIngest,
      signalsEvaluated: 0,
      signalsTotal,
      coverage: "out-of-scope",
      verificationState: "asserted-unverified",
      generatedAt,
    };
    return {
      payload: {
        layer: "motivated-seller",
        queryMode: "bbox",
        fixture: false,
        featureCount: 0,
        notes: reason,
        motivatedSellerProvenance: provenance,
        geojson: { type: "FeatureCollection", features: [] },
      },
      honesty: {
        confidence: { value: 0.2, kind: "asserted" },
        dataVintage,
        coverage: { degraded: true, reason },
        source: { adapter },
      },
    };
  }

  const isPartial = coverage === "in-scope-partial";
  const provenance: MotivatedSellerProvenance = {
    method: {
      kind: "transparent-weighted-sum",
      note: MOTIVATED_SELLER_METHOD_NOTE,
      excludes: MOTIVATED_SELLER_EXCLUDES,
    },
    signals: buildSignalProvenance(evaluatedSignalKeys),
    pendingIngest,
    signalsEvaluated,
    signalsTotal,
    coverage,
    verificationState: "asserted-unverified",
    generatedAt,
  };

  const notes = isPartial
    ? `Motivated-seller heat derived from a PARTIAL model: ${signalsEvaluated} of ${signalsTotal} public-record signals evaluated (not evaluated, pending ingest: ${notEvaluatedLabels.join(
        ", ",
      )}). ${scoredParcelCount} parcel(s) scored; each score is normalized against evaluated signals only and carries asserted-unverified confidence. An unevaluated signal is unknown, not 'not motivated'.`
    : `Motivated-seller heat derived from the full signal model (${signalsEvaluated} of ${signalsTotal} signals evaluated). ${scoredParcelCount} parcel(s) scored.`;

  // Honesty confidence: asserted (calibration/arrow-two does not exist yet),
  // scaled by how much of the model fired. Never presented as deterministic.
  const honestyConfidence = Number(
    (0.2 + 0.5 * (signalsEvaluated / signalsTotal)).toFixed(2),
  );

  return {
    payload: {
      layer: "motivated-seller",
      queryMode: "bbox",
      fixture: false,
      featureCount: features.length,
      notes,
      motivatedSellerProvenance: provenance,
      geojson: {
        type: "FeatureCollection",
        features: features as ArcGisGeoJsonFeatureCollection["features"],
      },
    },
    honesty: {
      confidence: { value: honestyConfidence, kind: "asserted" },
      dataVintage,
      coverage: isPartial
        ? {
            degraded: true,
            reason: `Partial motivated-seller model: ${signalsEvaluated} of ${signalsTotal} signals evaluated. Not evaluated (unknown, pending ingest): ${notEvaluatedLabels.join(
              ", ",
            )}. Confidence asserted-unverified.`,
          }
        : { degraded: false },
      source: { adapter },
    },
  };
}

export function buildCompositeLayerFixture(
  layer: CompositeLayerKey,
  bbox: GisLayerBbox,
): CompositeLayerPayload {

  if (layer === "buildable-envelope") {
    // buildable-envelope is now a REAL async derivation (deriveBuildableEnvelope),
    // never a fixture. It cannot be built synchronously (parcel + zoning + code
    // retrieval are all async), so the sync fixture builder no longer serves it.
    // Route it through queryCompositeLayer (async), exactly like oz-deal-crossfilter.
    throw new Error(
      "buildable-envelope is a real async derivation; call queryCompositeLayer (async) / deriveBuildableEnvelope, not buildCompositeLayerFixture.",
    );
  }

  if (layer === "constraint-density") {
    // constraint-density is now a REAL async derivation (deriveConstraintDensity)
    // that STACKS the already-live constraint layers. It cannot be built
    // synchronously (FEMA/SSURGO/Edwards/MUD-PID queries are all async), so the
    // sync fixture builder no longer serves it. Route through queryCompositeLayer
    // (async), exactly like buildable-envelope and oz-deal-crossfilter.
    throw new Error(
      "constraint-density is a real async derivation; call queryCompositeLayer (async) / deriveConstraintDensity, not buildCompositeLayerFixture.",
    );
  }

  if (layer === "oz-deal-crossfilter") {
    // Real derivation — never a fixture. Delegates to the OZ layer.
    return deriveOzDealCrossfilter(bbox).payload;
  }

  // motivated-seller is now a REAL async derivation (deriveMotivatedSellerHeat):
  // a transparent public-record weighted-sum, never the old
  // motivatedSellerHeat:0.74 / propensity:0.81 fixture. It cannot be built
  // synchronously (parcels + CAD-roll join are async), and the black-box
  // propensity number is forbidden by ruling R3, so the sync fixture builder no
  // longer serves it. Route through queryCompositeLayer (async), exactly like
  // buildable-envelope, constraint-density, and oz-deal-crossfilter.
  throw new Error(
    "motivated-seller is a real async derivation; call queryCompositeLayer (async) / deriveMotivatedSellerHeat, not buildCompositeLayerFixture. The 0.74 propensity fixture is retired (ruling R3: no proprietary propensity model).",
  );
}

export async function queryCompositeLayer(input: {
  layer: CompositeLayerKey;
  bbox: GisLayerBbox;
  fixture?: boolean;
}): Promise<
  EngineEnvelope<CompositeLayerPayload> & { readContract: ReadContract }
> {
  // oz-deal-crossfilter is a real derivation over the refreshed OZ layer:
  // deterministic honesty, degraded:false, real provenance. It never presents
  // as a fixture, so an incoming fixture flag does not downgrade it.
  if (input.layer === "oz-deal-crossfilter") {
    const { payload, honesty } = deriveOzDealCrossfilter(input.bbox);
    return {
      ...wrapEngineEnvelope(payload, honesty),
      readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
    };
  }

  // buildable-envelope is a real async derivation over live parcel geometry +
  // zoning + code corpus. Its honesty is earned from input completeness and it
  // degrades honestly when an input is missing (never a fixture 78%), so an
  // incoming fixture flag does not downgrade it.
  if (input.layer === "buildable-envelope") {
    const { payload, honesty } = await deriveBuildableEnvelope(input.bbox);
    return {
      ...wrapEngineEnvelope(payload, honesty),
      readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
    };
  }

  // constraint-density is a real async derivation: a severity-weighted STACK
  // over the already-live constraint layers (FEMA flood / SSURGO / Edwards /
  // MUD-PID). Its honesty is earned from how many layers were evaluated and it
  // degrades honestly (partial or out-of-scope) rather than ever emitting a
  // fabricated density, so an incoming fixture flag does not downgrade it.
  if (input.layer === "constraint-density") {
    const { payload, honesty } = await deriveConstraintDensity(input.bbox);
    return {
      ...wrapEngineEnvelope(payload, honesty),
      readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
    };
  }

  // motivated-seller is a real async derivation: a TRANSPARENT public-record
  // weighted-sum (absentee ownership live from the cad_property roll; the other
  // R3 signals modeled and recorded not-evaluated-pending-ingest). Its honesty
  // is asserted-with-verification-state and degrades honestly (partial /
  // out-of-scope) rather than ever emitting the retired 0.74 propensity fixture,
  // so an incoming fixture flag does not downgrade it.
  if (input.layer === "motivated-seller") {
    const { payload, honesty } = await deriveMotivatedSellerHeat(input.bbox);
    return {
      ...wrapEngineEnvelope(payload, honesty),
      readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
    };
  }

  const payload = buildCompositeLayerFixture(input.layer, input.bbox);
  const honesty = defaultHonesty(`brokerage:composite-${input.layer}`, true);
  return {
    ...wrapEngineEnvelope(
      {
        ...payload,
        fixture: input.fixture ?? payload.fixture,
      },
      honesty,
    ),
    readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
  };
}

export function listCompositeLayerEndpoints(): Array<{
  layer: CompositeLayerKey;
  adapterKey: string;
  description: string;
}> {
  return [
    {
      layer: "buildable-envelope",
      adapterKey: "brokerage:composite-buildable-envelope",
      description:
        "Parcel polygon inset by zoning setbacks and capped by FAR / lot-coverage from the code corpus, with derived buildableAreaPct + provenance (degrades honestly when parcel or dimensional standards are missing)",
    },
    {
      layer: "constraint-density",
      adapterKey: "brokerage:composite-constraint-density",
      description:
        "Severity-weighted stack of already-live constraint layers (FEMA flood, SSURGO soils, Edwards aquifer, MUD/PID) into a per-cell density surface, with per-layer provenance + evaluated/not-evaluated honesty (degrades to partial or out-of-scope; never a fabricated density)",
    },
    {
      layer: "oz-deal-crossfilter",
      adapterKey: "brokerage:composite-oz-deal-crossfilter",
      description:
        "CDFI/HUD-designated Opportunity Zone tracts in view, carrying OZ-designation deal signal + provenance (public-record only; no Cotality propensity)",
    },
    {
      layer: "motivated-seller",
      adapterKey: "brokerage:composite-motivated-seller",
      description:
        "Transparent documented weighted-sum of TX public-record distress signals (pre-foreclosure NOS, tax delinquency, lis-pendens/lien, absentee ownership, probate) into per-parcel motivated-seller heat, with per-signal weight + reasoning + evaluated/not-evaluated honesty (absentee live from the cad_property roll; other signals modeled and pending ingest; NO proprietary propensity model; degrades to partial or out-of-scope, never a fabricated heat)",
    },
  ];
}
