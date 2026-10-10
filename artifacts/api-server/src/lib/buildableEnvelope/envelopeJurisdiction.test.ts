import { describe, expect, it, vi } from "vitest";

import {
  cityStateFromSitus,
  countyFipsFromParcelNodeId,
  jurisdictionKeyFromParcelNode,
} from "./envelopeJurisdiction";
import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";
import { POST_BODY } from "./envelopePostBody";

// W3 PR #805 review: getSetbackTableForZoning now throws a named setback refusal (gate 2/3)
// instead of silently returning null for some jurisdictions. Real call-through for every normal
// code, PLUS one sentinel districtCode forced to throw a generic (non-refusal) error, so
// jurisdictionKeyFromParcelNode's "decline the refusal family, rethrow anything else" behavior is
// provable without touching production code. Keyed on districtCode (not jurisdictionKey) because
// this function's own public signature never takes a bare jurisdictionKey -- it derives candidate
// city keys itself from the parcel node's county FIPS.
vi.mock("@workspace/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/adapters")>();
  return {
    ...actual,
    getSetbackTableForZoning: (key: string, code: string | null | undefined) => {
      if (code === "__NON_REFUSAL_BUG__") {
        throw new TypeError("a real bug, not a named setback refusal");
      }
      return actual.getSetbackTableForZoning(key, code);
    },
  };
});

const DASHWOOD_SITUS = "17006 DASHWOOD CREEK DR , TX 78660";
const DASHWOOD_NODE = "48453:280210";

describe("cityStateFromSitus — three-part meaning (WDLL 2)", () => {
  it("returns city+state from a three-part Bastrop line", () => {
    expect(cityStateFromSitus("908 PINE , BASTROP, TX 78602")).toEqual({
      city: "BASTROP",
      state: "TX",
    });
  });

  it("returns nulls for Dashwood-shaped two-part CAD situs (does not invent a city)", () => {
    expect(cityStateFromSitus(DASHWOOD_SITUS)).toEqual({
      city: null,
      state: null,
    });
  });

  it("returns nulls for two-part `, TX` Travis sentinel", () => {
    expect(cityStateFromSitus("16911 SIMSBROOK DR , TX")).toEqual({
      city: null,
      state: null,
    });
  });
});

describe("jurisdictionKeyFromParcelNode — Dashwood 48453:280210 (WDLL 2)", () => {
  it("parses Travis FIPS from the node id", () => {
    expect(countyFipsFromParcelNodeId(DASHWOOD_NODE)).toBe("48453");
  });

  it("uniquely resolves pflugerville-tx for SF-S on a Travis node", () => {
    const key = jurisdictionKeyFromParcelNode({
      parcelNodeId: DASHWOOD_NODE,
      districtCode: "SF-S",
    });
    expect(key).toBe("pflugerville-tx");
    const setbacks = resolveAuthoritativeSetbacks({
      jurisdictionKey: key,
      districtCode: "SF-S",
      atomRule: null,
    });
    expect(setbacks).not.toBeNull();
    expect(setbacks!.scalars).toEqual({
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
      side_corner_ft: 15,
    });
  });

  it("returns null when the district is blank (Wainee-class no stamp)", () => {
    expect(
      jurisdictionKeyFromParcelNode({
        parcelNodeId: "48021:35772",
        districtCode: "",
      }),
    ).toBeNull();
  });

  it("returns null when the node id has no FIPS", () => {
    expect(
      jurisdictionKeyFromParcelNode({
        parcelNodeId: "not-a-node",
        districtCode: "SF-S",
      }),
    ).toBeNull();
  });
});

/**
 * W3 PR #805 review: Marble Falls and Horseshoe Bay (the only two of Burnet's eight cities with a
 * wired zoning layer, per zoning-layers.ts) now throw a named setback refusal for most district
 * codes (the 2026-10-09 register downgrade) instead of clearing the gate and resolving. A Burnet
 * parcel node reaching this loop must decline to null the same way an ordinary "no table for this
 * candidate city" miss already does -- never crash the whole lookup. A non-refusal error (a real
 * bug) must still throw.
 */
describe("jurisdictionKeyFromParcelNode declines the setback-refusal family, never throws it (W3 PR #805 review)", () => {
  const BURNET_NODE = "48053:12487"; // sample #12, City of Burnet

  it("a Burnet parcel node with a Marble-Falls/Horseshoe-Bay-shaped district code declines to null, no throw -- both wired candidate cities refuse (ENZ.2 is unverified for Marble Falls, unregistered for Horseshoe Bay)", () => {
    expect(() =>
      jurisdictionKeyFromParcelNode({
        parcelNodeId: BURNET_NODE,
        districtCode: "ENZ.2",
      }),
    ).not.toThrow();
    expect(
      jurisdictionKeyFromParcelNode({
        parcelNodeId: BURNET_NODE,
        districtCode: "ENZ.2",
      }),
    ).toBeNull();
  });

  it("a non-refusal error (a real bug) still throws, uncaught", () => {
    expect(() =>
      jurisdictionKeyFromParcelNode({
        parcelNodeId: BURNET_NODE,
        districtCode: "__NON_REFUSAL_BUG__",
      }),
    ).toThrow(/real bug/);
  });
});

describe("POST_BODY .strict() (WDLL 1)", () => {
  it("accepts optional parcel_node_id", () => {
    const parsed = POST_BODY.safeParse({
      address: DASHWOOD_SITUS,
      parcel_node_id: DASHWOOD_NODE,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.parcel_node_id).toBe(DASHWOOD_NODE);
    }
  });

  it("still rejects unrecognized extra keys", () => {
    const parsed = POST_BODY.safeParse({
      address: DASHWOOD_SITUS,
      parcel_node_id: DASHWOOD_NODE,
      extra_field: true,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.code).toBe("unrecognized_keys");
      const issue = parsed.error.issues[0] as { keys?: string[] };
      expect(issue.keys).toContain("extra_field");
    }
  });
});
