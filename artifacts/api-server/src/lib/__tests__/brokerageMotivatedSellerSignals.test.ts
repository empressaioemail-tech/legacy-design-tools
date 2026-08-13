import { describe, expect, it } from "vitest";
import {
  decideAbsentee,
  normalizeAddressForCompare,
} from "../brokerageMotivatedSellerSignals";

describe("normalizeAddressForCompare", () => {
  it("uppercases, collapses whitespace, and strips separators", () => {
    expect(normalizeAddressForCompare("1 Main St.")).toBe("1 MAIN ST");
    expect(normalizeAddressForCompare("  5   Oak  Ave  ")).toBe("5 OAK AVE");
    expect(normalizeAddressForCompare(null)).toBe("");
  });
});

describe("decideAbsentee (public-record absentee determination)", () => {
  it("mailing != situs -> absentee true", () => {
    const r = decideAbsentee({
      ownerMailingAddress: "PO BOX 500, DALLAS, TX 75201",
      cadSitusAddress: "1 MAIN ST",
      cadSitusCity: "AUSTIN",
      featureSitusAddress: null,
      exemptionCodes: null,
    });
    expect(r.absentee).toBe(true);
    expect(r.note).toMatch(/absentee/i);
  });

  it("mailing == situs -> absentee false (owner resides)", () => {
    const r = decideAbsentee({
      ownerMailingAddress: "1 Main St.",
      cadSitusAddress: "1 MAIN ST",
      cadSitusCity: "AUSTIN",
      featureSitusAddress: null,
      exemptionCodes: null,
    });
    expect(r.absentee).toBe(false);
  });

  it("missing mailing -> not-evaluated (null), never assumed absentee", () => {
    const r = decideAbsentee({
      ownerMailingAddress: null,
      cadSitusAddress: "1 MAIN ST",
      cadSitusCity: "AUSTIN",
      featureSitusAddress: null,
      exemptionCodes: null,
    });
    expect(r.absentee).toBeNull();
    expect(r.note).toMatch(/cannot be determined|not-evaluated/i);
  });

  it("missing situs (CAD and feature) -> not-evaluated (null)", () => {
    const r = decideAbsentee({
      ownerMailingAddress: "PO BOX 9",
      cadSitusAddress: null,
      cadSitusCity: null,
      featureSitusAddress: null,
      exemptionCodes: null,
    });
    expect(r.absentee).toBeNull();
  });

  it("falls back to the parcel feature situs when the CAD row lacks one", () => {
    const r = decideAbsentee({
      ownerMailingAddress: "1 MAIN ST",
      cadSitusAddress: null,
      cadSitusCity: null,
      featureSitusAddress: "1 Main St",
      exemptionCodes: null,
    });
    // mailing matches the feature situs -> not absentee, and it WAS evaluable.
    expect(r.absentee).toBe(false);
  });

  it("homestead (HS) exemption -> owner-occupied by law, never absentee even if mailing string differs", () => {
    const r = decideAbsentee({
      ownerMailingAddress: "PO BOX 12, AUSTIN, TX 78701",
      cadSitusAddress: "9 ELM ST",
      cadSitusCity: "AUSTIN",
      featureSitusAddress: null,
      exemptionCodes: ["HS"],
    });
    expect(r.absentee).toBe(false);
    expect(r.homesteadExempt).toBe(true);
    expect(r.note).toMatch(/homestead/i);
  });
});
