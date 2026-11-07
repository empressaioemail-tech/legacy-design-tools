/**
 * P-428. The claude.ai board reads tool results by shape (structuredContent or JSON
 * text part), not first-text prose. Tiles probe hits tiles.json on the origin.
 */
import { describe, expect, it } from "vitest";
import { shapeSmartSiteNodeResult } from "../src/tools.js";
import { parseToolContent, parcelTilesProbeUrl, probeNetTargets } from "../src/mcp-app.js";

const LIVE_RECORD =
  '{"parcelNodeId":"48021:34137","draw":{"label":"908 PINE , BASTROP, TX 78602","ring":[[48.6,83.94],[-50.37,83.7],[-49.07,-84.28],[50.84,-83.36]],"overlays":[]}}';

function shapedGetSmartSite() {
  return shapeSmartSiteNodeResult(LIVE_RECORD);
}

describe("P-428 parseToolContent (exported parser)", () => {
  it("P-399 get_smart_site shape: prose-first content does not yield unreadable when record is in content[1]", () => {
    const shaped = shapedGetSmartSite();
    const model = parseToolContent(shaped);
    expect(model.kind).toBe("parcel");
    expect(model.parcelNodeId).toBe("48021:34137");
  });

  it("prefers structuredContent when the host delivers it (prose-only content parts)", () => {
    const shaped = shapedGetSmartSite();
    const prose = shaped.content[0];
    const link = shaped.content.find((c) => c.type === "resource_link");
    const model = parseToolContent({
      content: [prose, link].filter(Boolean),
      structuredContent: shaped.structuredContent,
    });
    expect(model.kind).toBe("parcel");
    expect(model.parcelNodeId).toBe("48021:34137");
  });

  it("pre-P-399 wire (record only in structuredContent): still parses via structuredContent", () => {
    const record = JSON.parse(LIVE_RECORD) as Record<string, unknown>;
    const prose = { type: "text" as const, text: "Summary prose only, not JSON." };
    const model = parseToolContent({
      content: [prose, { type: "resource_link" as const, uri: "ui://smartsite/app-p562.html", name: "x", mimeType: "text/html" }],
      structuredContent: record,
    });
    expect(model.kind).toBe("parcel");
  });

  it("tiles probe URL is tiles.json, not the bare origin", () => {
    const tiles = probeNetTargets().find((t) => t.key === "tiles");
    expect(tiles?.url).toBe(parcelTilesProbeUrl());
    expect(tiles?.url.endsWith("/tiles.json")).toBe(true);
    expect(tiles?.url).not.toBe(process.env.PARCEL_TILES_ORIGIN);
  });
});
