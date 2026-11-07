/**
 * Pure tests for the map-data owner co-gate (lib/ownerCoGatedMapFields.ts).
 * Synthetic fixtures only: no real parcel, owner, address or value appears.
 *
 * The route-level suite (__tests__/brokerageMapDataOwnerGate.test.ts) drives
 * the real `grantsOwnerCoGatedFields` against a test schema; this file pins
 * the walker's own rules with a recording stub so they run without a DB.
 */

import { describe, it, expect } from "vitest";
import {
  gateOwnerCoGatedFields,
  hasOwnerCoGatedKey,
  isOwnerCoGatedKey,
  stripOwnerCoGatedKeys,
  type OwnerCoGrant,
} from "../ownerCoGatedMapFields";

const SYNTH = "SYNTHETIC-GATED-VALUE";

function parcel(nodeId: string | null, extra: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      provider: "synthetic",
      countyFips: "48999",
      ...(nodeId ? { parcel_node_id: nodeId, apn: nodeId.split(":")[1] } : {}),
      situsAddress: "1 SYNTHETIC WAY",
      landUseCode: "A1",
      owner: SYNTH,
      ownerMailingAddress: SYNTH,
      marketValue: 1,
      land_val: 1,
      imprv_val: 1,
      assessedValue: 1,
      homesteadExempt: true,
      ...extra,
    },
  };
}

function fc(...features: unknown[]) {
  return { layer: "parcels", geojson: { type: "FeatureCollection", features } };
}

/** Same contract as grantsOwnerCoGatedFields: plan first, then per-parcel unlock. */
function stubGrant(unlocked: Set<string>, calls: string[] = []): OwnerCoGrant {
  return async (userId, tier, nodeId) => {
    calls.push(`${userId ?? "null"}|${tier ?? "null"}|${nodeId}`);
    if (tier === "studio" || tier === "team") return true;
    if (!userId) return false;
    return unlocked.has(nodeId);
  };
}

describe("isOwnerCoGatedKey", () => {
  it("matches owner, mailing, exemption and CAD dollar-value keys", () => {
    for (const k of [
      "owner",
      "OWNER",
      "ownerName",
      "owner_name",
      "ownerMailingAddress",
      "OWNER_ADDR",
      "cadOwner",
      "txgio_owner",
      "mailingAddress",
      "mail_addr",
      "homesteadExempt",
      "exemptions",
      "market",
      "marketValue",
      "market_value",
      "assessedValue",
      "appraised_val",
      "landValue",
      "land_val",
      "improvementValue",
      "imprv_val",
      "totalMarketValue",
    ]) {
      expect(isOwnerCoGatedKey(k), k).toBe(true);
    }
  });

  it("leaves public parcel fields alone", () => {
    for (const k of [
      "apn",
      "parcel_node_id",
      "situsAddress",
      "landUseCode",
      "landUseDescription",
      "landUseSource",
      "landUseVintage",
      "countyFips",
      "countyName",
      "ownership",
      "absentee",
      "value",
      "motivatedSellerHeat",
      "zoningCode",
    ]) {
      expect(isOwnerCoGatedKey(k), k).toBe(false);
    }
  });
});

describe("stripOwnerCoGatedKeys", () => {
  it("drops gated keys at any depth and keeps the rest", () => {
    const clean = stripOwnerCoGatedKeys(parcel("48999:1").properties) as Record<
      string,
      unknown
    >;
    expect(hasOwnerCoGatedKey(clean)).toBe(false);
    expect(JSON.stringify(clean)).not.toContain(SYNTH);
    expect(clean.apn).toBe("1");
    expect(clean.situsAddress).toBe("1 SYNTHETIC WAY");
    expect("owner" in clean).toBe(false);
  });
});

