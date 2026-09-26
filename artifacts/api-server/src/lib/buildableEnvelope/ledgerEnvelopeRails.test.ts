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
