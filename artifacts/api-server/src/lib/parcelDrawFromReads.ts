/**
 * Map live fact reads + bake facets onto assembleParcelDraw.
 * Serializer refuse → omit draw (fail closed). Never invent a ring.
 *
 * X2 + item 4 ship together: edge disposition is chosen by the union;
 * absent overlay reads carry sourceVintage so absent-verified is reachable.
 */

import type { BoundaryEdgeFactRead } from "./boundaryEdgeFactRead";
import type { EnvelopeBriefRefusal } from "./envelopeBriefRefusal";
import type { FloodHazardFactRead } from "./floodHazardFactRead";
import type { PipelineFactRead } from "./pipelineFactRead";
import type { SpecialDistrictFactRead } from "./specialDistrictFactRead";
import type { StructuralFactRead } from "./structuralFactResolve";
import type { WellFactRead } from "./wellFactRead";
import type { BuildingFootprintFactRead } from "./buildingFootprintFactRead";
import {
  assembleParcelDraw,
  httpCitationUrls,
  type AssembleParcelDrawInput,
  type DrawFrameAnchor,
  type ParcelDrawStub,
} from "./parcelDrawStub";
import {
  cadRollAttrsFromOnRecord,
  serializeTwinOnRecord,
} from "./twinOnRecordSerialize";
import { firstPresentSitusLabel } from "./situsCompose";
import {
  envelopeDrawRefusalReason,
  type EnvelopeDrawOutcome,
} from "./buildableEnvelope/envelopeDrawOutcome";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function situsLabel(parcelNodeId: string, facets: unknown): string {
  const root = asRecord(facets);
  const base = asRecord(root?.baseFacts);
  return firstPresentSitusLabel(parcelNodeId, [
    typeof root?.situsAddress === "string" ? root.situsAddress : null,
    typeof root?.address === "string" ? root.address : null,
    typeof base?.situsAddress === "string" ? base.situsAddress : null,
    typeof base?.address === "string" ? base.address : null,
  ]).label;
}

function yearBuiltFromStructural(
  read: StructuralFactRead,
): AssembleParcelDrawInput["yearBuilt"] {
  if ("state" in read && read.state === "present") {
    return typeof read.yearBuilt === "number" && Number.isFinite(read.yearBuilt)
      ? {
          v: read.yearBuilt,
          source: "cad_property",
          sourceVintage: read.sourceVintage,
        }
      : null;
  }
  return null;
}

/**
 * Exported (P-153) so callers deciding whether to attempt the modelled-
 * envelope derivation (`../lib/buildableEnvelope/parcelDrawEnvelopeModel.ts`,
 * wired from `propertyExplorer.ts`) can test the SAME predicate this file
 * already uses for the refused overlay's `reason`, rather than a second,
 * driftable copy of "is this atom-pending". `atomPathPending(refusal)` below
 * is the boolean form of that same test.
 *
 * P-339: this is the BAKE's reason, and after P-339 it decides the envelope
 * overlay only when the drawing route was never attempted — `tryAssembleParcelDrawFromReads`'s
 * `envelopeOutcome` wins whenever the route ran. Its two `atom_path_pending`
 * paths (`declined-in-bake`, and an absent brief) are the bake's own
 * anti-zombie marker: "go read the atom route". They are not a determination.
 */
export function envelopeReason(refusal: EnvelopeBriefRefusal | null | undefined): string {
  if (!refusal) return "atom_path_pending";
  if (refusal.declineReason?.trim()) return refusal.declineReason.trim();
  if (refusal.code === "declined-in-bake") return "atom_path_pending";
  return refusal.code;
}

/** True exactly when `envelopeReason` would resolve to `"atom_path_pending"`. */
export function atomPathPending(
  refusal: EnvelopeBriefRefusal | null | undefined,
): boolean {
  return envelopeReason(refusal) === "atom_path_pending";
}

function vintageFromRead(read: {
  sourceVintage?: string | null;
}): string | null {
  return typeof read.sourceVintage === "string" ? read.sourceVintage : null;
}

