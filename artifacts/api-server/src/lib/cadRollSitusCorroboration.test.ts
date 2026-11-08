import { describe, expect, it } from "vitest";
import { corroborateCadPropertyMatchBySitus } from "./cadRollValue.js";

describe("corroborateCadPropertyMatchBySitus", () => {
  it("agrees on equal street text regardless of case/punctuation", () => {
    expect(corroborateCadPropertyMatchBySitus("12 Main St., Austin TX", "12 MAIN ST")).toBe("agree");
  });
  it("tolerates cad situs dropping city/zip (prefix)", () => {
    expect(corroborateCadPropertyMatchBySitus("100 OAK DR, KYLE, TX 78640", "100 OAK DR")).toBe("agree");
  });
  it("disagrees on a different street (propId collision)", () => {
    expect(corroborateCadPropertyMatchBySitus("12 MAIN ST, AUSTIN", "900 ELM AVE, DRIPPING SPRINGS")).toBe("disagree");
  });
  it("is inconclusive when either side is blank or non-string", () => {
    expect(corroborateCadPropertyMatchBySitus(null, "12 MAIN ST")).toBe("inconclusive");
    expect(corroborateCadPropertyMatchBySitus("12 MAIN ST", "")).toBe("inconclusive");
    expect(corroborateCadPropertyMatchBySitus(42, null)).toBe("inconclusive");
  });
});
