import { describe, expect, it } from "vitest";

import {
  cityStateFromSitus,
  countyFipsFromParcelNodeId,
  jurisdictionKeyFromParcelNode,
} from "./envelopeJurisdiction";
import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";
import { POST_BODY } from "./envelopePostBody";

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
