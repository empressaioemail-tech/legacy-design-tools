/**
 * Tier-1 facet payload ASSEMBLY, shared by the legacy txgio-keyed bake
 * (`../nodeFacetBakeTier1Cli.ts`) and the conformant-v1 publish bake
 * (`../nodeFacetBakeTier1ConformantCli.ts`, through
 * `./nodeFacetBakeTier1Conformant.ts`).
 *
 * Extracted 2026-08-28 (OPS-19 A-025, CTX card E). The conformant bake had
 * projected `facets.base.{apn,parcelNodeId,situsAddress}` and nothing else,
 * while the old bake joined the zoning stamp, derived the (declined) envelope,
 * computed acreage and carried the CAD land-use; the Property Explorer renders
 * from those keys, so every parcel published on the conformant shape read
 * "not verified here" where the day before it read a district. This module is
 * the ONE derivation both bakes run: zoning from the same stamp resolution,
 * envelope from the same `computeTier1Envelope`, acreage from the same
 * shoelace, coverage flags from the same predicates, provenance in the same
 * slots. Reuse is by import; there is no second copy to drift.
 *
 * DB-free and entrypoint-free ON PURPOSE. The old CLI's `isDirectRun()` guard
 * compares `argv[1]` with `import.meta.url`; inside the hauska-factory esbuild
 * publish bundle (`scripts/build-publish-bake-clis.mjs` emits ONE file per
 * CLI) those are the same file, so importing the old CLI module from the
 * conformant CLI would run the old bake's `main()` against DATABASE_URL. The
 * conformant path therefore imports this module and never the old CLI (the
 * same hazard `./nodeFacetTier1Constants.ts` documents for the server boot
 * graph).
 */

import type { CadRollBaked } from "./cadRollValue";
import {
  computeTier1Envelope,
  parcelAcreage,
  type Ring,
  type Tier1EnvelopeFacet,
} from "./nodeFacetBakeTier1";
import { LANDUSE_JOIN_DISABLED_FIPS_SEED } from "./joinNormalize";
import { resolveZoningJurisdiction } from "@workspace/cad-ingest/zoning-layers";
import {
  resolveZoningLayerForDistrict,
  zoningProvenanceFromLayer,
  type ZoningGisProvenance,
} from "./zoningProvenance";

export type { Ring, Tier1EnvelopeFacet };

/** Schema version the legacy txgio-keyed bake stamps. */
export const TIER1_FACET_SCHEMA_VERSION = "node-facets-tier1-v1";

// The ten Central-TX counties unified in the parcel fabric (Wave D1/D2).
// Nine carry (or can carry) a CAD land-use roll; Comal (48091) is geometry-
// only (no roll loaded) and bakes honestly land-use-absent.
export const COUNTY_NAMES: Record<string, string> = {
  "48209": "Hays",
  "48091": "Comal",
  "48453": "Travis",
  "48491": "Williamson",
  "48029": "Bexar",
  "48021": "Bastrop",
  "48055": "Caldwell",
  "48187": "Guadalupe",
  "48027": "Bell",
  "48309": "McLennan",
};

/** The provenance of a recovered land-use — prop_id join vs address recovery. */
export type LandUseSource = "cad-roll" | "cad-roll-address-join";

/**
 * How an acreage value was obtained. `shoelace-wgs84` is the parcel ring
 * (both bakes); `cad-roll-land-acres` is the conformant claim's declared
 * `landAcres`, used ONLY when the bake holds no ring, so a reader can tell a
 * measured value from a declared one.
 */
export type AcreageMethod = "shoelace-wgs84" | "cad-roll-land-acres";

/** Where the parcel identity in `baseFacts` came from. */
export type ParcelSource = "txgio" | "conformant-v1-cad-parcel-roll";

export interface BaseFacts {
  apn: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  situsState: string | null;
  /**
   * Situs (postal) ZIP as the source carries it: the conformant claim's
   * `situsZip`, the txgio row's `situs_zip`. Explicit null when the source
   * has none (CTX card F, 2026-08-28). Like `situsCity` this is a postal
   * fact and is never read as incorporation; the serve derives that from
   * city-limits containment.
   */
  situsZip: string | null;
  landUse: {
    code: string;
    description: string | null;
    /**
     * How the land-use was joined. `cad-roll` is the normal prop_id join
     * (and, on the conformant path, the claim's own `propertyUseCode`);
     * `cad-roll-address-join` is the situs-address RECOVERY join used for
     * prop_id-gate-blocked counties (Williamson/Hays), where each accepted
     * match ALSO passed the per-match owner gate. The distinct value lets the
     * card/ledger show HOW the land-use was verified.
     */
    source: LandUseSource;
    /** CAD vintage string, or the tax year; null when the source carried none. */
    vintage: string | null;
  } | null;
  acreage: { value: number; sqft: number; method: AcreageMethod } | null;
  /**
   * County-assessed roll values from the conformant claim. Each field is the
   * claim's value or null; nothing is defaulted and zero is never invented.
   */
  cadRoll: CadRollBaked;
}

