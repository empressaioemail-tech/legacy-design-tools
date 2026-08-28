import { searchPlaceByPrefix } from "./txgioAddressResolve";
import type { QueryResolver, ResolveHit } from "./peScreenSave";

/** Existing situs resolver. Does not expand street-type abbreviations. */
export function cortexQueryResolver(): QueryResolver {
  return async (query: string): Promise<ResolveHit[]> => {
    const hits = await searchPlaceByPrefix({ query, limit: 10 });
    const out: ResolveHit[] = [];
    for (const hit of hits) {
      if (typeof hit.parcelNodeId === "string" && hit.parcelNodeId.trim()) {
        out.push({
          parcelNodeId: hit.parcelNodeId,
          label: hit.situsAddress,
        });
      }
    }
    return out;
  };
}
