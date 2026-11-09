import { afterEach, describe, expect, it, vi } from "vitest";

const loadZoningFactForServeMock = vi.hoisted(() => vi.fn());
const loadSetbacksFactForServeMock = vi.hoisted(() => vi.fn());

vi.mock("../zoningFactServeCutover", () => ({
  loadZoningFactForServe: loadZoningFactForServeMock,
}));
vi.mock("../setbacksFactServeCutover", () => ({
  loadSetbacksFactForServe: loadSetbacksFactForServeMock,
}));

const { decideEnvelopeFromLedger } = await import("./ledgerEnvelopeRails");

function present(cornerFt: number | null) {
  loadZoningFactForServeMock.mockResolvedValue({
    state: "present",
    entityId: "48453:832328",
    district: "R-1",
    jurisdictionKey: "lakeway-tx",
    provenance: "tx_zoning_district_staging",
    sourceVintage: "2026-09-02",
  });
  loadSetbacksFactForServeMock.mockResolvedValue({
    state: "present",
    entityId: "48453:832328",
    frontFt: 25,
    sideFt: 5,
    rearFt: 5,
    cornerFt,
    sourceVintage: "2026-09-19",
  });
}

afterEach(() => {
  loadZoningFactForServeMock.mockReset();
  loadSetbacksFactForServeMock.mockReset();
});

describe("decideEnvelopeFromLedger corner sentinel", () => {
  it("reads a stated corner setback as feet", async () => {
    present(15);
    const decision = await decideEnvelopeFromLedger("48453:832328");
    expect(decision.state).toBe("values");
    if (decision.state !== "values") return;
    expect(decision.resolved.scalars.side_corner_ft).toBe(15);
  });

  it("treats the corpus 999 corner as not specified, not as 999 feet", async () => {
    present(999);
    const decision = await decideEnvelopeFromLedger("48453:832328");
    expect(decision.state).toBe("values");
    if (decision.state !== "values") return;
    expect(decision.resolved.scalars.side_corner_ft).toBeUndefined();
    expect(decision.resolved.district.district.provenance?.side_corner_ft).toEqual({
      not_specified: true,
    });
  });
});

describe("decideEnvelopeFromLedger carries the district a setback decline is about", () => {
  it("names the zoning cell's district when the setback rail refused", async () => {
    present(15);
    loadSetbacksFactForServeMock.mockResolvedValue({
      state: "refused",
      code: "parcel-record-engine-refused",
      entityId: "48021:34105",
      reason: 'district "GC" is on file for this parcel in Bastrop, but no row',
    });
    const decision = await decideEnvelopeFromLedger("48021:34105");
    expect(decision.state).toBe("declined");
    if (decision.state !== "declined") return;
    expect(decision.rail).toBe("setbackFrontFt");
    expect(decision.ledgerDistrict).toBe("R-1");
  });

  it("carries no district when the zoning rail itself declined", async () => {
    loadZoningFactForServeMock.mockResolvedValue({
      state: "absent",
      entityId: "48021:34105",
      absence: { kind: "not-applicable", reason: "unincorporated" },
    });
    loadSetbacksFactForServeMock.mockResolvedValue(null);
    const decision = await decideEnvelopeFromLedger("48021:34105");
    expect(decision.state).toBe("declined");
    if (decision.state !== "declined") return;
    expect(decision.ledgerDistrict).toBeNull();
  });
});

describe("operator option A (2026-11-09): setbacks from the 2026 Development Code chart say so", () => {
  const ORD = "https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE%20NO.%202026-06%20B3%20Code%20Repeal%20and%20Bastrop%20Development%20Code%20Adoption.pdf";
  function mu(chartSource: Record<string, unknown> | undefined) {
    loadZoningFactForServeMock.mockResolvedValue({ state: "present", entityId: "48021:33977", district: "MU", jurisdictionKey: "bastrop-development-code", provenance: "zoning-cell", sourceVintage: "2026-11-09" });
    loadSetbacksFactForServeMock.mockResolvedValue({
      state: "present",
      entityId: "48021:33977",
      frontFt: 15,
      sideFt: 10,
      rearFt: 15,
      cornerFt: 10,
      sourceVintage: "2026-11-09",
      ...(chartSource ? { chartSource } : {}),
    });
  }

  it("1102 Pecan St (MU): the 2026 chart is the source, with its section, the ordinance link and its effective date", async () => {
    mu({ label: "2026 Development Code (Ord. 2026-06)", section: "14.02.003.F.3", page: "Page 11 of 191", ordinanceUrl: ORD, abutsResidential: true, note: "Applied 10 ft to all sides because one side abuts a residential district." });
    const decision = await decideEnvelopeFromLedger("48021:33977");
    expect(decision.state).toBe("values");
    if (decision.state !== "values") return;
    expect(decision.resolved.scalars.side_ft).toBe(10);
    expect(decision.resolved.sourceLabel).toBe(
      "2026 Bastrop Development Code (Ord. 2026-06), Sec. 14.02.003.F.3; the city's map still shows the repealed rule. Applied 10 ft to all sides because one side abuts a residential district.",
    );
    expect(decision.resolved.citationUrl).toBe(ORD);
    expect(decision.resolved.effectiveDate).toBe("2026-04-14");
    expect(decision.resolved.dateBasis).toBe("ordinance-effective-date");
  });

  it("any other source keeps the parcel_record label and its own vintage", async () => {
    mu(undefined);
    const decision = await decideEnvelopeFromLedger("48021:33977");
    if (decision.state !== "values") throw new Error("expected values");
    expect(decision.resolved.sourceLabel).toBe("parcel_record setbackFrontFt/setbackSideFt/setbackRearFt/setbackCornerFt");
    expect(decision.resolved.dateBasis).toBe("unreadable");
    expect(decision.resolved.citationUrl).toBe("zoning-cell");
  });
});