export interface Tier1FacetPayload {
  facetSchemaVersion: string;
  tier: 1;
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  baseFacts: BaseFacts;
  zoning: {
    district: string;
    /** Hyphen or underscore cityKey from PIP stamp / situs fallback. */
    jurisdictionKey?: string | null;
    /**
     * GIS origin for the district FACT (ZONING_LAYERS layer). Required when
     * district is present — breadth bake is a TRANSFORM, not the source
     * (COMPLETE-BASTROP A1 / S-01/S-02).
     */
    provenance?: ZoningGisProvenance;
  } | null;
  envelope: Tier1EnvelopeFacet | null;
  /**
   * Per-facet presence, the load-bearing input to the monotonic scorer. A
   * true means the facet resolved to real content; a false means honest
   * absence (no fabrication). `envelope` counts as present only when it
   * derived a real (or honestly-empty) envelope, not when it declined for a
   * missing table/district.
   */
  facetCoverage: {
    baseFacts: boolean;
    landUse: boolean;
    acreage: boolean;
    zoning: boolean;
    envelope: boolean;
  };
  provenance: {
    parcelSource: ParcelSource;
    parcelVintage: string | null;
    landUseSource: LandUseSource | null;
    /**
     * True when this node's land-use was recovered via the situs-ADDRESS join
     * (a prop_id-gate-blocked county) rather than the normal prop_id join, and
     * the match passed the per-match owner gate. Distinguishes an address-join
     * land-use from a prop_id-join one at a glance (the ledger/card verification
     * story). False for a normal prop_id-join land-use or an absent one.
     */
    landUseAddressRecovered: boolean;
    roadsPending: true;
    tierNote: string;
    /**
     * True when this county's land-use join is BLOCKED by the owner-match
     * integrity gate (ledger `block` verdict / seed). The load-bearing signal
     * for the monotonic INTEGRITY OVERRIDE: a gate-blocked re-bake must be
     * allowed to strip a previously-promoted (now-known-fabricated) land-use
     * even though dropping the facet lowers the monotonic score. See
     * `shouldPromote` in the old CLI.
     */
    landUseGateBlocked: boolean;
    /**
     * Top-level twin of zoning.provenance.sourceUrl when a district is
     * present (COMPLETE-BASTROP A1). Null when zoning is honestly absent.
     */
    zoningSource: string | null;
  };
  bakedAt: string;
}

/**
 * First outer ring (lng/lat) out of a GeoJSON Polygon | MultiPolygon
 * geometry. Null when the geometry is not a usable polygon.
 */
export function firstRing(geometry: unknown): Ring | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g) return null;
  let ring: unknown = null;
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    ring = g.coordinates[0];
  } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const first = g.coordinates[0];
    ring = Array.isArray(first) ? first[0] : null;
  }
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring as Ring;
}

/**
 * The EFFECTIVE land-use block set the bakes act on: the ledger's computed
 * `block` verdicts UNION the known-fabricated bootstrap seed
 * (`LANDUSE_JOIN_DISABLED_FIPS_SEED`). The seed is a PERMANENT FLOOR — a
 * county in the seed is blocked even if the ledger scores it something other
 * than `block` (e.g. Williamson 48491 scores `insufficient-sample` after the
 * R-strip removal drops its real pairs to ~0, so it is NOT a ledger `block`,
 * yet it is a known fabrication that must never re-acquire a land-use). The
 * ledger ADDS to the seed; it never replaces it.
 *
 * This union drives BOTH the honest-absence join (via `landUseJoinKey`) AND
 * `provenance.landUseGateBlocked` (which arms the fabrication-correction
 * override) in the old bake, and the txgio parcel-join gate in the conformant
 * bake (a CAD prop_id joined into a divergent TxGIO numbering attaches
 * another parcel's zoning and geometry).
 */
export function effectiveBlockedFips(
  ledgerBlocked: ReadonlySet<string>,
): Set<string> {
  return new Set<string>([...ledgerBlocked, ...LANDUSE_JOIN_DISABLED_FIPS_SEED]);
}

const TIER_NOTE =
  "Tier 1 (deterministic). Buildable envelope product path retired " +
  "(anti-zombie / atom_path_pending) — read envelope from property atom " +
  "chain. Tier 2 may still carry flood overlay.";

export interface Tier1AssemblyInput {
  nodeId: string;
  countyFips: string;
  countyName: string;
  /** Defaults to the legacy `node-facets-tier1-v1`. */
  facetSchemaVersion?: string;
  apn: string | null | undefined;
  situsAddress: string | null | undefined;
  situsCity: string | null | undefined;
  situsState: string | null | undefined;
  /** Source-carried situs ZIP; null bakes an explicit null (never omitted). */
  situsZip: string | null | undefined;
  /** Already-resolved land-use facet (the caller owns the join or the claim). */
  landUse: BaseFacts["landUse"];
  /** CAD roll values from the conformant claim (all keys, null when absent). */
  cadRoll: CadRollBaked;
  landUseAddressRecovered: boolean;
  landUseGateBlocked: boolean;
  /** Parcel ring; null bakes acreage/envelope honestly absent. */
  ring: Ring | null;
  /**
   * Acreage to carry ONLY when there is no ring. Never overrides the shoelace
   * on a ring; a degenerate ring still bakes null (as the old bake did).
   */
  acreageWithoutRing?: BaseFacts["acreage"];
  /** Raw stored `zoning_district` column value (verbatim; honest null). */
  zoningDistrictRaw: string | null | undefined;
  /** Raw stored `zoning_jurisdiction` (PIP cityKey); situs city is the fallback. */
  zoningJurisdictionRaw: string | null | undefined;
  parcelSource: ParcelSource;
  parcelVintage: string | null | undefined;
  nowIso: string;
  onSitusFallback?: (info: {
    cityKey: string;
    situsCity: string;
    countyFips: string;
  }) => void;
}

