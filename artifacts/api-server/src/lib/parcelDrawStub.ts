/**
 * Drawable stub for get_smart_site (P-87 WDLL 22–26).
 *
 * Server projects once: stored Local-ENU metres → US survey feet.
 * Seed confidence never crosses as a float. Fixture setback zeros omitted.
 * Unknown hatch overlays require an in-region label or the stub is refused.
 */

export const US_SURVEY_FEET_PER_METRE = 3937 / 1200;
export const SMARTSITE_PARCEL_URL_PREFIX = "https://smartsite.cloud/p/";

export type DrawOverlayState =
  | "present"
  | "refused"
  | "unknown"
  | "absent-verified";

export type DrawOverlay = {
  id: string;
  label: string;
  draw: string;
  state: DrawOverlayState;
  geom?: "none";
  scope?: string;
  sfha?: boolean;
  reason?: string;
  provenance?: string;
  vintage?: string;
  citations?: string[];
  citationsDegraded?: boolean;
};

export type DrawEdge = {
  id: string;
  role: string;
  seg: [number, number];
  ft: number | null;
  bearing: string | null;
  adjacency: string | null;
  roadNode: string | null;
  roadClass?: string;
  neighbor?: string;
  state: "present";
};

export type ParcelDrawStub = {
  node: string;
  kind: "parcel";
  label: string;
  url: string;
  asOf: string | null;
  frame: {
    units: "ft";
    origin: "centroid";
    yAxis: "true-north";
    convertedFrom: "local-enu-m";
    factor: "us-survey-foot";
    quality: "gis-approximate";
  };
  ring?: [number, number][];
  ringOrder?: "ccw";
  edges?: DrawEdge[];
  attrs: Record<string, unknown>;
  overlays: DrawOverlay[];
  confidence: "seed";
};

export type DrawBoundaryEdgeIn = {
  entityId: string;
  edgeIndex: number;
  role: string | null;
  adjacencyKind: string | null;
  parcelNeighborPropId: string | null;
  facingRoad: {
    roadNodeId: string | null;
    classification: string | null;
  } | null;
  interior: { edgeEndpoints: unknown } | null;
  propertyLineTags: {
    bearing: string | null;
    distanceFeet: number | null;
  } | null;
};

export type AssembleParcelDrawInput = {
  parcelNodeId: string;
  label: string | null;
  bakedAt: string | null;
  countyFips: string | null;
  zoning: unknown;
  landUse: unknown;
  yearBuilt: number | null;
  boundary:
    | { state: "present"; edges: DrawBoundaryEdgeIn[] }
    | { state: "refused" | "absent"; code?: string };
  flood:
    | {
        state: "present";
        floodZone: string | null;
        zoneSubtype: string | null;
        inSpecialFloodHazardArea: boolean;
        citations?: string[];
      }
    | { state: "refused" | "absent"; sourceVintage?: string | null };
  envelopeRefusalReason: string | null;
  pipeline:
    | {
        state: "present";
        nearPipeline: boolean;
        bufferMeters: number | null;
        sourceVintage: string | null;
      }
    | { state: "refused" | "absent"; sourceVintage?: string | null };
  well:
    | { state: "present" }
    | { state: "refused" | "absent"; code?: string; sourceVintage?: string | null };
  specialDistrict:
    | { state: "present"; districtName?: string | null; districtId?: string | null }
    | { state: "absent"; sourceVintage?: string | null }
    | { state: "refused"; code?: string };
};

export function metresToSurveyFeet(metres: number): number {
  return Math.round(metres * US_SURVEY_FEET_PER_METRE * 100) / 100;
}

/**
 * A metres field printed in the feet frame with no more precision than the
 * source: the source's decimal resolution (0.1 m for `152.4`) is converted
 * to feet and the label keeps only the decimals that resolution supports.
 * `152.4` prints `500 ft`; `30.48` prints `100.0 ft`; `100` prints `328 ft`.
 */
export function feetLabelFromMetres(metres: number): string {
  const text = String(metres);
  const dot = text.indexOf(".");
  const metreDecimals = dot < 0 ? 0 : text.length - dot - 1;
  const resolutionFeet =
    Math.pow(10, -metreDecimals) * US_SURVEY_FEET_PER_METRE;
  const feetDecimals = Math.max(0, Math.floor(-Math.log10(resolutionFeet)));
  return `${(metres * US_SURVEY_FEET_PER_METRE).toFixed(feetDecimals)} ft`;
}

function knownVintage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "UNKNOWN") return null;
  return trimmed;
}

export type VerifiedAbsence =
  | { state: "absent-verified"; provenance: "present"; vintage: string }
  | { state: "unknown"; reason: string; provenance?: "degraded"; vintage?: string };

