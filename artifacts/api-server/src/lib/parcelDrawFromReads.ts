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
import {
  assembleParcelDraw,
  httpCitationUrls,
  type AssembleParcelDrawInput,
  type DrawFrameAnchor,
  type ParcelDrawStub,
} from "./parcelDrawStub";
import { firstPresentSitusLabel } from "./situsCompose";

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

function envelopeReason(refusal: EnvelopeBriefRefusal | null | undefined): string {
  if (!refusal) return "atom_path_pending";
  if (refusal.declineReason?.trim()) return refusal.declineReason.trim();
  if (refusal.code === "declined-in-bake") return "atom_path_pending";
  return refusal.code;
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

export function tryAssembleParcelDrawFromReads(args: {
  parcelNodeId: string;
  facets: unknown;
  bakedAt: string | null;
  envelopeBriefRefusal?: EnvelopeBriefRefusal | null;
  queryPoint?: { latitude: number; longitude: number } | null;
  boundary: BoundaryEdgeFactRead;
  flood: FloodHazardFactRead;
  pipeline: PipelineFactRead;
  well: WellFactRead;
  specialDistrict: SpecialDistrictFactRead;
  structural: StructuralFactRead;
}): ParcelDrawStub | undefined {
  const root = asRecord(args.facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  try {
    return assembleParcelDraw({
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
      envelopeRefusalReason: envelopeReason(args.envelopeBriefRefusal),
      pipeline: pipelineInput(args.pipeline),
      well: wellInput(args.well),
      specialDistrict: specialDistrictInput(args.specialDistrict),
    });
  } catch {
    return undefined;
  }
}
