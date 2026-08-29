import { parseParcelNodeId } from "./parcelNodeId";

export type ScreenResolveHit = { parcelNodeId: string; label: string };

export type ScreenSitusSearch = (input: {
  query: string;
  limit?: number;
}) => Promise<Array<{ parcelNodeId?: string | null; situsAddress?: string | null }>>;

/** Node-id queries skip situs search. A junk string stays on the search path. */
export async function resolveScreenQuery(
  query: string,
  search: ScreenSitusSearch,
): Promise<ScreenResolveHit[]> {
  const trimmed = query.trim();
  if (parseParcelNodeId(trimmed)) {
    return [{ parcelNodeId: trimmed, label: trimmed }];
  }
  const hits = await search({ query: trimmed, limit: 10 });
  const out: ScreenResolveHit[] = [];
  for (const hit of hits) {
    if (typeof hit.parcelNodeId === "string" && hit.parcelNodeId.trim()) {
      out.push({
        parcelNodeId: hit.parcelNodeId,
        label: hit.situsAddress ?? hit.parcelNodeId,
      });
    }
  }
  return out;
}
