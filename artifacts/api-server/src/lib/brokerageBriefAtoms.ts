/**
 * Atom projections for Property Brief — mirrors hauska-engine workspace shapes.
 * Response envelope only until cortex registry registers brokerage types.
 */

import { createHash } from "node:crypto";
import { pickFirstString } from "@workspace/adapters";
import type { BrokerageSiteContext } from "./brokerageSiteContext";
import { extractLlUuidFromPayload } from "./placeLayerUtils";
import type { PrivateRestrictionsBriefing } from "./encumbranceWire";

const REGRID_PARCEL_ID_KEYS = [
  "PARCEL_ID",
  "PARCELID",
  "APN",
  "PIN",
  "parcelnumb",
  "parcelnum",
] as const;

export interface BriefInlineRef {
  did: string;
  entityType: string;
  entityId: string;
  label: string;
  mode: "inline";
}

export interface BriefPlaceLayerRef {
  did: string;
  entityType: "place-layer-regrid" | "place-layer-fema";
  entityId: string;
  adapterKey: string;
  layerKind: string;
  status: string;
}

export interface BriefCitationRef {
  citationDid: string;
  sourceType: "atom";
}

export interface BriefAtomProjection {
  workspaceDid: string;
  briefRunDid: string;
  placeLayers: BriefPlaceLayerRef[];
  citationRefs: BriefCitationRef[];
  inlineRefs: BriefInlineRef[];
}

function shaSegment(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function buildPropertyWorkspaceDid(listingKey: string): string {
  return `did:hauska:property-workspace:${listingKey}`;
}

export function buildBriefRunDid(runId: string): string {
  return `did:hauska:brief-run:${runId}`;
}

export function buildPlaceLayerDid(
  layerKind: string,
  placeKey: string,
): string {
  return `did:hauska:place-layer:${layerKind}:${shaSegment(`${placeKey}|${layerKind}`)}`;
}

export function buildCodeSectionDid(atomId: string): string {
  if (atomId.startsWith("did:")) return atomId;
  return `did:hauska:code-section:${atomId}`;
}

export function buildBriefAtomProjection(input: {
  listingKey: string;
  runId: string;
  address: string;
  siteContext: BrokerageSiteContext;
  citations: Array<{ atomDid: string; query: string; snippet: string }>;
  placeKey: string;
  privateRestrictions?: PrivateRestrictionsBriefing | null;
}): BriefAtomProjection {
  const workspaceDid = buildPropertyWorkspaceDid(input.listingKey);
  const briefRunDid = buildBriefRunDid(input.runId);

  const placeLayers: BriefPlaceLayerRef[] = [];
  for (const layer of input.siteContext.layers) {
    const entityType =
      layer.layerKind.startsWith("regrid") || layer.adapterKey.startsWith("regrid:")
        ? "place-layer-regrid"
        : "place-layer-fema";
    placeLayers.push({
      did: buildPlaceLayerDid(layer.layerKind, input.placeKey),
      entityType,
      entityId: `${input.placeKey}/${layer.layerKind}`,
      adapterKey: layer.adapterKey,
      layerKind: layer.layerKind,
      status: layer.status,
    });
  }

  const citationRefs: BriefCitationRef[] = input.citations.map((c) => ({
    citationDid: buildCodeSectionDid(c.atomDid),
    sourceType: "atom" as const,
  }));

  const inlineRefs: BriefInlineRef[] = [];
  for (const c of input.citations.slice(0, 3)) {
    inlineRefs.push({
      did: buildCodeSectionDid(c.atomDid),
      entityType: "code-section",
      entityId: c.atomDid,
      label: c.query.slice(0, 48),
      mode: "inline",
    });
  }

  const regridParcel = input.siteContext.layers.find(
    (l) => l.layerKind === "regrid-parcel" && l.status === "ok" && l.payload,
  );
  if (regridParcel?.payload) {
    const llUuid = extractLlUuidFromPayload(regridParcel.payload);
    if (llUuid) {
      const fields = (
        regridParcel.payload.parcel as
          | { properties?: { fields?: Record<string, unknown> } }
          | undefined
      )?.properties?.fields;
      const apn = fields ? pickFirstString(fields, REGRID_PARCEL_ID_KEYS) : null;
      inlineRefs.push({
        did: `did:hauska:parcel:${llUuid}`,
        entityType: "parcel",
        entityId: llUuid,
        label: apn ? `Parcel APN ${apn}` : "Parcel record",
        mode: "inline",
      });
    }
  }

  for (const item of input.privateRestrictions?.items.slice(0, 2) ?? []) {
    inlineRefs.push({
      did: `did:hauska:restriction-clause:${item.clauseId}`,
      entityType: "restriction-clause",
      entityId: item.clauseId,
      label: item.clausePath.slice(0, 48),
      mode: "inline",
    });
  }

  return {
    workspaceDid,
    briefRunDid,
    placeLayers,
    citationRefs,
    inlineRefs,
  };
}

export function extractLlUuidFromSiteContext(
  siteContext: BrokerageSiteContext,
): string | null {
  for (const layer of siteContext.layers) {
    if (layer.layerKind !== "regrid-parcel" || !layer.payload) continue;
    const id = extractLlUuidFromPayload(layer.payload);
    if (id) return id;
  }
  return null;
}
