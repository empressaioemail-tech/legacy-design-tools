/**
 * Atom projections for Property Brief — mirrors hauska-engine workspace shapes.
 * Response envelope only until cortex registry registers brokerage types.
 */

import { createHash } from "node:crypto";
import { pickFirstString } from "@workspace/adapters";
import {
  canonicalOverlayAtomKey,
  toHauskaCodeSectionDid,
} from "@workspace/codes";
import type { BrokerageSiteContext } from "./brokerageSiteContext";
import { extractClipFromSiteContext } from "./brokerageParcelKey";
import type { PrivateRestrictionsBriefing } from "./encumbranceWire";

const COTALITY_PARCEL_ID_KEYS = [
  "PARCEL_ID",
  "PARCELID",
  "APN",
  "PIN",
  "parcelnumb",
  "parcelnum",
  "clip",
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
  entityType: "place-layer-cotality" | "place-layer-fema" | "place-layer-oz";
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
  return toHauskaCodeSectionDid(atomId);
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
    const entityType = layer.layerKind.startsWith("opportunity-zone")
      ? "place-layer-oz"
      : layer.adapterKey.includes("fema")
        ? "place-layer-fema"
        : "place-layer-cotality";
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
    const canonicalId = canonicalOverlayAtomKey(c.atomDid);
    inlineRefs.push({
      did: buildCodeSectionDid(c.atomDid),
      entityType: "code-section",
      entityId: canonicalId,
      label: c.query.slice(0, 48),
      mode: "inline",
    });
  }

  const clip =
    input.siteContext.parcelClip ??
    extractClipFromSiteContext(input.siteContext.layers);
  if (clip) {
    const parcelLayer = input.siteContext.layers.find(
      (l) => l.layerKind === "cotality-parcel" && l.status === "ok" && l.payload,
    );
    const fields =
      (
        parcelLayer?.payload?.parcel as
          | { properties?: Record<string, unknown> }
          | undefined
      )?.properties ?? {};
    const apn = pickFirstString(fields, COTALITY_PARCEL_ID_KEYS);
    inlineRefs.push({
      did: `did:hauska:parcel:${clip}`,
      entityType: "parcel",
      entityId: clip,
      label: apn ? `Parcel CLIP ${clip} (APN ${apn})` : `Parcel CLIP ${clip}`,
      mode: "inline",
    });
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

/** @deprecated Use extractClipFromSiteContext — Regrid ll_uuid removed. */
export function extractLlUuidFromSiteContext(
  siteContext: BrokerageSiteContext,
): string | null {
  return (
    siteContext.parcelClip ?? extractClipFromSiteContext(siteContext.layers)
  );
}
