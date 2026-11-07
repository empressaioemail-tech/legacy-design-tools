/**
 * Parse get_smart_site / research/brief args. Cap 50 refuses (no silent
 * truncate). hop1 and subgraph refuse as not_implemented.
 */

export const SMARTSITE_BATCH_CAP = 50;

export const SMARTSITE_DEPTHS = ["stub", "node", "hop1", "subgraph"] as const;
export type SmartSiteDepth = (typeof SMARTSITE_DEPTHS)[number];

export type SmartSiteBriefParse =
  | {
      ok: true;
      mode: "single" | "batch";
      ids: string[];
      depth: SmartSiteDepth;
      depthExplicit: boolean;
    }
  | {
      ok: false;
      error: "invalid_parcel_node_id" | "parcel_batch_cap" | "not_implemented";
      depth?: string;
      cap?: number;
      received?: number;
    };

function asIdList(raw: unknown): { ids: string[]; fromArray: boolean } | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { ids: [trimmed], fromArray: false } : null;
  }
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) return null;
    ids.push(trimmed);
  }
  return ids.length > 0 ? { ids, fromArray: true } : null;
}

export function parseSmartSiteBriefRequest(body: unknown): SmartSiteBriefParse {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const listed = asIdList(record?.parcelNodeId);
  if (!listed) {
    return { ok: false, error: "invalid_parcel_node_id" };
  }
  const { ids, fromArray } = listed;
  if (ids.length > SMARTSITE_BATCH_CAP) {
    return {
      ok: false,
      error: "parcel_batch_cap",
      cap: SMARTSITE_BATCH_CAP,
      received: ids.length,
    };
  }
  const rawDepth = record?.depth;
  let depth: SmartSiteDepth;
  let depthExplicit = false;
  if (rawDepth == null || rawDepth === "") {
    depth = fromArray ? "stub" : "node";
  } else if (
    rawDepth === "stub" ||
    rawDepth === "node" ||
    rawDepth === "hop1" ||
    rawDepth === "subgraph"
  ) {
    depth = rawDepth;
    depthExplicit = true;
  } else {
    return { ok: false, error: "invalid_parcel_node_id" };
  }
  if (depth === "hop1" || depth === "subgraph") {
    return { ok: false, error: "not_implemented", depth };
  }
  return {
    ok: true,
    mode: fromArray ? "batch" : "single",
    ids,
    depth,
    depthExplicit,
  };
}
