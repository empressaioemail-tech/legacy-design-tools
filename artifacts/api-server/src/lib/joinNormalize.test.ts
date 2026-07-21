import { describe, expect, it } from "vitest";

import {
  landUseJoinKey,
  LANDUSE_JOIN_DISABLED_FIPS,
  normalizeForJoin,
} from "./joinNormalize";

describe("normalizeForJoin", () => {
  it("strips leading zeros on a bare-numeric id: 000123 -> 123", () => {
    expect(normalizeForJoin("000123")).toBe("123");
  });

  it("leaves an already-bare numeric key untouched: 10001 -> 10001", () => {
    expect(normalizeForJoin("10001")).toBe("10001");
  });

  it("does not overshoot on an all-zero body: 000 -> 0", () => {
    // The leading-zero strip uses (?=\d) so the final digit survives.
    expect(normalizeForJoin("000")).toBe("0");
  });

  it("leaves non-parcel junk non-matching: PRIVATE ROAD stays as-is", () => {
    // 'PRIVATE ROAD' is not a parcel and has no cad_property row. It must
    // survive as a non-numeric value so it can never collide with a numeric
    // cad key.
    const out = normalizeForJoin("PRIVATE ROAD");
    expect(out).toBe("PRIVATE ROAD");
    expect(/^\d+$/.test(out)).toBe(false);
  });

  it("trims surrounding whitespace before normalizing", () => {
    expect(normalizeForJoin("  000123  ")).toBe("123");
  });

  it("NO LONGER strips a leading R (fabrication root cause removed)", () => {
    // The R-strip was the Williamson fabrication root: it made an R-account
    // TxGIO id collide with an unrelated bare-numeric CAD account. It is gone.
    // An R-prefixed id now stays R-prefixed and cannot collide with a numeric
    // cad key. (Williamson is also gated off by landUseJoinKey; this proves
    // the strip itself is removed so it can't fabricate anywhere.)
    expect(normalizeForJoin("R062578")).toBe("R062578");
    expect(normalizeForJoin("R000009")).toBe("R000009");
    expect(/^\d+$/.test(normalizeForJoin("R062578"))).toBe(false);
  });
});

describe("landUseJoinKey (per-county data-integrity gate)", () => {
  it("returns null for Williamson (48491) — R-account/CAD numbering mismatch", () => {
    // Williamson's TxGIO prop_id 'R062578' owner-mismatched its CAD collision
    // (~0.005% owner match). The join must refuse to match: honest absence.
    expect(landUseJoinKey("48491", "R062578")).toBeNull();
    expect(landUseJoinKey("48491", "062578")).toBeNull();
  });

  it("returns null for Hays (48209) — divergent bare-numeric systems", () => {
    // Hays owner-mismatched its collision (~0.013% owner match).
    expect(landUseJoinKey("48209", "13599")).toBeNull();
    expect(landUseJoinKey("48209", "010829")).toBeNull();
  });

  it("keeps the gated FIPS set to exactly the two fabricating counties", () => {
    expect([...LANDUSE_JOIN_DISABLED_FIPS].sort()).toEqual(["48209", "48491"]);
  });

  it("returns the direct numeric key for a REAL county (Bexar 48029), unchanged", () => {
    // Bexar joins directly on bare-numeric prop_id (99.1% owner match) and is
    // unaffected by the gate: the key is just the leading-zero-stripped id.
    expect(landUseJoinKey("48029", "0012345")).toBe("12345");
    expect(landUseJoinKey("48029", "12345")).toBe("12345");
  });

  it("returns the direct numeric key for Bastrop (48021), unchanged", () => {
    expect(landUseJoinKey("48021", "000987")).toBe("987");
  });

  it("returns null for a missing/blank prop_id", () => {
    expect(landUseJoinKey("48029", null)).toBeNull();
    expect(landUseJoinKey("48029", undefined)).toBeNull();
    expect(landUseJoinKey("48029", "   ")).toBeNull();
  });
});
