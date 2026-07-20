import { describe, expect, it } from "vitest";

import { normalizeForJoin } from "./joinNormalize";

describe("normalizeForJoin", () => {
  it("strips a WCAD R-prefix and leading zeros: R000009 -> 9", () => {
    // The live Williamson bug: TxGIO prop_id 'R000009' must resolve to the
    // bare-numeric cad_property key '9'.
    expect(normalizeForJoin("R000009")).toBe("9");
  });

  it("strips an R-prefix with no leading zeros: R123 -> 123", () => {
    expect(normalizeForJoin("R123")).toBe("123");
  });

  it("strips a lowercase r-prefix too: r000009 -> 9", () => {
    expect(normalizeForJoin("r000009")).toBe("9");
  });

  it("strips leading zeros on a bare-numeric id: 000123 -> 123", () => {
    expect(normalizeForJoin("000123")).toBe("123");
  });

  it("leaves an already-bare numeric key untouched: 10001 -> 10001", () => {
    expect(normalizeForJoin("10001")).toBe("10001");
  });

  it("leaves non-parcel junk non-matching: PRIVATE ROAD stays as-is", () => {
    // 'PRIVATE ROAD' is not a parcel and has no cad_property row. It must
    // survive as a non-numeric value so it can never collide with a numeric
    // cad key.
    const out = normalizeForJoin("PRIVATE ROAD");
    expect(out).toBe("PRIVATE ROAD");
    expect(/^\d+$/.test(out)).toBe(false);
  });

  it("does not strip an R that is not followed by a digit: ROAD stays ROAD", () => {
    expect(normalizeForJoin("ROAD")).toBe("ROAD");
  });

  it("trims surrounding whitespace before normalizing", () => {
    expect(normalizeForJoin("  R000009  ")).toBe("9");
  });

  it("does not overshoot on an all-zero body after the R: R0 -> 0", () => {
    // The leading-zero strip uses (?=\d) so the final digit survives.
    expect(normalizeForJoin("R0")).toBe("0");
  });
});
