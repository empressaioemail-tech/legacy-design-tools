import { describe, expect, it } from "vitest";
import {
  compareSourcePrecedence,
  highestRankedCandidate,
  strictestAccessPolicy,
} from "../precedenceTaxonomy.js";
import { verifiedAbsenceDedupKey, intervalsOverlap } from "../dedup.js";
import {
  isWellDefinedCheckScope,
  isAbsenceClaimType,
  conflictClaimTypeFor,
} from "../types.js";
import { isRegisteredKnowledgeSource } from "../sourceRegistry.js";

describe("verifiedAbsence claim types", () => {
  it("recognizes absence.* prefix", () => {
    expect(isAbsenceClaimType("absence.lien")).toBe(true);
    expect(isAbsenceClaimType("claim.lien")).toBe(false);
  });

  it("maps conflict claim type from original", () => {
    expect(conflictClaimTypeFor("claim.lien")).toBe("conflict.claim.lien");
  });
});

describe("check scope validation", () => {
  it("requires jurisdiction, record_type, and date range", () => {
    expect(
      isWellDefinedCheckScope({
        jurisdiction: "travis-tx",
        record_type: "property-lien",
        date_range_start: "2000-01-01",
        date_range_end: "2026-06-30",
      }),
    ).toBe(true);
    expect(
      isWellDefinedCheckScope({
        jurisdiction: "travis-tx",
        record_type: "",
        date_range_start: "2000-01-01",
        date_range_end: "2026-06-30",
      }),
    ).toBe(false);
  });
});

describe("verifiedAbsence dedup key", () => {
  const scope = {
    jurisdiction: "test-jurisdiction",
    record_type: "empty-lien-index",
    date_range_start: "2020-01-01",
    date_range_end: "2026-06-30",
  };

  it("includes full date range — different ranges are distinct keys", () => {
    const a = verifiedAbsenceDedupKey({
      subjectId: "parcel_test",
      claimType: "absence.lien",
      sourceKey: "test:empty-registry",
      checkScope: scope,
      checkDate: "2026-06-30T12:00:00.000Z",
    });
    const b = verifiedAbsenceDedupKey({
      subjectId: "parcel_test",
      claimType: "absence.lien",
      sourceKey: "test:empty-registry",
      checkScope: {
        ...scope,
        date_range_start: "2024-01-01",
      },
      checkDate: "2026-06-30T12:00:00.000Z",
    });
    expect(a).not.toBe(b);
  });

  it("dedups same scope + source + check day", () => {
    const a = verifiedAbsenceDedupKey({
      subjectId: "parcel_test",
      claimType: "absence.lien",
      sourceKey: "test:empty-registry",
      checkScope: scope,
      checkDate: "2026-06-30T08:00:00.000Z",
    });
    const b = verifiedAbsenceDedupKey({
      subjectId: "parcel_test",
      claimType: "absence.lien",
      sourceKey: "test:empty-registry",
      checkScope: scope,
      checkDate: "2026-06-30T20:00:00.000Z",
    });
    expect(a).toBe(b);
  });
});

describe("source registry gate", () => {
  it("rejects unregistered sources for verified absence", () => {
    expect(isRegisteredKnowledgeSource("cotality:liens-mortgage-tax")).toBe(true);
    expect(isRegisteredKnowledgeSource("random-open-web-scraper")).toBe(false);
  });

  it("Cotality source is public-paid not public-free", () => {
    const cmp = compareSourcePrecedence(
      "cotality:liens-mortgage-tax",
      "fema:nfhl",
    );
    expect(cmp.ordered).toBe(true);
    if (cmp.ordered) {
      expect(cmp.winner.sourceKey).toBe("cotality:liens-mortgage-tax");
      expect(cmp.winner.accessPolicy).toBe("public-paid");
    }
  });
});

describe("precedence taxonomy", () => {
  it("resolves cotality over county GIS", () => {
    const cmp = compareSourcePrecedence(
      "cotality:liens-mortgage-tax",
      "grand-county-ut:parcels",
    );
    expect(cmp.ordered).toBe(true);
    if (cmp.ordered) {
      expect(cmp.winner.sourceKey).toBe("cotality:liens-mortgage-tax");
    }
  });

  it("returns unordered for equal rank sources", () => {
    const cmp = compareSourcePrecedence("fema:nfhl", "fema:nfhl");
    expect(cmp.ordered).toBe(false);
  });

  it("picks highest ranked candidate", () => {
    const ranked = highestRankedCandidate([
      { sourceKey: "fema:nfhl", id: "a" },
      { sourceKey: "cotality:liens-mortgage-tax", id: "b" },
    ]);
    expect(ranked?.sourceKey).toBe("cotality:liens-mortgage-tax");
  });
});

describe("interval overlap", () => {
  it("detects overlapping valid intervals", () => {
    const a = {
      validFrom: new Date("2026-01-01"),
      validTo: null,
    };
    const b = {
      validFrom: new Date("2026-06-01"),
      validTo: new Date("2026-12-31"),
    };
    expect(intervalsOverlap(a, b)).toBe(true);
  });
});

describe("conflict accessPolicy inheritance", () => {
  it("strictest policy wins for tenant-private candidates", () => {
    expect(
      strictestAccessPolicy(["public-free", "tenant-private", "public-paid"]),
    ).toBe("tenant-private");
  });
});
