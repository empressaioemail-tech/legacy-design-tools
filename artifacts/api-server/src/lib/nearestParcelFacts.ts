/**
 * Stub facts for nearest-parcel hits: situs, acreage, zoning, land use, flood.
 * Never attaches owner or CAD dollar fields (stub depth only).
 */

import { loadBakedNodeFacetSnapshot } from "../routes/brokerageNodeFacets";
import { readSmartSiteStub, type StubModeProbe } from "./smartSiteStubServe";
import { oneDoorAcreage } from "./oneDoor/oneDoorStub";
import type { SmartSiteRailState } from "./smartSiteStub";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function acreageFromFacets(facets: unknown): {
  acres: number | null;
  state: SmartSiteRailState;
} {
  const base = asRecord(asRecord(facets)?.baseFacts);
  const leaf = base?.acreage;
  const rec = asRecord(leaf);
  if (rec && typeof rec.value === "number" && Number.isFinite(rec.value)) {
    return { acres: rec.value, state: "present" };
  }
  if (rec && rec.kind === "absent-verified") {
    return { acres: null, state: "absent-verified" };
  }
  if (rec && rec.kind === "refused") {
    return { acres: null, state: "refused" };
  }
  return { acres: null, state: "unknown" };
}

export type NearestParcelFactRow = {
  parcelNodeId: string;
  distanceFt: number;
  label: string;
  situs: SmartSiteRailState;
  acreageAcres: number | null;
  acreage: SmartSiteRailState;
  zoning: SmartSiteRailState;
  landUse: SmartSiteRailState;
  flood: SmartSiteRailState;
  url: string;
};

export async function loadNearestParcelFactRow(input: {
  parcelNodeId: string;
  distanceFt: number;
  /** One probe per nearest request (see `StubModeProbe`). */
  probe?: StubModeProbe;
}): Promise<NearestParcelFactRow | null> {
  const read = await readSmartSiteStub(input.parcelNodeId, input.probe);
  if (read.kind !== "stub") return null;
  const stub = read.stub;
  // ONE DOOR `on`: acreage is the reader's `acreageAcres`; no bake read.
  const acreage = read.record
    ? oneDoorAcreage(read.record)
    : acreageFromFacets((await loadBakedNodeFacetSnapshot(input.parcelNodeId))?.facets ?? null);
  return {
    parcelNodeId: stub.parcelNodeId,
    distanceFt: input.distanceFt,
    label: stub.label,
    situs: stub.situs,
    acreageAcres: acreage.acres,
    acreage: acreage.state,
    zoning: stub.zoning,
    landUse: stub.landUse,
    flood: stub.flood,
    url: stub.url,
  };
}
