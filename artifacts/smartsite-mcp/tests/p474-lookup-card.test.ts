import { describe, expect, it } from "vitest";
import { lookupCardFrom, nearestNeighborsFrom, parseToolResult } from "../src/card/panel-lib.js";
import { composeInlineCard } from "../src/inline-card.js";

describe("P-474 lookup cards", () => {
  it("Houston-style in-Texas outside coverage is distinct from Phoenix", () => {
    const houston = lookupCardFrom({
      hits: [],
      missClass: "in_texas_outside_full_coverage",
    });
    expect(houston?.lookup?.headline).toMatch(/In Texas, outside the counties we fully cover/i);
    const phoenix = lookupCardFrom({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
    expect(phoenix?.lookup?.headline).toMatch(/Outside Texas, not covered/i);
  });

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

  it("declared upstream errors stay declared, not lookup cards (H1 / P-101)", () => {
    const model = parseToolResult(
      JSON.stringify({ status: "error", reason: "not_found", upstreamStatus: 404 }),
    );
    expect(model.kind).toBe("declared");
    expect(model.declared?.reason).toBe("not_found");
  });

  it("find_parcel HTML outage paints a lookup card (P-474 item 2)", () => {
    const model = parseToolResult(
      JSON.stringify({
        hits: [],
        missClass: "no-hit",
        status: "error",
        reason: "upstream_non_json",
        brief: "<html>502</html>",
      }),
    );
    expect(model.kind).toBe("lookup");
    expect(model.lookup?.state).toBe("outage");
  });

  it("nearest neighbors parse distance and Adjacent label", () => {
    const out = nearestNeighborsFrom({
      subjectParcelNodeId: "48021:32342",
      parcels: [
        { parcelNodeId: "48021:32324", label: "1303 FAYETTE ST", distanceFt: 0.4 },
        { parcelNodeId: "48021:32350", label: "1307 FAYETTE ST", distanceFt: 88.7 },
      ],
    });
    expect(out?.rows.length).toBe(2);
    expect(out?.rows[0]?.distanceFt).toBe(0.4);
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
