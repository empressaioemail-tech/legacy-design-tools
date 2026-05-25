import { describe, expect, it } from "vitest";
import { floorPlanSheetSourceId, parseFloorPlanSheetSourceId } from "../sourceIds";

describe("floorPlanSheetSourceId", () => {
  it("round-trips engagement + sheet ids", () => {
    const engagementId = "550e8400-e29b-41d4-a716-446655440000";
    const sheetId = "a101";
    const sourceId = floorPlanSheetSourceId(engagementId, sheetId);
    expect(parseFloorPlanSheetSourceId(sourceId)).toEqual({
      engagementId,
      sheetId,
    });
  });
});
