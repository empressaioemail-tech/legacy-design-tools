import {
  lookupParcelNodeForScreen,
  searchPlaceByPrefix,
} from "./txgioAddressResolve";
import type { NodeLookup, QueryResolver, ResolveHit } from "./peScreenSave";
import { resolveScreenQuery } from "./peScreenSaveResolveCore";

/** Existing situs resolver. Does not expand street-type abbreviations. */
export function cortexQueryResolver(): QueryResolver {
  return async (query: string): Promise<ResolveHit[]> =>
    resolveScreenQuery(
      query,
      async (input) => {
        const result = await searchPlaceByPrefix(input);
        return result.hits;
      },
      async (parcelNodeId) => lookupParcelNodeForScreen({ parcelNodeId }),
    );
}

/** add_to_screen existence check. Same lookup as create_screen node ids. */
export function cortexNodeLookup(): NodeLookup {
  return (parcelNodeId) => lookupParcelNodeForScreen({ parcelNodeId });
}