function boundaryInput(
  read: BoundaryEdgeFactRead,
): AssembleParcelDrawInput["boundary"] {
  if (read.state === "present" && read.edges.length > 0) {
    return {
      state: "present",
      edges: read.edges.map((edge) => ({
        entityId: edge.entityId,
        edgeIndex: edge.edgeIndex,
        role: edge.role,
        adjacencyKind: edge.adjacencyKind,
        parcelNeighborPropId: edge.parcelNeighborPropId,
        facingRoad: edge.facingRoad
          ? {
              roadNodeId: edge.facingRoad.roadNodeId,
              classification: edge.facingRoad.classification,
            }
          : null,
        interior: edge.interior,
        propertyLineTags: edge.propertyLineTags
          ? {
              bearing: edge.propertyLineTags.bearing,
              distanceFeet: edge.propertyLineTags.distanceFeet,
            }
          : null,
        sourceAdapter: edge.sourceAdapter,
        status: edge.status,
      })),
    };
  }
  return {
    state: "refused",
    code: read.state === "refused" ? read.code : "atom-miss",
  };
}

function floodInput(read: FloodHazardFactRead): AssembleParcelDrawInput["flood"] {
  if (read.state === "present") {
    return {
      state: "present",
      floodZone: read.floodZone,
      zoneSubtype: read.zoneSubtype,
      inSpecialFloodHazardArea: read.inSpecialFloodHazardArea,
      citations: httpCitationUrls(read),
    };
  }
  if (read.state === "absent") {
    return { state: "absent", sourceVintage: vintageFromRead(read) };
  }
  return { state: "refused" };
}

function pipelineInput(
  read: PipelineFactRead,
): AssembleParcelDrawInput["pipeline"] {
  if (read.state === "present") {
    return {
      state: "present",
      nearPipeline: read.nearPipeline,
      bufferMeters: read.bufferMeters,
      sourceVintage: read.sourceVintage,
    };
  }
  if (read.state === "absent") {
    return { state: "absent", sourceVintage: vintageFromRead(read) };
  }
  return { state: "refused" };
}

function wellInput(read: WellFactRead): AssembleParcelDrawInput["well"] {
  if (read.state === "present") return { state: "present" };
  if (read.state === "absent") {
    return { state: "absent", sourceVintage: vintageFromRead(read) };
  }
  return { state: "refused", code: read.code };
}

function specialDistrictInput(
  read: SpecialDistrictFactRead,
): AssembleParcelDrawInput["specialDistrict"] {
  if (read.state === "present") {
    return {
      state: "present",
      districtName: read.districtName,
      districtId: read.districtId,
    };
  }
  if (read.state === "absent") {
    return { state: "absent", sourceVintage: vintageFromRead(read) };
  }
  return { state: "refused", code: read.code };
}

function anchorFromQueryPoint(queryPoint: unknown): DrawFrameAnchor | null {
  const rec = asRecord(queryPoint);
  if (!rec) return null;
  const lat =
    typeof rec.latitude === "number"
      ? rec.latitude
      : typeof rec.lat === "number"
        ? rec.lat
        : null;
  const lng =
    typeof rec.longitude === "number"
      ? rec.longitude
      : typeof rec.lng === "number"
        ? rec.lng
        : null;
  if (
    lat == null ||
    lng == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    (lat === 0 && lng === 0)
  ) {
    return null;
  }
  return { lat, lng };
}

function mergeOnRecordAttrs(
  draw: ParcelDrawStub,
  onRecord: ReturnType<typeof serializeTwinOnRecord>,
): ParcelDrawStub {
  const attrs = { ...draw.attrs };
  if (onRecord.apn) attrs.apn = onRecord.apn;
  if (onRecord.acreage) attrs.acreage = onRecord.acreage;
  if (onRecord.countyFips) attrs.countyFips = onRecord.countyFips;
  if (onRecord.countyName) attrs.countyName = onRecord.countyName;
  if (onRecord.situsState) attrs.situsState = onRecord.situsState;
  Object.assign(attrs, cadRollAttrsFromOnRecord(onRecord));
  return { ...draw, attrs };
}

