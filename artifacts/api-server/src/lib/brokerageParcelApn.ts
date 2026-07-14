/**
 * Minimal county-GIS APN point lookup for the provider-neutral parcel key.
 *
 * The implementation moved to `@workspace/adapters/txCountyApn` (verbatim)
 * so the `cad:*` Property Brief adapters in `lib/adapters` and this
 * parcel-key capture path share ONE county routing table — the unification
 * this module's original docstring promised. This file stays as a thin
 * re-export so #243's call sites (`brokerageParcelKey.ts`, tests) keep
 * their import path.
 */

export {
  COUNTY_APN_SOURCES,
  resolveCountyApnSource,
  resolveCountyApnByPoint,
  type CountyApnSource,
  type CountyApnResolution,
} from "@workspace/adapters/txCountyApn";
