import { describe, expect, it } from "vitest";
import { chartSourceOf } from "./setbacksFactFromParcelRecord";

describe("chartSourceOf: a factory cell written from the 2026 Bastrop chart (operator option A)", () => {
  it("reads the chart basis", () => {
    expect(
      chartSourceOf({ basis: { method: "bastrop-bdc-2026-chart", source: "2026 Development Code (Ord. 2026-06)", section: "14.02.003.F.3", page: "Page 11 of 191", ordinanceUrl: "https://x/o.pdf", abutsResidential: false, note: "n" } }),
    ).toEqual({ label: "2026 Development Code (Ord. 2026-06)", section: "14.02.003.F.3", page: "Page 11 of 191", ordinanceUrl: "https://x/o.pdf", abutsResidential: false, note: "n" });
  });
  it("is null for any other method or no basis", () => {
    expect(chartSourceOf({ basis: { method: "bastrop-layer23-per-parcel-record" } })).toBeNull();
    expect(chartSourceOf({})).toBeNull();
    expect(chartSourceOf(null)).toBeNull();
  });
});
