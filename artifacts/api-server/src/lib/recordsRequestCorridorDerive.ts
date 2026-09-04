/**
 * P-85 WDLL item 9 — corridor geometry as Derivation from parcel + clause.
 *
 * Pure derivation: parcel ring + restriction clause text → corridor polygon
 * stored under structuredFields.constrains with derivesFrom, methodId,
 * confidence. Unplaceable clauses say so and carry no geometry.
 */

import {
  feetToMeters,
  openRing,
  projectRing,
  type Ring,
} from "./buildableEnvelope/geometry";
import { labelEdges, type EdgeLabel } from "./buildableEnvelope/edgeLabeling";

export const RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION = "records-request-corridor-v1";

export type CorridorPlacement = "placed" | "unplaceable";

export interface CorridorDerivesFrom {
  clauseDid: string;
  parcelGeometryRef: string;
}

export interface CorridorConstrainsRef {
  type: "corridor";
  derivesFrom: CorridorDerivesFrom;
  methodId: string;
  confidence: number;
  placement: CorridorPlacement;
  widthFt?: number;
  edgeHint?: string;
  geometryGeojson?: GeoJSONPolygon;
  unplaceableReason?: string;
  labelingNote?: string;
}

/** GeoJSON Polygon (lng/lat). */
export type GeoJSONPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export class RecordsRequestCorridorRefuseError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "RecordsRequestCorridorRefuseError";
    this.code = code;
  }
}

type CompassDirection = "north" | "south" | "east" | "west";

type EdgeHint =
  | { kind: "labeled"; label: EdgeLabel }
  | { kind: "compass"; direction: CompassDirection; platNoted?: boolean }
  | { kind: "unplaceable"; reason: string };

export interface DeriveCorridorInput {
  clauseDid: string;
  bodyText: string;
  parcelGeometryRef: string;
  parcelRing: Ring;
}

export type DeriveCorridorResult =
  | { kind: "not_corridor_clause" }
  | { kind: "derived"; constrains: CorridorConstrainsRef };

interface XY {
  x: number;
  y: number;
}

function inwardNormal(a: XY, b: XY): XY | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { x: -dy / len, y: dx / len };
}

function unproject(p: XY, proj: NonNullable<ReturnType<typeof projectRing>>): [number, number] {
  return [
    proj.originLng + p.x / proj.mPerDegLng,
    proj.originLat + p.y / proj.mPerDegLat,
  ];
}

function corridorPolygonAlongEdge(
  ring: Ring,
  edgeIndex: number,
  widthFt: number,
): GeoJSONPolygon | null {
  const proj = projectRing(ring);
  if (!proj) return null;
  const pts = proj.points;
  const n = pts.length;
  if (edgeIndex < 0 || edgeIndex >= n) return null;

  const widthM = feetToMeters(widthFt);
  if (!Number.isFinite(widthM) || widthM <= 0) return null;

  const a = pts[edgeIndex]!;
  const b = pts[(edgeIndex + 1) % n]!;
  const nrm = inwardNormal(a, b);
  if (!nrm) return null;

  const aOff: XY = { x: a.x + nrm.x * widthM, y: a.y + nrm.y * widthM };
  const bOff: XY = { x: b.x + nrm.x * widthM, y: b.y + nrm.y * widthM };

  const ringLngLat = [
    unproject(a, proj),
    unproject(b, proj),
    unproject(bOff, proj),
    unproject(aOff, proj),
    unproject(a, proj),
  ];
  return { type: "Polygon", coordinates: [ringLngLat] };
}

