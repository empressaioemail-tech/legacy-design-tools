import { describe, expect, it } from "vitest";

import {
  landUseJoinKey,
  addressJoinKey,
  normalizeSitusAddress,
  LANDUSE_JOIN_DISABLED_FIPS,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
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

describe("normalizeSitusAddress (situs-address recovery key)", () => {
  it("uppercases and strips ALL non-alphanumerics", () => {
    expect(normalizeSitusAddress("123 Main St.")).toBe("123MAINST");
  });

  it("is case-insensitive: same key regardless of case", () => {
    expect(normalizeSitusAddress("123 main st")).toBe(
      normalizeSitusAddress("123 MAIN ST"),
    );
  });

  it("collapses arbitrary whitespace runs (they are stripped entirely)", () => {
    expect(normalizeSitusAddress("123   MAIN   ST")).toBe("123MAINST");
    expect(normalizeSitusAddress("123\tMAIN\nST")).toBe("123MAINST");
  });

  it("strips punctuation so #, commas, hyphens do not change the key", () => {
    expect(normalizeSitusAddress("123 MAIN ST, UNIT #4-B")).toBe(
      "123MAINSTUNIT4B",
    );
    // Punctuation and spacing are the ONLY difference -> same key (that is the
    // whole point: the two systems format the same address differently).
    expect(normalizeSitusAddress("123 MAIN ST UNIT 4B")).toBe(
      normalizeSitusAddress("123 MAIN ST, UNIT #4-B"),
    );
    // A genuinely different unit (4C) is a different key.
    expect(normalizeSitusAddress("123 MAIN ST UNIT 4C")).not.toBe(
      normalizeSitusAddress("123 MAIN ST, UNIT #4-B"),
    );
  });

  it("keys leading/trailing whitespace-insensitively", () => {
    expect(normalizeSitusAddress("  123 MAIN ST  ")).toBe("123MAINST");
  });

  it("returns empty string for null/blank/punctuation-only input", () => {
    expect(normalizeSitusAddress(null)).toBe("");
    expect(normalizeSitusAddress(undefined)).toBe("");
    expect(normalizeSitusAddress("   ")).toBe("");
    expect(normalizeSitusAddress(".,-#")).toBe("");
  });
});

describe("addressJoinKey (recovery scoped to blocked counties)", () => {
  it("returns the normalized situs key for a BLOCKED county (Williamson)", () => {
    expect(addressJoinKey("48491", "123 Main St")).toBe("123MAINST");
  });

  it("returns the normalized situs key for a BLOCKED county (Hays)", () => {
    expect(addressJoinKey("48209", "456 Oak Ave.")).toBe("456OAKAVE");
  });

  it("returns null for a NON-blocked county — recovery is scoped, prop_id join already works", () => {
    // Bexar joins correctly on prop_id; running an address join there would
    // only add a way to be wrong, so the recovery key is null.
    expect(addressJoinKey("48029", "123 Main St")).toBeNull();
    expect(addressJoinKey("48021", "123 Main St")).toBeNull();
  });

  it("returns null for a blocked county with no situs address (honest absence)", () => {
    expect(addressJoinKey("48491", null)).toBeNull();
    expect(addressJoinKey("48491", "")).toBeNull();
    expect(addressJoinKey("48491", "   ")).toBeNull();
  });

  it("honors a custom blocked set (ledger-driven), not just the seed", () => {
    const ledger = new Set(["48491", "48209", "48027"]); // Bell added by ledger
    expect(addressJoinKey("48027", "1 A St", ledger)).toBe("1AST");
    // Not in this ledger set -> no recovery.
    expect(addressJoinKey("48453", "1 A St", ledger)).toBeNull();
  });

  it("defaults its blocked set to the gate-output seed (Williamson+Hays)", () => {
    expect([...LANDUSE_JOIN_DISABLED_FIPS_SEED].sort()).toEqual([
      "48209",
      "48491",
    ]);
    // Default arg == seed: blocked counties recover, others do not.
    expect(addressJoinKey("48491", "1 A St")).toBe("1AST");
    expect(addressJoinKey("48029", "1 A St")).toBeNull();
  });
});
