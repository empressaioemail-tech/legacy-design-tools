import { describe, expect, it } from "vitest";
import {
  buildParcelsPmtilesManifest,
  parcelsPmtilesManifestName,
} from "./parcelsPmtilesManifest";

const SHA = "c931db20bfc1" + "a".repeat(52);
const base = {
  sha256: SHA,
  writtenAt: "2026-09-26T12:51:08.553Z",
  sourceLayer: "parcels",
  gitSha: "f6902147",
  argv: ["--out-dir=./x", "--counties=48491,48001"],
};

describe("buildParcelsPmtilesManifest", () => {
  it("derives the 12-char hash from the full sha256 and names the file", () => {
    const m = buildParcelsPmtilesManifest({ ...base, perCounty: [] });
    expect(m.hash).toBe("c931db20bfc1");
    expect(m.sha256).toBe(SHA);
    expect(m.file).toBe("parcels.c931db20bfc1.pmtiles");
    expect(parcelsPmtilesManifestName(m.hash)).toBe(
      "parcels.c931db20bfc1.manifest.json",
    );
    expect(m.promoteId).toBe("parcel_node_id");
  });

  it("sorts counties and keys featured counts by FIPS", () => {
    const m = buildParcelsPmtilesManifest({
      ...base,
      perCounty: [
        { fips: "48491", features: 7 },
        { fips: "48001", features: 3 },
        { fips: "48209", features: 5 },
      ],
    });
    expect(m.counties).toEqual(["48001", "48209", "48491"]);
    expect(m.featured).toEqual({ "48001": 3, "48209": 5, "48491": 7 });
  });

  it("records git SHA and argv, and never emits droppedByTileBuilder", () => {
    const m = buildParcelsPmtilesManifest({ ...base, perCounty: [] });
    expect(m.bake).toEqual({ gitSha: "f6902147", argv: base.argv });
    expect(m).not.toHaveProperty("droppedByTileBuilder");
  });

  it("omits counties/featured when counts are unknown (--geojson bake)", () => {
    const m = buildParcelsPmtilesManifest({ ...base, perCounty: null });
    expect(m).not.toHaveProperty("counties");
    expect(m).not.toHaveProperty("featured");
  });

  it("allows a null git SHA and rejects a malformed sha256", () => {
    expect(
      buildParcelsPmtilesManifest({ ...base, gitSha: null, perCounty: [] }).bake
        .gitSha,
    ).toBeNull();
    expect(() =>
      buildParcelsPmtilesManifest({ ...base, sha256: "abc", perCounty: [] }),
    ).toThrow();
  });

  it("is deterministic and JSON round-trips", () => {
    const pc = [{ fips: "48001", features: 1 }];
    const a = buildParcelsPmtilesManifest({ ...base, perCounty: pc });
    const b = buildParcelsPmtilesManifest({ ...base, perCounty: pc });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});
