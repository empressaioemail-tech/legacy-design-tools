import { describe, expect, it } from "vitest";
import { lookupCardFrom, parseToolResult } from "../src/card/panel-lib.js";
import { composeInlineCard } from "../src/inline-card.js";

describe("P-474 lookup cards", () => {
  it("find_parcel out_of_coverage paints a distinct lookup card", () => {
    const text = JSON.stringify({
      hits: [],
      missClass: "out_of_coverage",
      missClassDisplayText: "Outside Texas, not covered",
      outOfCoverageState: "AZ",
    });
    const model = parseToolResult(text);
    expect(model.kind).toBe("lookup");
    expect(model.lookup?.state).toBe("out_of_coverage");
    expect(model.lookup?.headline).toContain("Outside Texas");
  });

  it("no-hit carries the city state ZIP hint", () => {
    const model = lookupCardFrom({ hits: [], missClass: "no-hit" });
    expect(model?.lookup?.detail).toMatch(/city, state and ZIP/i);
  });

  it("five-parcel find_parcels wire prefers carousel over single brief", () => {
    const data = {
      parcels: [
        { parcelNodeId: "48021:1", draw: { label: "1 A ST" }, brief: { sections: [] } },
        { parcelNodeId: "48021:2", draw: { label: "2 A ST" }, brief: { sections: [] } },
        { parcelNodeId: "48021:3", draw: { label: "3 A ST" }, brief: { sections: [] } },
        { parcelNodeId: "48021:4", draw: { label: "4 A ST" }, brief: { sections: [] } },
        { parcelNodeId: "48021:5", draw: { label: "5 A ST" }, brief: { sections: [] } },
      ],
      brief: { sections: [{ id: "zoning", disposition: "present", data: { district: "SF-1" } }] },
    };
    const card = composeInlineCard(data, null, () => null);
    expect(card?.layout).toBe("carousel");
    expect(card?.items.length).toBe(5);
  });
});
