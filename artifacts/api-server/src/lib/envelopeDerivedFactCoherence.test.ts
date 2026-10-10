import { describe, expect, it, vi } from "vitest";

import {
  ENVELOPE_ROUTER_CODE_SETS_NONE,
  ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED,
  ENVELOPE_ROUTER_NOT_A_DISTRICT,
  ENVELOPE_ROUTER_SETBACK_SOURCE_REFUSED,
  lookUpEnvelopeTableRow,
  reconcileMaxFootprintSqFtFact,
  reconcileMaxHeightFtFact,
  reconcileMaxLotCoveragePctFact,
} from "./envelopeDerivedFactCoherence";

// W3 PR #805 review: getSetbackTableForZoning now throws a named setback refusal (gate 2/3)
// instead of silently returning null for some jurisdictions. Real call-through for every normal
// code, PLUS one sentinel districtCode forced to throw a generic (non-refusal) error, so
// lookUpEnvelopeTableRow's "decline the refusal family, rethrow anything else" behavior is
// provable without touching production code.
vi.mock("@workspace/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/adapters")>();
  return {
    ...actual,
    getSetbackTableForZoning: (key: string, code: string | null | undefined) => {
      if (code === "__NON_REFUSAL_BUG__") {
        throw new TypeError("a real bug, not a named setback refusal");
      }
      return actual.getSetbackTableForZoning(key, code);
    },
  };
});
import type { MaxFootprintSqFtFactRead } from "./maxFootprintSqFtFactRead";
import { MAX_FOOTPRINT_SQFT_FACT_SOURCE } from "./maxFootprintSqFtFactRead";
import type { MaxHeightFtFactRead } from "./maxHeightFtFactRead";
import { MAX_HEIGHT_FT_FACT_SOURCE } from "./maxHeightFtFactRead";
import type { MaxLotCoveragePctFactRead } from "./maxLotCoveragePctFactRead";
import { MAX_LOT_COVERAGE_PCT_FACT_SOURCE } from "./maxLotCoveragePctFactRead";

const PI_ABSENT_HEIGHT: MaxHeightFtFactRead = {
  state: "absent",
  source: MAX_HEIGHT_FT_FACT_SOURCE,
  entityId: "48021:27246",
  absence: {
    kind: "absent-verified",
    reason: ENVELOPE_ROUTER_NOT_A_DISTRICT,
  },
  verifiedAbsence: true,
  sourceTier: "envelope-corpus-lookup",
  sourceAdapter: "parcel_record",
  sourceVintage: "2026-09-11",
};

const PI_ABSENT_COVERAGE: MaxLotCoveragePctFactRead = {
  state: "absent",
  source: MAX_LOT_COVERAGE_PCT_FACT_SOURCE,
  entityId: "48021:27246",
  absence: {
    kind: "absent-verified",
    reason: ENVELOPE_ROUTER_NOT_A_DISTRICT,
  },
  verifiedAbsence: true,
  sourceTier: "envelope-corpus-lookup",
  sourceAdapter: "parcel_record",
  sourceVintage: "2026-09-11",
};

const PI_ABSENT_FOOTPRINT: MaxFootprintSqFtFactRead = {
  state: "absent",
  source: MAX_FOOTPRINT_SQFT_FACT_SOURCE,
  entityId: "48021:27246",
  absence: {
    kind: "absent-verified",
    reason: ENVELOPE_ROUTER_NOT_A_DISTRICT,
  },
  verifiedAbsence: true,
  sourceTier: "envelope-corpus-lookup",
  sourceAdapter: "parcel_record",
  sourceVintage: "2026-09-11",
};

