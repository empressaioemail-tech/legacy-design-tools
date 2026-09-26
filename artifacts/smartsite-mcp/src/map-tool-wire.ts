/**
 * P-446. Wire find_parcel / find_parcels bodies for the MCP App map panel.
 */

function mapWireEnabled(): boolean {
  return process.env.SMARTSITE_MAP_WIRE !== "0";
}

import type { CortexClientConfig } from "./cortex-client.js";
import { cortexFetch } from "./cortex-client.js";
import { cardViewFromToolPayload, injectCardContract } from "./card-contract.js";
import { mapGroundReasonWords } from "./map-reason-words.js";
import { LIST_NODE_DEPTH_CAP } from "./map-reliability.js";
import {
  attachAnchorToResponseText,
  attachBatchAnchorsToResponseText,
  readParcelAnchor,
  readParcelAnchorsForBatch,
} from "./parcel-anchor.js";
import {
  mapGetSmartSiteNonOk,
  normalizeGetSmartSiteResponseText,
} from "./tool-honesty.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parcelIdsFromHits(hits: unknown): string[] {
  if (!Array.isArray(hits)) return [];
  const out: string[] = [];
  for (const raw of hits) {
    const hit = asRecord(raw);
    const id = hit && typeof hit.parcelNodeId === "string" ? hit.parcelNodeId : "";
    if (id.length > 0) out.push(id);
  }
  return out;
}

function parcelIdsFromMatched(matched: unknown): string[] {
  if (!Array.isArray(matched)) return [];
  const out: string[] = [];
  for (const raw of matched) {
    const row = asRecord(raw);
    const id = row && typeof row.parcelNodeId === "string" ? row.parcelNodeId : "";
    if (id.length > 0) out.push(id);
  }
  return out;
}

function withMapNote(body: Record<string, unknown>, reason: string): Record<string, unknown> {
  return {
    ...body,
    mapPanelNote: mapGroundReasonWords(reason),
    mapPanelReason: reason,
  };
}

async function fetchNodeBriefWire(
  config: CortexClientConfig,
  userId: string,
  ids: string[],
  canSeeOwner: boolean,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (ids.length === 0) return { ok: false, reason: "map_no_parcel_hits" };
  const capIds = ids.slice(0, LIST_NODE_DEPTH_CAP);
  const res = await cortexFetch(config, `/api/property-explorer/v1/research/brief`, {
    method: "POST",
    userId,
    body: JSON.stringify({ parcelNodeId: capIds.length === 1 ? capIds[0] : capIds, depth: "node" }),
  });
  const body = await res.text();
  if (!res.ok) {
    const declared = mapGetSmartSiteNonOk(res.status, body, capIds);
    if (declared) return { ok: false, reason: "map_wiring_failed" };
    return { ok: false, reason: "map_wiring_failed" };
  }
  const normalized = normalizeGetSmartSiteResponseText(
    body,
    capIds.length === 1 ? "single-node" : "stub-or-batch",
    canSeeOwner,
  );
  if (capIds.length === 1) {
    const anchorOutcome = await readParcelAnchor(config, capIds[0]!);
    const text = attachAnchorToResponseText(normalized, anchorOutcome);
    return { ok: true, text };
  }
  const batchOutcome = await readParcelAnchorsForBatch(config, capIds);
  const text = attachBatchAnchorsToResponseText(normalized, batchOutcome);
  return { ok: true, text };
}

/** Merge find_parcel JSON with node-depth draw wire when hits exist. */
export async function wireFindParcelForMap(
  config: CortexClientConfig,
  userId: string,
  bodyText: string,
  canSeeOwner: boolean,
): Promise<string> {
  if (!mapWireEnabled()) return bodyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  const rec = asRecord(parsed);
  if (!rec) return bodyText;

  const ids = parcelIdsFromHits(rec.hits);
  if (ids.length === 0) {
    const missClass = typeof rec.missClass === "string" ? rec.missClass : "no-hit";
    const reason =
      missClass === "located-unbound" || (Array.isArray(rec.located) && rec.located.length > 0)
        ? "map_located_unbound"
        : "map_no_parcel_hits";
    const view = cardViewFromToolPayload("find_parcel", withMapNote(rec, reason));
    return injectCardContract(JSON.stringify(withMapNote(rec, reason)), view).text;
  }

  const wired = await fetchNodeBriefWire(config, userId, ids, canSeeOwner);
  if (!wired.ok) {
    const merged = withMapNote({ ...rec, mapWiring: "failed" }, wired.reason);
    const view = cardViewFromToolPayload("find_parcel", merged);
    return injectCardContract(JSON.stringify(merged), view).text;
  }

  let briefRec: Record<string, unknown>;
  try {
    briefRec = JSON.parse(wired.text) as Record<string, unknown>;
  } catch {
    const merged = withMapNote({ ...rec, mapWiring: "failed" }, "map_wiring_failed");
    return injectCardContract(JSON.stringify(merged), "none").text;
  }
  const merged = { ...rec, ...briefRec, findParcelHits: rec.hits };
  const view = cardViewFromToolPayload("find_parcel", merged);
  return injectCardContract(JSON.stringify(merged), view).text;
}