const str = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Assemble a Tier-1 payload from resolved inputs. Pure. This is the tail of
 * the old CLI's `buildTier1Payload` (everything after its land-use join),
 * byte-for-byte: the same zoning jurisdiction resolution, the same layer
 * provenance, the same declined envelope, the same acreage, the same coverage
 * predicates and the same key order. Every facet is either real content or
 * an honest null; nothing is defaulted.
 */
export function assembleTier1Payload(input: Tier1AssemblyInput): Tier1FacetPayload {
  const { nodeId, countyFips, countyName, ring, nowIso } = input;

  const acreage = ring
    ? parcelAcreage(ring)
    : (input.acreageWithoutRing ?? null);

  const baseFacts: BaseFacts = {
    apn: str(input.apn),
    situsAddress: str(input.situsAddress),
    situsCity: str(input.situsCity),
    situsState: str(input.situsState),
    situsZip: str(input.situsZip),
    landUse: input.landUse,
    acreage,
    cadRoll: input.cadRoll,
  };

  // --- Zoning (stored column, verbatim; honest null when unstamped) ---
  // Per-parcel jurisdiction: PIP-stamped zoning_jurisdiction is authoritative;
  // situs_city is a FALLBACK only (overlapping layers / pre-migration rows).
  const zoningDistrict = str(input.zoningDistrictRaw);
  const resolvedCityKey = resolveZoningJurisdiction(
    {
      zoningJurisdiction: input.zoningJurisdictionRaw,
      situsCity: baseFacts.situsCity,
      countyFips,
    },
    { onSitusFallback: input.onSitusFallback },
  );
  const jurisdictionFacetKey = resolvedCityKey
    ? resolvedCityKey.replace(/-/g, "_")
    : null;
  // GIS provenance when a district is present (A1). Prefer PIP/situs cityKey;
  // sole wired layer for the county is the fallback when zj was never written
  // (Bastrop mold: bastrop-city-tx). Multi-city + no key → no invent.
  const zoningLayer = zoningDistrict
    ? resolveZoningLayerForDistrict({
        resolvedCityKey,
        countyFips,
      })
    : null;
  const zoningGisProvenance = zoningLayer
    ? zoningProvenanceFromLayer(zoningLayer, nowIso)
    : undefined;
  // Prefer the layer's hyphen cityKey for jurisdiction when sole-layer
  // fallback filled a missing stamp (keeps setback routing on ZONING_LAYERS).
  const jurisdictionFromLayer = zoningLayer
    ? zoningLayer.cityKey.replace(/-/g, "_")
    : null;
  const effectiveJurisdictionKey =
    jurisdictionFacetKey ?? jurisdictionFromLayer;
  const zoning = zoningDistrict
    ? {
        district: zoningDistrict,
        jurisdictionKey: effectiveJurisdictionKey,
        ...(zoningGisProvenance ? { provenance: zoningGisProvenance } : {}),
      }
    : null;

  const envelope: Tier1EnvelopeFacet | null = ring
    ? computeTier1Envelope({
        ring,
        zoningCode: zoningDistrict,
        situsCity: baseFacts.situsCity,
        situsState: baseFacts.situsState,
        situsAddress: baseFacts.situsAddress,
        zoningJurisdictionFallback: effectiveJurisdictionKey,
      })
    : null;

  const facetCoverage = {
    baseFacts: baseFacts.apn != null || baseFacts.situsAddress != null,
    landUse: input.landUse != null,
    acreage: acreage != null,
    zoning: zoning != null,
    // Anti-zombie (WDLL 3.7): Tier-1 never counts envelope as product coverage.
    // Product envelope is the atom-chain path only.
    envelope: false,
  };

  return {
    facetSchemaVersion: input.facetSchemaVersion ?? TIER1_FACET_SCHEMA_VERSION,
    tier: 1,
    parcelNodeId: nodeId,
    countyFips,
    countyName,
    baseFacts,
    zoning,
    envelope,
    facetCoverage,
    provenance: {
      parcelSource: input.parcelSource,
      parcelVintage: str(input.parcelVintage),
      landUseSource: input.landUse ? input.landUse.source : null,
      landUseAddressRecovered: input.landUseAddressRecovered,
      roadsPending: true,
      tierNote: TIER_NOTE,
      landUseGateBlocked: input.landUseGateBlocked,
      zoningSource: zoningGisProvenance?.sourceUrl ?? null,
    },
    bakedAt: nowIso,
  };
}
