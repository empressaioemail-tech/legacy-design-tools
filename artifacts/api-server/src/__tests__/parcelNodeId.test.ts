/**
 * Canonical parcel node identity (map 10x rebuild, Wave D1).
 *
 * Proves:
 *   1. `parcelNodeId` produces `{county_fips}:{normalizeCadPropId(propId)}`.
 *   2. The SAME (fips, propId) yields an IDENTICAL id whether the raw prop
 *      id arrives leading-zero-padded (some county ArcGIS layers) or bare
 *      (the txgio store) — i.e. normalization makes the two paths agree.
 *   3. Missing / empty prop id is handled honestly (null, never a fake id).
 *   4. The live county-ArcGIS emit path (`normalizeTxCountyFeatures`)
 *      stamps `parcel_node_id`, and it equals the id the self-hosted store
 *      path would stamp for the same parcel (store `prop_id` column) —
 *      the cross-path determinism guarantee the bake/render/resolve waves
 *      key on.
 */

import { describe, it, expect } from "vitest";
import { parcelNodeId, normalizeCadPropId } from "../lib/parcelNodeId";
import {
  normalizeTxCountyFeatures,
  TX_PARCEL_COUNTIES,
  type TxParcelCounty,
} from "../lib/brokerageTxParcels";

describe("parcelNodeId — canonical id shape", () => {
  it("builds {county_fips}:{normalizeCadPropId(propId)}", () => {
    expect(parcelNodeId("48021", "47822")).toBe("48021:47822");
    expect(parcelNodeId("48453", "123456")).toBe("48453:123456");
  });

  it("strips leading zeros the same way the CAD join key does", () => {
    expect(normalizeCadPropId("0047822")).toBe("47822");
    expect(parcelNodeId("48021", "0047822")).toBe("48021:47822");
  });

  it("leaves non-numeric prop ids verbatim (no over-normalization)", () => {
    expect(parcelNodeId("48091", "R12345")).toBe("48091:R12345");
  });

  it("is identical for zero-padded vs bare raw ids for the same parcel", () => {
    // Same parcel, two raw shapes (padded live vs bare store).
    const fromPaddedLive = parcelNodeId("48021", "0047822");
    const fromBareStore = parcelNodeId("48021", "47822");
    expect(fromPaddedLive).toBe(fromBareStore);
    expect(fromPaddedLive).toBe("48021:47822");
  });
});

describe("parcelNodeId — honesty on missing input", () => {
  it("returns null (never a fabricated id) for missing/empty prop id", () => {
    expect(parcelNodeId("48021", null)).toBeNull();
    expect(parcelNodeId("48021", undefined)).toBeNull();
    expect(parcelNodeId("48021", "")).toBeNull();
    expect(parcelNodeId("48021", "   ")).toBeNull();
  });

  it("returns null for a missing county fips", () => {
    expect(parcelNodeId(null, "47822")).toBeNull();
    expect(parcelNodeId("", "47822")).toBeNull();
  });
});

describe("live county-ArcGIS emit path stamps parcel_node_id", () => {
  const bastrop = TX_PARCEL_COUNTIES.find(
    (c) => c.fips === "48021",
  ) as TxParcelCounty;

  it("stamps the canonical id on a Bastrop feature (prop_id field)", () => {
    const [feature] = normalizeTxCountyFeatures(
      bastrop,
      [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-97.31, 30.1] },
          properties: { prop_id: "47822", file_as_name: "DOE JOHN" },
        },
      ],
      "2026-07-18T00:00:00.000Z",
    ) as { properties: Record<string, unknown> }[];

    expect(feature.properties.parcel_node_id).toBe("48021:47822");
    // apn is kept alongside (backward compat), not replaced.
    expect(feature.properties.apn).toBe("47822");
  });

  it("omits parcel_node_id (never fakes it) when the county has no prop id", () => {
    const [feature] = normalizeTxCountyFeatures(
      bastrop,
      [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-97.31, 30.1] },
          properties: { file_as_name: "NO PROP ID" },
        },
      ],
      "2026-07-18T00:00:00.000Z",
    ) as { properties: Record<string, unknown> }[];

    expect("parcel_node_id" in feature.properties).toBe(false);
  });

  it("keys on the primary prop id only, ignoring the different-id-space apn fallback", () => {
    // Caldwell (still live-ArcGIS after the F4h Travis/Williamson store flip)
    // carries the same invariant the flipped Travis geo_id case used to prove:
    // apn falls back to OLDPROPID (a SUPERSEDED / different id space), but the
    // node id keys on the current Prop_ID ONLY — OLDPROPID is not the
    // CAD/txgio join key, so parcel_node_id must be omitted when only the
    // fallback id is present. (Caldwell: apn = Prop_ID ?? OLDPROPID;
    // rawPropId = Prop_ID only.)
    const caldwell = TX_PARCEL_COUNTIES.find(
      (c) => c.fips === "48055",
    ) as TxParcelCounty;
    const [feature] = normalizeTxCountyFeatures(
      caldwell,
      [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-97.62, 29.84] },
          // No Prop_ID, only OLDPROPID: apn falls back to OLDPROPID, but the
          // node id must NOT — OLDPROPID is a superseded, different id space.
          properties: { OLDPROPID: "0203140101" },
        },
      ],
      "2026-07-18T00:00:00.000Z",
    ) as { properties: Record<string, unknown> }[];

    expect(feature.properties.apn).toBe("0203140101");
    expect("parcel_node_id" in feature.properties).toBe(false);
  });
});

describe("cross-path determinism: live == self-hosted store", () => {
  it("live Bastrop feature id equals what the store would stamp", () => {
    const bastrop = TX_PARCEL_COUNTIES.find(
      (c) => c.fips === "48021",
    ) as TxParcelCounty;

    // Live path: county ArcGIS returns a zero-padded prop_id.
    const [live] = normalizeTxCountyFeatures(
      bastrop,
      [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-97.31, 30.1] },
          properties: { prop_id: "0047822" },
        },
      ],
      "2026-07-18T00:00:00.000Z",
    ) as { properties: Record<string, unknown> }[];

    // Self-hosted store path: txgio_parcel.prop_id column, bare.
    // (toFeature computes parcelNodeId(countyFips, row.propId); mirror it.)
    const storeRawPropId = "47822";
    const storeStamped = parcelNodeId("48021", storeRawPropId);

    expect(live.properties.parcel_node_id).toBe(storeStamped);
    expect(live.properties.parcel_node_id).toBe("48021:47822");
  });
});