describe("P-445 envelope-derived fact coherence", () => {
  it("looks up the PI chart row on the BDC table", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "PI");
    expect(row.tableHasDistrictRow).toBe(true);
    expect(row.district?.max_height_ft).toBe(55);
  });

  it("does not call a present PI district 'not a district' for height; serves the chart 55 ft", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "PI");
    const out = reconcileMaxHeightFtFact(PI_ABSENT_HEIGHT, true, row);
    expect(out.state).toBe("present");
    if (out.state === "present") expect(out.feet).toBe(55);
  });

  it("lot coverage on PI is not specified — same district, field-not-specified, never not-a-district", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "PI");
    const out = reconcileMaxLotCoveragePctFact(PI_ABSENT_COVERAGE, true, row);
    expect(out.state).toBe("absent");
    if (out.state === "absent") {
      expect(out.absence?.reason).toBe(ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED);
    }
  });

  it("max footprint follows lot coverage: field-not-specified when zoning is PI", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "PI");
    const out = reconcileMaxFootprintSqFtFact(PI_ABSENT_FOOTPRINT, true, row);
    expect(out.state).toBe("absent");
    if (out.state === "absent") {
      expect(out.absence?.reason).toBe(ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED);
    }
  });

  it("a district with no chart row (MU) is code-sets-none, never not-a-district", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "MU");
    expect(row.tableHasDistrictRow).toBe(false);
    const out = reconcileMaxHeightFtFact(PI_ABSENT_HEIGHT, true, row);
    expect(out.state).toBe("absent");
    if (out.state === "absent") {
      expect(out.absence?.reason).toBe(ENVELOPE_ROUTER_CODE_SETS_NONE);
    }
  });

  it("leaves the factory finding alone when zoning is not a present district", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "PI");
    const out = reconcileMaxHeightFtFact(PI_ABSENT_HEIGHT, false, row);
    expect(out.state).toBe("absent");
    if (out.state === "absent") {
      expect(out.absence?.reason).toBe(ENVELOPE_ROUTER_NOT_A_DISTRICT);
    }
  });
});

/**
 * W3 PR #805 review: getSetbackTableForZoning now throws a named setback refusal for a Burnet
 * district whose source is unverified, superseded, ambiguous, conditional, has no dimensional
 * standards, or clears the register with no vendored table -- instead of silently returning null.
 * lookUpEnvelopeTableRow has a real route (propertyExplorer.ts) and a typed decline shape
 * (EnvelopeTableRowLookup.sourceRefusal) to carry the code through, which it reuses rather than
 * inventing a new one -- never a 500 for this read. A non-refusal error (a real bug) must still
 * throw.
 */
describe("lookUpEnvelopeTableRow declines the setback-refusal family by code, never throws it (W3 PR #805 review)", () => {
  it("a Marble Falls parcel (ENZ.2, SETBACK_EDITION_UNVERIFIED after the W3 register downgrade) declines, no throw, and carries the code onto the row", () => {
    expect(() => lookUpEnvelopeTableRow("marble-falls-tx", "ENZ.2")).not.toThrow();
    const row = lookUpEnvelopeTableRow("marble-falls-tx", "ENZ.2");
    expect(row.tableHasDistrictRow).toBe(false);
    expect(row.district).toBeNull();
    expect(row.sourceRefusal?.code).toBe("SETBACK_EDITION_UNVERIFIED");
  });

  it("that refusal, reconciled onto an absent height fact, says WHY instead of the generic code-sets-none", () => {
    const row = lookUpEnvelopeTableRow("marble-falls-tx", "ENZ.2");
    const out = reconcileMaxHeightFtFact(PI_ABSENT_HEIGHT, true, row);
    expect(out.state).toBe("absent");
    if (out.state === "absent") {
      expect(out.absence?.reason).toBe(
        `${ENVELOPE_ROUTER_SETBACK_SOURCE_REFUSED}:SETBACK_EDITION_UNVERIFIED`,
      );
    }
  });

  it("a served Bertram district (R-1-2) still resolves to a real row, unaffected by the refusal handling", () => {
    const row = lookUpEnvelopeTableRow("bertram-tx", "R-1-2");
    expect(row.tableHasDistrictRow).toBe(true);
    expect(row.sourceRefusal).toBeUndefined();
    expect(row.district?.front_ft).toBe(20);
    expect(row.district?.side_ft).toBe(5);
    expect(row.district?.rear_ft).toBe(15);
    expect(row.district?.side_corner_ft).toBe(15);
  });

  it("a non-refusal error (a real bug) still throws, uncaught", () => {
    expect(() => lookUpEnvelopeTableRow("bastrop-tx", "__NON_REFUSAL_BUG__")).toThrow(/real bug/);
  });
});
