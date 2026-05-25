import {
  filterJurisdictionsByKeys,
  filterJurisdictionsBySearch,
  filterJurisdictionsByStates,
  parseKeysParam,
  parseStateListParam,
  type JurisdictionLike,
} from "@workspace/coverage";
import type { SubstrateCatalog, SubstrateJurisdiction } from "../lib/hauskaSubstrateClient";

export function filterSubstrateCatalog(
  catalog: SubstrateCatalog,
  query: {
    states?: string;
    keys?: string;
    q?: string;
  },
): SubstrateCatalog {
  const total = catalog.jurisdictions.length;
  let rows: SubstrateJurisdiction[] = [...catalog.jurisdictions];

  const stateSet = parseStateListParam(query.states);
  if (stateSet.size > 0) {
    rows = filterJurisdictionsByStates(rows, stateSet);
  }

  const keySet = parseKeysParam(query.keys);
  if (keySet.size > 0) {
    rows = filterJurisdictionsByKeys(rows, keySet);
  }

  const search = (query.q ?? "").trim();
  if (search) {
    rows = filterJurisdictionsBySearch(rows, search);
  }

  return {
    source: catalog.source,
    jurisdictions: rows,
    total,
    filtered: rows.length,
  };
}