export function tryAssembleParcelDrawFromReads(args: {
  parcelNodeId: string;
  facets: unknown;
  bakedAt: string | null;
  envelopeBriefRefusal?: EnvelopeBriefRefusal | null;
  /**
   * P-339: the point-seeded drawing route's OWN outcome, when the caller
   * attempted it (`propertyExplorer.ts`). After P-339 this is the sole decider
   * of the envelope overlay: `modelled` draws the polygon (P-153's path,
   * unchanged), a refusal serves that outcome's own reason. The bake's stored
   * `atom_path_pending` marker can therefore no longer outrank an attempt the
   * route already answered. Absent/`null` means no attempt was made, and keeps
   * today's baked-reason behaviour.
   */
  envelopeOutcome?: EnvelopeDrawOutcome | null;
  queryPoint?: { latitude: number; longitude: number } | null;
  boundary: BoundaryEdgeFactRead;
  flood: FloodHazardFactRead;
  pipeline: PipelineFactRead;
  well: WellFactRead;
  specialDistrict: SpecialDistrictFactRead;
  structural: StructuralFactRead;
  /**
   * Studio+ gate on the four CAD dollar rails (OPS-16 A-103 item 5 / A-104),
   * same predicate as owner-info. Threaded straight into
   * {@link serializeTwinOnRecord} so the draw attrs never carry an
   * ungated dollar value.
   */
  grantsCadRollValuation: boolean;
  /** P-445: the footprint overlay reads this fact. */
  buildingFootprint?: BuildingFootprintFactRead | null;
}): ParcelDrawStub | undefined {
  const root = asRecord(args.facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  // P-339: the route's own outcome, when it ran, decides BOTH the reason the
  // overlay serves and whether a polygon is drawn. The bake's reason is
  // consulted only when no attempt was made — that is what stops
  // `atom_path_pending` travelling as the answer to a question the route
  // already answered. `modelled-figure-withheld` is passed for the modelled
  // case only because the input is required; a drawn overlay never reads it.
  const envelopeOutcome = args.envelopeOutcome ?? null;
  const envelopeModelled =
    envelopeOutcome?.state === "modelled" ? envelopeOutcome.model : null;
  const envelopeRefusalReason =
    envelopeOutcome == null
      ? envelopeReason(args.envelopeBriefRefusal)
      : envelopeOutcome.state === "modelled"
        ? "modelled-figure-withheld"
        : envelopeDrawRefusalReason(envelopeOutcome.refusal);
  try {
    const draw = assembleParcelDraw({
      parcelNodeId: args.parcelNodeId,
      label: situsLabel(args.parcelNodeId, args.facets),
      bakedAt: args.bakedAt,
      countyFips: args.parcelNodeId.split(":")[0] ?? null,
      zoning: root.zoning ?? null,
      landUse: baseFacts.landUse ?? null,
      yearBuilt: yearBuiltFromStructural(args.structural),
      anchor: anchorFromQueryPoint(args.queryPoint),
      boundary: boundaryInput(args.boundary),
      flood: floodInput(args.flood),
      envelopeRefusalReason,
      envelopeModelled,
      pipeline: pipelineInput(args.pipeline),
      well: wellInput(args.well),
      specialDistrict: specialDistrictInput(args.specialDistrict),
      buildingFootprint: args.buildingFootprint
        ? { state: args.buildingFootprint.state, source: args.buildingFootprint.source, sourceVintage: "sourceVintage" in args.buildingFootprint ? args.buildingFootprint.sourceVintage : null }
        : null,
    });
    return mergeOnRecordAttrs(
      draw,
      serializeTwinOnRecord(
        args.facets,
        args.parcelNodeId,
        args.grantsCadRollValuation,
      ),
    );
  } catch {
    return undefined;
  }
}
