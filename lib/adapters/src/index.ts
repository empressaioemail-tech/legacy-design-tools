/**
 * Public surface of `@workspace/adapters` — DA-PI-4.
 *
 * The api-server's generate-layers route imports {@link runAdapters},
 * {@link ALL_ADAPTERS}, and {@link resolveJurisdiction}. UI code that
 * needs to render a setback table imports the loaders from
 * `./local/setbacks`.
 */

export {
  type Adapter,
  type AdapterContext,
  type AdapterError,
  type AdapterJurisdiction,
  type AdapterLocalKey,
  type AdapterParcelContext,
  type AdapterResult,
  type AdapterRunOutcome,
  type AdapterSourceKind,
  type AdapterStateKey,
  type AdapterTier,
  AdapterRunError,
} from "./types";

export { runAdapters, type RunAdaptersInput } from "./runner";

export {
  toCacheKey,
  CACHE_COORDINATE_PRECISION,
  FEDERAL_TIER_CACHE_PREDICATE,
  type AdapterCacheKey,
  type AdapterCachePredicate,
  type AdapterResultCache,
} from "./cache";

export {
  ALL_ADAPTERS,
  FEDERAL_ADAPTERS,
  STATE_ADAPTERS,
  LOCAL_ADAPTERS,
} from "./registry";

export {
  resolveJurisdiction,
  type ResolveJurisdictionInput,
} from "./jurisdictionResolver";

export {
  getSetbackTable,
  getSetbackDistrict,
  listSetbackTables,
  SETBACK_JURISDICTION_KEYS,
  type SetbackTable,
  type SetbackDistrict,
} from "./local/setbacks";
