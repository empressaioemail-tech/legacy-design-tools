import { describe, expect, it } from "vitest";
import {
  isMeteredAdapterKey,
  providerCatalogEntryForKey,
  providerSourceKindForKey,
} from "../providerCatalog";
import {
  isMeteredAdapter,
  isMeteredCotalityAdapter,
} from "../brokerageTierGate";

/**
 * The pre-catalog implementations, verbatim, as the parity reference:
 *
 *   brokerageTierGate.isMeteredCotalityAdapter —
 *     if (!adapterKey.startsWith("cotality:")) return false;
 *     return !FREE_COTALITY_BASELINE_KEYS.has(adapterKey);  // parcels, zoning
 *
 *   brokerageSiteContext.adapterSourceKind (prefix branch only) —
 *     if (adapterKey.startsWith("cotality:")) return "national-aggregator";
 *     // everything else fell through to the national:/tier default,
 *     // which the call site still applies when the catalog returns
 *     // undefined.
 */
function legacyIsMeteredCotalityAdapter(adapterKey: string): boolean {
  if (!adapterKey.startsWith("cotality:")) return false;
  return !new Set(["cotality:parcels", "cotality:zoning"]).has(adapterKey);
}

/** Every cotality key named anywhere in the tier gate, plus edge shapes. */
const COTALITY_KEYS = [
  "cotality:parcels",
  "cotality:zoning",
  "cotality:property",
  "cotality:rent-avm",
  "cotality:liens-mortgage-tax",
  "cotality:permits",
  "cotality:propensity",
  "cotality:owner-occupancy",
  "cotality:hoa",
  "cotality:comparables",
  "cotality:climate",
  "cotality:hazards",
  "cotality:replacementcost",
  "cotality:mineral",
  "cotality:utility",
  "cotality:sinkhole",
  "cotality:foundation",
  "cotality:some-future-layer",
];

const REGRID_KEYS = ["regrid:parcels", "regrid:zoning"];

const OTHER_KEYS = [
  "fema:nfhl-flood-zone",
  "usgs:ned-elevation",
  "national:opportunity-zone",
  "tceq:edwards-aquifer",
  "bastrop-tx:parcels",
  "totally-unknown:thing",
];

describe("providerCatalog metering", () => {
  it("matches the legacy cotality truth table exactly (parity proof)", () => {
    for (const key of [...COTALITY_KEYS, ...REGRID_KEYS, ...OTHER_KEYS]) {
      expect(isMeteredAdapterKey(key), key).toBe(
        legacyIsMeteredCotalityAdapter(key),
      );
    }
  });

  it("keeps the cotality free baseline (parcels/zoning) unmetered", () => {
    expect(isMeteredAdapterKey("cotality:parcels")).toBe(false);
    expect(isMeteredAdapterKey("cotality:zoning")).toBe(false);
    expect(isMeteredAdapterKey("cotality:rent-avm")).toBe(true);
  });

  it("explicitly never meters county-gis keys (free public record)", () => {
    expect(isMeteredAdapterKey("county-gis:parcels:48453")).toBe(false);
    expect(isMeteredAdapterKey("county-gis:parcels:48021")).toBe(false);
    const entry = providerCatalogEntryForKey("county-gis:parcels:48453");
    expect(entry?.metered).toBe(false);
  });

  it("keeps regrid dormant semantics (unmetered)", () => {
    for (const key of REGRID_KEYS) {
      expect(isMeteredAdapterKey(key)).toBe(false);
    }
  });

  it("leaves unknown prefixes unmetered (pre-catalog fallback)", () => {
    for (const key of OTHER_KEYS) {
      expect(isMeteredAdapterKey(key)).toBe(false);
    }
  });

  it("tier-gate exports delegate to the catalog (old alias included)", () => {
    for (const key of [...COTALITY_KEYS, "county-gis:parcels:48453"]) {
      expect(isMeteredAdapter(key)).toBe(isMeteredAdapterKey(key));
      expect(isMeteredCotalityAdapter(key)).toBe(isMeteredAdapterKey(key));
    }
  });
});

describe("providerCatalog sourceKind", () => {
  it("keeps cotality keys on national-aggregator (parity with the old prefix switch)", () => {
    for (const key of COTALITY_KEYS) {
      expect(providerSourceKindForKey(key)).toBe("national-aggregator");
    }
  });

  it("labels county-gis keys local-adapter (per-jurisdiction GIS feed)", () => {
    expect(providerSourceKindForKey("county-gis:parcels:48453")).toBe(
      "local-adapter",
    );
  });

  it("returns undefined for regrid and unknown prefixes so call sites keep their tier default", () => {
    // The old adapterSourceKind had no regrid/other branch — those keys
    // fell to the national:/tier default, which still runs when the
    // catalog returns undefined. Parity = no override here.
    for (const key of [...REGRID_KEYS, ...OTHER_KEYS]) {
      expect(providerSourceKindForKey(key)).toBeUndefined();
    }
  });
});
