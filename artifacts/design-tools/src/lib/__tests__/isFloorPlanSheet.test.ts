import { describe, expect, it } from "vitest";
import { isFloorPlanSheet } from "../isFloorPlanSheet";

describe("isFloorPlanSheet", () => {
  it("matches explicit floor plan sheet names", () => {
    expect(
      isFloorPlanSheet({
        sheetNumber: "A1.01",
        sheetName: "First floor plan",
      }),
    ).toBe(true);
  });

  it("rejects elevations and site plans", () => {
    expect(
      isFloorPlanSheet({
        sheetNumber: "A2.01",
        sheetName: "Building elevation — north",
      }),
    ).toBe(false);
    expect(
      isFloorPlanSheet({
        sheetNumber: "C1.0",
        sheetName: "Site plan",
      }),
    ).toBe(false);
  });
});
