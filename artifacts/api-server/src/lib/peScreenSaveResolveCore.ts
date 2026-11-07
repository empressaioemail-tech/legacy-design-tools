import { parseParcelNodeId } from "./parcelNodeId";

export type ScreenResolveHit = { parcelNodeId: string; label: string };

export type ScreenSitusSearch = (input: {
  query: string;
  limit?: number;
}) => Promise<Array<{ parcelNodeId?: string | null; situsAddress?: string | null }>>;

export type ScreenNodeLookup = (
  parcelNodeId: string,
) => Promise<ScreenResolveHit | null>;

/**
 * Node-id queries skip situs search and ask the store whether the parcel
 * row exists. A junk string stays on the search path.
 *
 * A lookup that throws propagates. The store did not answer, which is not
 * an absence: answering [] here wrote a durable unresolved row on pool
 * exhaustion, statement timeout, or a dead Neon endpoint, and the
 * idempotent short-circuit then served that false miss on every later add.
 * The caller (resolveQueryRow) turns the throw into a refuse of the create.
 */
export async function resolveScreenQuery(
  query: string,
  search: ScreenSitusSearch,
  lookup: ScreenNodeLookup,
): Promise<ScreenResolveHit[]> {
  const trimmed = query.trim();
  if (parseParcelNodeId(trimmed)) {
    const hit = await lookup(trimmed);
    return hit ? [hit] : [];
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
