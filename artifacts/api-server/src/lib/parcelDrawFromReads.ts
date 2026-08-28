/**
 * Map live fact reads + bake facets onto assembleParcelDraw.
 * Serializer refuse → omit draw (fail closed). Never invent a ring.
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

function yearBuiltFromBake(facets: unknown): number | null {
  const root = asRecord(facets);
  const base = asRecord(root?.baseFacts);
  const raw = root?.yearBuilt ?? base?.yearBuilt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const rec = asRecord(raw);
  if (typeof rec?.v === "number" && Number.isFinite(rec.v)) return rec.v;
  return null;
}

function yearBuiltFromStructural(read: StructuralFactRead): number | null {
  if ("state" in read && read.state === "present") {
    return typeof read.yearBuilt === "number" && Number.isFinite(read.yearBuilt)
      ? read.yearBuilt
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
  return { state: read.state === "absent" ? "absent" : "refused" };
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
  return { state: read.state === "absent" ? "absent" : "refused" };
}

function wellInput(read: WellFactRead): AssembleParcelDrawInput["well"] {
  if (read.state === "present") return { state: "present" };
  if (read.state === "absent") return { state: "absent" };
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
  if (read.state === "absent") return { state: "absent" };
  return { state: "refused", code: read.code };
}

export function tryAssembleParcelDrawFromReads(args: {
  parcelNodeId: string;
  facets: unknown;
  bakedAt: string | null;
  envelopeBriefRefusal?: EnvelopeBriefRefusal | null;
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
      yearBuilt:
        yearBuiltFromStructural(args.structural) ?? yearBuiltFromBake(args.facets),
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