describe("gateOwnerCoGatedFields", () => {
  it("caller null (anonymous / service key) strips every feature and makes no lookup", async () => {
    const calls: string[] = [];
    const out = await gateOwnerCoGatedFields(fc(parcel("48999:1"), parcel("48999:2")), {
      caller: null,
      grant: stubGrant(new Set(["48999:1"]), calls),
    });
    expect(hasOwnerCoGatedKey(out)).toBe(false);
    expect(calls).toEqual([]);
    for (const f of out.geojson.features as Array<{ properties: Record<string, unknown> }>) {
      expect("owner" in f.properties).toBe(false);
      expect(f.properties.apn).toBeTruthy();
    }
  });

  it("Studio keeps gated fields on every parcel, including one with no node id", async () => {
    const out = await gateOwnerCoGatedFields(fc(parcel("48999:1"), parcel(null)), {
      caller: { userId: "u-studio", subscriptionTier: "studio" },
      grant: stubGrant(new Set()),
    });
    const fs = out.geojson.features as Array<{ properties: Record<string, unknown> }>;
    expect(fs.every((f) => f.properties.owner === SYNTH)).toBe(true);
  });

  it("Solo gets nothing", async () => {
    const out = await gateOwnerCoGatedFields(fc(parcel("48999:1")), {
      caller: { userId: "u-solo", subscriptionTier: "solo" },
      grant: stubGrant(new Set()),
    });
    expect(hasOwnerCoGatedKey(out)).toBe(false);
  });

  it("an unlock grants only its own parcel; a feature with no node id is never unlock-granted", async () => {
    const calls: string[] = [];
    const out = await gateOwnerCoGatedFields(
      fc(parcel("48999:1"), parcel("48999:2"), parcel(null)),
      {
        caller: { userId: "u-free", subscriptionTier: null },
        grant: stubGrant(new Set(["48999:1", ""]), calls),
      },
    );
    const fs = out.geojson.features as Array<{ properties: Record<string, unknown> }>;
    expect(fs[0]!.properties.owner).toBe(SYNTH);
    expect("owner" in fs[1]!.properties).toBe(false);
    expect("owner" in fs[2]!.properties).toBe(false);
    // The id-less feature is decided with userId null, so no unlock lookup.
    expect(calls).toContain("null|null|");
  });

  it("derives the parcel from countyFips + apn when parcel_node_id is absent", async () => {
    const f = {
      type: "Feature",
      geometry: null,
      properties: {
        countyFips: "48999",
        apn: "007",
        absenteeEvidence: { absentee: true, ownerMailingAddress: SYNTH },
      },
    };
    const out = await gateOwnerCoGatedFields(fc(f), {
      caller: { userId: "u-free", subscriptionTier: null },
      grant: stubGrant(new Set(["48999:7"])),
    });
    const props = (out.geojson.features[0] as { properties: Record<string, unknown> })
      .properties;
    expect((props.absenteeEvidence as Record<string, unknown>).ownerMailingAddress).toBe(SYNTH);
  });

  it("keys outside features follow the context parcel", async () => {
    const body = { mapData: { layers: [{ attributes: { owner: SYNTH, apn: "1" } }] } };
    const denied = await gateOwnerCoGatedFields(body, {
      caller: { userId: "u-free", subscriptionTier: null },
      grant: stubGrant(new Set(["48999:1"])),
      contextParcelNodeId: "48999:2",
    });
    expect(hasOwnerCoGatedKey(denied)).toBe(false);
    expect(denied.mapData.layers[0]!.attributes.apn).toBe("1");
    const granted = await gateOwnerCoGatedFields(body, {
      caller: { userId: "u-free", subscriptionTier: null },
      grant: stubGrant(new Set(["48999:1"])),
      contextParcelNodeId: "48999:1",
    });
    expect(granted.mapData.layers[0]!.attributes.owner).toBe(SYNTH);
  });

  it("never mutates its input", async () => {
    const input = fc(parcel("48999:1"));
    const snapshot = JSON.stringify(input);
    await gateOwnerCoGatedFields(input, { caller: null, grant: stubGrant(new Set()) });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