const WIDTH_WORDS: Record<string, number> = {
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  twentyfive: 25,
  "twenty-five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

export function parseCorridorWidthFt(bodyText: string): number | null {
  const numeric = bodyText.match(/\b(\d{1,3})\s*[- ]?\s*(?:foot|feet|ft\.?)\b/i);
  if (numeric) {
    const n = Number(numeric[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const worded = bodyText.match(
    /\b(five|ten|fifteen|twenty|twenty-five|twentyfive|thirty|forty|fifty)\s*[- ]?\s*(?:foot|feet|ft\.?)\b/i,
  );
  if (!worded) return null;
  const key = worded[1]!.toLowerCase();
  return WIDTH_WORDS[key] ?? null;
}

function hasCorridorLanguage(bodyText: string): boolean {
  return /\b(?:easement|right[- ]of[- ]way|row\b|utility corridor|drainage|storm drain|sewer line|pipeline)\b/i.test(
    bodyText,
  );
}

/** Parse placement hints from clause body text. */
export function parseCorridorEdgeHint(bodyText: string): EdgeHint | null {
  const t = bodyText.toLowerCase();

  if (
    /\bmutually agreed\b/.test(t) ||
    /\bsuch location as\b/.test(t) ||
    /\bto be determined\b/.test(t) ||
    /\bas may be agreed\b/.test(t)
  ) {
    return {
      kind: "unplaceable",
      reason: "clause lacks a fixed boundary anchor",
    };
  }

  if (/\b(?:rear|back)\s+line\b/.test(t) || /\balong the rear\b/.test(t)) {
    return { kind: "labeled", label: "rear" };
  }
  if (/\bfront\s+line\b/.test(t) || /\balong the front\b/.test(t)) {
    return { kind: "labeled", label: "front" };
  }

  const platNoted = /\b(?:as )?shown on (?:the )?plat\b/.test(t);
  if (/\beast(?:ern)?\s+(?:boundary|line|line of)\b/.test(t)) {
    return { kind: "compass", direction: "east", platNoted };
  }
  if (/\bwest(?:ern)?\s+(?:boundary|line|line of)\b/.test(t)) {
    return { kind: "compass", direction: "west", platNoted };
  }
  if (/\bnorth(?:ern)?\s+(?:boundary|line|line of)\b/.test(t)) {
    return { kind: "compass", direction: "north", platNoted };
  }
  if (/\bsouth(?:ern)?\s+(?:boundary|line|line of)\b/.test(t)) {
    return { kind: "compass", direction: "south", platNoted };
  }

  if (hasCorridorLanguage(bodyText) && !parseCorridorWidthFt(bodyText)) {
    return {
      kind: "unplaceable",
      reason: "corridor language without width or boundary anchor",
    };
  }

  return null;
}

function edgeIndexForCompass(
  ring: Ring,
  direction: CompassDirection,
): number | null {
  const proj = projectRing(ring);
  if (!proj) return null;
  const pts = proj.points;
  const n = pts.length;
  let bestIdx = -1;
  let bestScore = direction === "east" || direction === "north" ? -Infinity : Infinity;

  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const mid: XY = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let score: number;
    switch (direction) {
      case "east":
        score = mid.x;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
        break;
      case "west":
        score = mid.x;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
        break;
      case "north":
        score = mid.y;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
        break;
      case "south":
        score = mid.y;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
        break;
    }
  }
  return bestIdx >= 0 ? bestIdx : null;
}

function edgeIndexForLabel(ring: Ring, label: EdgeLabel): {
  edgeIndex: number;
  labelingNote: string;
  labelingConfidence: number;
} | null {
  const labeling = labelEdges({ ring });
  if (!labeling) return null;

  const candidates = labeling.edges.filter((e) => e.label === label);
  if (candidates.length === 0) return null;

  const longest = candidates.reduce((a, b) => (a.lengthM >= b.lengthM ? a : b));
  return {
    edgeIndex: longest.index,
    labelingNote: labeling.note,
    labelingConfidence: labeling.confidence,
  };
}

function unplaceableResult(input: {
  clauseDid: string;
  parcelGeometryRef: string;
  reason: string;
  edgeHint?: string;
  methodId: string;
}): DeriveCorridorResult {
  return {
    kind: "derived",
    constrains: {
      type: "corridor",
      derivesFrom: {
        clauseDid: input.clauseDid,
        parcelGeometryRef: input.parcelGeometryRef,
      },
      methodId: input.methodId,
      confidence: 0,
      placement: "unplaceable",
      unplaceableReason: input.reason,
      edgeHint: input.edgeHint,
    },
  };
}

/**
 * Fail closed: any corridor geometry must cite derivesFrom (clause + parcel).
 */
export function assertCorridorDerivationWritable(constrains: {
  type?: string;
  placement?: CorridorPlacement;
  derivesFrom?: CorridorDerivesFrom | null;
  geometryGeojson?: unknown;
}): void {
  const hasGeometry =
    constrains.geometryGeojson != null &&
    typeof constrains.geometryGeojson === "object";

  if (hasGeometry) {
    const df = constrains.derivesFrom;
    if (!df?.clauseDid?.trim() || !df?.parcelGeometryRef?.trim()) {
      throw new RecordsRequestCorridorRefuseError(
        "corridor_missing_derives_from",
        "Corridor geometry refuses without derivesFrom naming clause and parcel geometry",
      );
    }
  }

  if (constrains.placement === "placed" && !hasGeometry) {
    throw new RecordsRequestCorridorRefuseError(
      "corridor_placed_without_geometry",
      "Placed corridor refuses without geometryGeojson",
    );
  }
}

/** Derive corridor constrains reference from parcel ring + clause text. */
export function deriveCorridorFromClause(input: DeriveCorridorInput): DeriveCorridorResult {
  if (openRing(input.parcelRing).length < 3) {
    return unplaceableResult({
      clauseDid: input.clauseDid,
      parcelGeometryRef: input.parcelGeometryRef,
      reason: "parcel ring is degenerate",
      methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
    });
  }

  const hint = parseCorridorEdgeHint(input.bodyText);
  if (!hint) {
    return { kind: "not_corridor_clause" };
  }

  if (hint.kind === "unplaceable") {
    return unplaceableResult({
      clauseDid: input.clauseDid,
      parcelGeometryRef: input.parcelGeometryRef,
      reason: hint.reason,
      methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
    });
  }

  const widthFt = parseCorridorWidthFt(input.bodyText);
  if (!widthFt) {
    return unplaceableResult({
      clauseDid: input.clauseDid,
      parcelGeometryRef: input.parcelGeometryRef,
      reason: "corridor clause missing explicit width in feet",
      edgeHint: hint.kind === "labeled" ? hint.label : hint.direction,
      methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
    });
  }

  if (hint.kind === "labeled") {
    const labeled = edgeIndexForLabel(input.parcelRing, hint.label);
    if (labeled == null) {
      return unplaceableResult({
        clauseDid: input.clauseDid,
        parcelGeometryRef: input.parcelGeometryRef,
        reason: `could not resolve ${hint.label} edge on parcel ring`,
        edgeHint: hint.label,
        methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
      });
    }
    const geometryGeojson = corridorPolygonAlongEdge(
      input.parcelRing,
      labeled.edgeIndex,
      widthFt,
    );
    if (!geometryGeojson) {
      return unplaceableResult({
        clauseDid: input.clauseDid,
        parcelGeometryRef: input.parcelGeometryRef,
        reason: "corridor strip construction failed",
        edgeHint: hint.label,
        methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
      });
    }

    const confidence = Math.min(0.62, labeled.labelingConfidence * 0.95);
    const methodSuffix =
      hint.label === "rear" ? "rear-line-strip" : "labeled-edge-strip";
    const constrains: CorridorConstrainsRef = {
      type: "corridor",
      derivesFrom: {
        clauseDid: input.clauseDid,
        parcelGeometryRef: input.parcelGeometryRef,
      },
      methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:${methodSuffix}`,
      confidence,
      placement: "placed",
      widthFt,
      edgeHint: hint.label,
      geometryGeojson,
      labelingNote: labeled.labelingNote,
    };
    assertCorridorDerivationWritable(constrains);
    return { kind: "derived", constrains };
  }

  const edgeIndex = edgeIndexForCompass(input.parcelRing, hint.direction);
  if (edgeIndex == null) {
    return unplaceableResult({
      clauseDid: input.clauseDid,
      parcelGeometryRef: input.parcelGeometryRef,
      reason: `could not resolve ${hint.direction} boundary on parcel ring`,
      edgeHint: hint.direction,
      methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
    });
  }

  const geometryGeojson = corridorPolygonAlongEdge(
    input.parcelRing,
    edgeIndex,
    widthFt,
  );
  if (!geometryGeojson) {
    return unplaceableResult({
      clauseDid: input.clauseDid,
      parcelGeometryRef: input.parcelGeometryRef,
      reason: "corridor strip construction failed",
      edgeHint: hint.direction,
      methodId: `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:unplaceable`,
    });
  }

  const methodId = hint.platNoted
    ? `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:plat-noted-strip`
    : `${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:compass-edge-strip`;

  const constrains: CorridorConstrainsRef = {
    type: "corridor",
    derivesFrom: {
      clauseDid: input.clauseDid,
      parcelGeometryRef: input.parcelGeometryRef,
    },
    methodId,
    confidence: hint.platNoted ? 0.78 : 0.72,
    placement: "placed",
    widthFt,
    edgeHint: hint.direction,
    geometryGeojson,
    labelingNote: hint.platNoted
      ? "Plat-noted drainage corridor placed on compass boundary (machine derivation)."
      : "Compass boundary corridor (machine derivation).",
  };
  assertCorridorDerivationWritable(constrains);
  return { kind: "derived", constrains };
}
