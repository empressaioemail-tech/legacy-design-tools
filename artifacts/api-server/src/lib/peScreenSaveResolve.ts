import { searchPlaceByPrefix } from "./txgioAddressResolve";
import type { QueryResolver, ResolveHit } from "./peScreenSave";
import { resolveScreenQuery } from "./peScreenSaveResolveCore";

/** Existing situs resolver. Does not expand street-type abbreviations. */
export function cortexQueryResolver(): QueryResolver {
  return async (query: string): Promise<ResolveHit[]> =>
    resolveScreenQuery(query, async (input) => {
      const result = await searchPlaceByPrefix(input);
      return result.hits;
    });
}
