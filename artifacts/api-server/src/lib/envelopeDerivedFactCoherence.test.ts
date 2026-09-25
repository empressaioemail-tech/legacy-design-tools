import { describe, expect, it } from "vitest";

import {
  ENVELOPE_ROUTER_CODE_SETS_NONE,
  ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED,
  ENVELOPE_ROUTER_NOT_A_DISTRICT,
  lookUpEnvelopeTableRow,
  reconcileMaxFootprintSqFtFact,
  reconcileMaxHeightFtFact,
  reconcileMaxLotCoveragePctFact,
} from "./envelopeDerivedFactCoherence";
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