/**
 * F5 (triage D6): absent-verified is earned, never asserted. The draw wire's
 * provenance is read off the vintage the fact carries: a known vintage is
 * present provenance; a vintage the atom spells UNKNOWN is degraded
 * provenance (the record declares it does not know); no vintage at all is
 * no provenance. Only the first earns absent-verified. The other two are
 * unknown, with `reason` naming what is missing.
 */
export function verifiedAbsence(basis: {
  sourceVintage?: string | null;
}): VerifiedAbsence {
  const raw = basis.sourceVintage;
  const vintage = knownVintage(raw);
  if (vintage) {
    return { state: "absent-verified", provenance: "present", vintage };
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return {
      state: "unknown",
      reason: "provenance degraded; vintage unknown",
      provenance: "degraded",
      vintage: raw.trim(),
    };
  }
  return { state: "unknown", reason: "provenance unknown; vintage unknown" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isHttpCitation(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** Http citation URLs only. Prose sourceCitation strings are not citations. */
export function httpCitationUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (candidate: unknown, key?: string): void => {
    if (typeof candidate === "string") {
      if (
        key &&
        (key === "sourceCitation" ||
          key === "citationUrl" ||
          key === "sourceUrl" ||
          /(?:citation|source).*url|url.*(?:citation|source)/i.test(key)) &&
        isHttpCitation(candidate)
      ) {
        urls.add(candidate.trim());
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (key === "citations") {
        for (const item of candidate) {
          if (isHttpCitation(item)) urls.add(item.trim());
        }
        return;
      }
      candidate.forEach((item) => visit(item, key));
      return;
    }
    const record = asRecord(candidate);
    if (record) {
      Object.entries(record).forEach(([nestedKey, nestedValue]) =>
        visit(nestedValue, nestedKey),
      );
    }
  };
  visit(value);
  return [...urls];
}

function citationPosture(citations: string[]): {
  citations: string[];
  citationsDegraded?: boolean;
} {
  const http = citations.filter(isHttpCitation).map((url) => url.trim());
  if (http.length > 0) return { citations: http };
  return { citations: [], citationsDegraded: true };
}

function presentCitationDishonest(rail: {
  state?: unknown;
  citations?: unknown;
  citationsDegraded?: unknown;
}): boolean {
  if (rail.state !== "present") return false;
  const citations = Array.isArray(rail.citations)
    ? rail.citations.filter(isHttpCitation)
    : [];
  return citations.length === 0 && rail.citationsDegraded !== true;
}

function parseEndpoints(
  raw: unknown,
): [[number, number], [number, number]] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = raw[0];
  const b = raw[1];
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
    return null;
  }
  const nums = [a[0], a[1], b[0], b[1]];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  return [
    [nums[0] as number, nums[1] as number],
    [nums[2] as number, nums[3] as number],
  ];
}

function countyFipsFromNode(parcelNodeId: string): string | null {
  const fips = parcelNodeId.split(":")[0];
  return fips && /^\d{5}$/.test(fips) ? fips : null;
}

function zoningAttrs(zoning: unknown): Record<string, unknown> | null {
  const rec = asRecord(zoning);
  if (!rec) return null;
  const district =
    (typeof rec.district === "string" && rec.district) ||
    (typeof rec.zone === "string" && rec.zone) ||
    (typeof rec.code === "string" && rec.code) ||
    null;
  if (!district) return null;
  const jurisdiction =
    (typeof rec.cityKey === "string" && rec.cityKey) ||
    (typeof rec.jurisdiction === "string" && rec.jurisdiction) ||
    (typeof rec.jurisdictionKey === "string" && rec.jurisdictionKey) ||
    null;
  const codeRefs: string[] = [];
  const sourceRef = asRecord(rec.sourceCodeAtomRef);
  if (typeof sourceRef?.atomDid === "string") codeRefs.push(sourceRef.atomDid);
  const refs = asRecord(rec.codeSectionRefs);
  if (refs) {
    for (const value of Object.values(refs)) {
      const nested = asRecord(value);
      if (typeof nested?.atomDid === "string" && !codeRefs.includes(nested.atomDid)) {
        codeRefs.push(nested.atomDid);
      }
    }
  }
  return {
    v: district,
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(typeof rec.matchBasis === "string" ? { matchBasis: rec.matchBasis } : {}),
    ...(codeRefs.length > 0
      ? { codeRefs, refBasis: "body-denorm" }
      : {}),
    state: "present",
  };
}

function landUseAttrs(landUse: unknown): Record<string, unknown> | null {
  const rec = asRecord(landUse);
  if (!rec) return null;
  const code =
    (typeof rec.landUseCode === "string" && rec.landUseCode) ||
    (typeof rec.code === "string" && rec.code) ||
    null;
  if (!code) return null;
  const desc =
    (typeof rec.landUseDescription === "string" && rec.landUseDescription) ||
    (typeof rec.desc === "string" && rec.desc) ||
    null;
  const taxYear =
    typeof rec.taxYear === "number"
      ? rec.taxYear
      : typeof rec.taxYear === "string" && /^\d{4}$/.test(rec.taxYear)
        ? Number(rec.taxYear)
        : null;
  const citations = citationPosture(httpCitationUrls(landUse));
  return {
    v: code,
    ...(desc ? { desc } : {}),
    ...(taxYear != null ? { taxYear } : {}),
    state: "present",
    ...citations,
  };
}

function floodOverlay(
  flood: AssembleParcelDrawInput["flood"],
): DrawOverlay {
  if (flood.state === "absent") {
    return {
      id: "flood",
      label: "No mapped flood zone of record",
      geom: "none",
      draw: "legend-only",
      ...verifiedAbsence(flood),
    };
  }
  if (flood.state !== "present") {
    return {
      id: "flood",
      label: "Flood record not checked",
      geom: "none",
      draw: "legend-only",
      state: "unknown",
    };
  }
  const zone = flood.floodZone?.trim() || "unlabelled";
  const subtype = flood.zoneSubtype?.trim();
  const label = subtype
    ? `Zone ${zone} ${subtype}`
    : `Zone ${zone}`;
  const citations = citationPosture(
    flood.citations?.filter(isHttpCitation) ?? httpCitationUrls(flood),
  );
  return {
    id: "flood",
    label,
    sfha: flood.inSpecialFloodHazardArea,
    scope: "parcel-wide",
    geom: "none",
    draw: "tint-ring",
    state: "present",
    ...citations,
  };
}

export function assertDrawStub(draw: ParcelDrawStub): void {
  for (const overlay of draw.overlays) {
    if (
      overlay.state === "unknown" &&
      overlay.draw === "hatch-interior" &&
      !overlay.label.trim()
    ) {
      throw new Error(
        "unknown hatch-interior overlay requires a non-empty in-region label",
      );
    }
    if (overlay.id === "flood" && presentCitationDishonest(overlay)) {
      throw new Error(
        "present flood overlay ships an empty citation array; set citationsDegraded or attach an http citation",
      );
    }
    if (
      overlay.state === "absent-verified" &&
      (overlay.provenance !== "present" || knownVintage(overlay.vintage) === null)
    ) {
      throw new Error(
        `${overlay.id} overlay is absent-verified without provenance present and a known vintage`,
      );
    }
  }
  const landUse = asRecord(draw.attrs.landUse);
  if (landUse && presentCitationDishonest(landUse)) {
    throw new Error(
      "present landUse ships an empty citation array; set citationsDegraded or attach an http citation",
    );
  }
  const blob = JSON.stringify(draw);
  if (
    blob.includes("calibratedConfidence") ||
    blob.includes('"estimate":0.7') ||
    blob.includes('"estimate":0.9')
  ) {
    throw new Error("seed confidence float must not cross the draw wire");
  }
}

export function assembleParcelDraw(
  input: AssembleParcelDrawInput,
): ParcelDrawStub {
  const fips = input.countyFips ?? countyFipsFromNode(input.parcelNodeId);
  const overlays: DrawOverlay[] = [];
  const attrs: Record<string, unknown> = {};

  const zoning = zoningAttrs(input.zoning);
  if (zoning) attrs.zoning = zoning;
  const landUse = landUseAttrs(input.landUse);
  if (landUse) attrs.landUse = landUse;
  if (typeof input.yearBuilt === "number" && Number.isFinite(input.yearBuilt)) {
    attrs.yearBuilt = { v: input.yearBuilt, state: "present" };
  }

  overlays.push(floodOverlay(input.flood));

  const yearLabel =
    typeof input.yearBuilt === "number"
      ? `Structure of record (${input.yearBuilt}), footprint unmeasured`
      : "Structure footprint unmeasured";
  overlays.push({
    id: "footprint",
    label: yearLabel,
    geom: "none",
    draw: "hatch-interior",
    state: "unknown",
  });

  overlays.push({
    id: "envelope",
    label: "Buildable envelope not computed",
    geom: "none",
    draw: "suppress-setback-line",
    state: "refused",
    reason: input.envelopeRefusalReason ?? "atom_path_pending",
  });

  if (input.pipeline.state === "present" && input.pipeline.nearPipeline === false) {
    const metres = input.pipeline.bufferMeters;
    overlays.push({
      id: "pipeline",
      label:
        metres != null && Number.isFinite(metres)
          ? `No pipeline within ${feetLabelFromMetres(metres)}`
          : "No pipeline within screening distance",
      draw: "legend-only",
      ...verifiedAbsence(input.pipeline),
    });
  } else if (input.pipeline.state === "present") {
    overlays.push({
      id: "pipeline",
      label: "Pipeline within screening distance",
      draw: "legend-only",
      state: "present",
    });
  } else if (input.pipeline.state === "absent") {
    overlays.push({
      id: "pipeline",
      label: "No pipeline of record",
      draw: "legend-only",
      ...verifiedAbsence(input.pipeline),
    });
  } else {
    overlays.push({
      id: "pipeline",
      label: "Pipeline records not checked",
      draw: "legend-only",
      state: "unknown",
    });
  }

  if (input.specialDistrict.state === "absent") {
    overlays.push({
      id: "specialDistrict",
      label: "Outside mapped special districts",
      draw: "legend-only",
      ...verifiedAbsence(input.specialDistrict),
    });
  } else if (input.specialDistrict.state === "present") {
    const name =
      input.specialDistrict.districtName ||
      input.specialDistrict.districtId ||
      "special district";
    overlays.push({
      id: "specialDistrict",
      label: name,
      draw: "legend-only",
      state: "present",
    });
  } else {
    overlays.push({
      id: "specialDistrict",
      label: "Special districts not checked",
      draw: "legend-only",
      state: "unknown",
    });
  }

  if (input.well.state === "present") {
    overlays.push({
      id: "well",
      label: "Well of record",
      draw: "legend-only",
      state: "present",
    });
  } else if (input.well.state === "absent") {
    overlays.push({
      id: "well",
      label: "No well of record within screening distance",
      draw: "legend-only",
      ...verifiedAbsence(input.well),
    });
  } else {
    overlays.push({
      id: "well",
      label: "Well records not checked",
      draw: "legend-only",
      state: "unknown",
    });
  }

  const draw: ParcelDrawStub = {
    node: input.parcelNodeId,
    kind: "parcel",
    label: input.label?.trim() || input.parcelNodeId,
    url: `${SMARTSITE_PARCEL_URL_PREFIX}${input.parcelNodeId}`,
    asOf: input.bakedAt,
    frame: {
      units: "ft",
      origin: "centroid",
      yAxis: "true-north",
      convertedFrom: "local-enu-m",
      factor: "us-survey-foot",
      quality: "gis-approximate",
    },
    attrs,
    overlays,
    confidence: "seed",
  };

  if (input.boundary.state !== "present" || input.boundary.edges.length === 0) {
    overlays.unshift({
      id: "boundary",
      label: "Parcel boundary unmeasured",
      geom: "none",
      draw: "hatch-interior",
      state: "unknown",
    });
    assertDrawStub(draw);
    return draw;
  }

  const sorted = [...input.boundary.edges].sort(
    (a, b) => a.edgeIndex - b.edgeIndex,
  );
  const ringMetres: [number, number][] = [];
  const edges: DrawEdge[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const edge = sorted[i]!;
    const pair = parseEndpoints(edge.interior?.edgeEndpoints);
    if (!pair) {
      overlays.unshift({
        id: "boundary",
        label: "Parcel boundary unmeasured",
        geom: "none",
        draw: "hatch-interior",
        state: "unknown",
      });
      assertDrawStub(draw);
      return draw;
    }
    if (i === 0) ringMetres.push(pair[0]);
    ringMetres.push(pair[1]);
    const neighbor =
      edge.parcelNeighborPropId && fips
        ? `${fips}:${edge.parcelNeighborPropId}`
        : undefined;
    const roadClass = edge.facingRoad?.classification ?? undefined;
    edges.push({
      id: edge.entityId,
      role: edge.role ?? `index-${edge.edgeIndex}`,
      seg: [i, (i + 1) % sorted.length],
      ft:
        typeof edge.propertyLineTags?.distanceFeet === "number"
          ? Math.round(edge.propertyLineTags.distanceFeet * 100) / 100
          : metresToSurveyFeet(
              Math.hypot(
                pair[1][0] - pair[0][0],
                pair[1][1] - pair[0][1],
              ),
            ),
      bearing: edge.propertyLineTags?.bearing ?? null,
      adjacency: edge.adjacencyKind,
      roadNode: edge.facingRoad?.roadNodeId ?? null,
      ...(roadClass ? { roadClass } : {}),
      ...(neighbor ? { neighbor } : {}),
      state: "present",
    });
  }

  // Last vertex repeats the first; drop the close.
  if (ringMetres.length === sorted.length + 1) {
    ringMetres.pop();
  }

  draw.ring = ringMetres.map(([x, y]) => [
    metresToSurveyFeet(x),
    metresToSurveyFeet(y),
  ]);
  draw.ringOrder = "ccw";
  draw.edges = edges;

  assertDrawStub(draw);
  return draw;
}