/** Merge find_parcels JSON with node-depth draw for matched parcels (capped). */
export async function wireFindParcelsForMap(
  config: CortexClientConfig,
  userId: string,
  bodyText: string,
  canSeeOwner: boolean,
): Promise<string> {
  if (!mapWireEnabled()) return bodyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  const rec = asRecord(parsed);
  if (!rec) return bodyText;

  const ids = parcelIdsFromMatched(rec.matched);
  if (ids.length === 0) {
    const merged = withMapNote(rec, "map_no_parcel_hits");
    const view = cardViewFromToolPayload("find_parcels", merged);
    return injectCardContract(JSON.stringify(merged), view).text;
  }

  const wired = await fetchNodeBriefWire(config, userId, ids, canSeeOwner);
  if (!wired.ok) {
    const merged = withMapNote({ ...rec, mapWiring: "failed" }, wired.reason);
    const view = cardViewFromToolPayload("find_parcels", merged);
    return injectCardContract(JSON.stringify(merged), view).text;
  }

  let briefRec: Record<string, unknown>;
  try {
    briefRec = JSON.parse(wired.text) as Record<string, unknown>;
  } catch {
    const merged = withMapNote({ ...rec, mapWiring: "failed" }, "map_wiring_failed");
    return injectCardContract(JSON.stringify(merged), "none").text;
  }
  const merged = {
    ...rec,
    ...briefRec,
    constraintMatched: rec.matched,
    constraintExcluded: rec.excluded,
    constraintNotEvaluated: rec.notEvaluated,
  };
  const view = cardViewFromToolPayload("find_parcels", merged);
  return injectCardContract(JSON.stringify(merged), view).text;
}

function parcelIdsFromNearestParcels(parcels: unknown): string[] {
  if (!Array.isArray(parcels)) return [];
  const out: string[] = [];
  for (const raw of parcels) {
    const row = asRecord(raw);
    const id = row && typeof row.parcelNodeId === "string" ? row.parcelNodeId : "";
    if (id.length > 0) out.push(id);
  }
  return out;
}

/** Merge nearest-parcels JSON with node-depth draw for map panel (capped). */
export async function wireFindNearestParcelsForMap(
  config: CortexClientConfig,
  userId: string,
  bodyText: string,
  canSeeOwner: boolean,
): Promise<string> {
  if (!mapWireEnabled()) {
    try {
      const raw = asRecord(JSON.parse(bodyText));
      const stamped = raw
        ? {
            ...raw,
            nearestNeighbors: raw.parcels,
            nearestSubjectParcelNodeId: raw.subjectParcelNodeId,
          }
        : JSON.parse(bodyText);
      return JSON.stringify(stripNearestOwnerAndDollars(stamped));
    } catch {
      return bodyText;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  const rec = asRecord(parsed);
  if (!rec) return bodyText;

  const ids = parcelIdsFromNearestParcels(rec.parcels);
  if (ids.length === 0) {
    const merged = stripNearestOwnerAndDollars(
      withMapNote(
        {
          ...rec,
          nearestNeighbors: rec.parcels,
          nearestSubjectParcelNodeId: rec.subjectParcelNodeId,
        },
        "map_no_parcel_hits",
      ),
    ) as Record<string, unknown>;
    const view = cardViewFromToolPayload("find_nearest_parcels", merged);
    return injectCardContract(JSON.stringify(merged), view).text;
  }

  const wired = await fetchNodeBriefWire(config, userId, ids, false);
  if (!wired.ok) {
    const merged = stripNearestOwnerAndDollars(
      withMapNote(
        {
          ...rec,
          mapWiring: "failed",
          nearestNeighbors: rec.parcels,
          nearestSubjectParcelNodeId: rec.subjectParcelNodeId,
        },
        wired.reason,
      ),
    ) as Record<string, unknown>;
    const view = cardViewFromToolPayload("find_nearest_parcels", merged);
    return injectCardContract(JSON.stringify(merged), view).text;
  }

  let briefRec: Record<string, unknown>;
  try {
    briefRec = JSON.parse(wired.text) as Record<string, unknown>;
  } catch {
    const merged = stripNearestOwnerAndDollars(
      withMapNote(
        {
          ...rec,
          mapWiring: "failed",
          nearestNeighbors: rec.parcels,
          nearestSubjectParcelNodeId: rec.subjectParcelNodeId,
        },
        "map_wiring_failed",
      ),
    ) as Record<string, unknown>;
    return injectCardContract(JSON.stringify(merged), "none").text;
  }
  const nearestList = rec.parcels;
  const merged = stripNearestOwnerAndDollars({
    ...briefRec,
    ...rec,
    parcels: Array.isArray(briefRec.parcels) ? briefRec.parcels : nearestList,
    nearestSubjectParcelNodeId: rec.subjectParcelNodeId,
    nearestNeighbors: nearestList,
    mapParcels: briefRec.parcels,
  });
  const view = cardViewFromToolPayload(
    "find_nearest_parcels",
    merged as Record<string, unknown>,
  );
  return injectCardContract(JSON.stringify(merged), view).text;
}

const NEAREST_DOLLAR_KEYS = new Set([
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "cadRoll",
]);

/** Catalog contract: this tool returns no owner or dollar field at any tier. */
export function stripNearestOwnerAndDollars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNearestOwnerAndDollars);
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rec)) {
    if (key === "ownerFact" || key === "ownerName" || key === "ownerMailingAddress") {
      continue;
    }
    if (NEAREST_DOLLAR_KEYS.has(key)) continue;
    out[key] = stripNearestOwnerAndDollars(child);
  }
  return out;
}
