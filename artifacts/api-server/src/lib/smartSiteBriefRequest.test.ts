import { describe, expect, it } from "vitest";
import {
  parseSmartSiteBriefRequest,
  SMARTSITE_BATCH_CAP,
} from "./smartSiteBriefRequest";

describe("parseSmartSiteBriefRequest", () => {
  it("defaults a single id to node so existing Connect prompts stay full brief", () => {
    const parsed = parseSmartSiteBriefRequest({ parcelNodeId: "48021:34137" });
    expect(parsed).toMatchObject({
      ok: true,
      mode: "single",
      depth: "node",
      depthExplicit: false,
      ids: ["48021:34137"],
    });
  });

  it("defaults an array to stub, including a one-id array", () => {
    const parsed = parseSmartSiteBriefRequest({
      parcelNodeId: ["48021:34137", "48021:34169"],
    });
    expect(parsed).toMatchObject({ ok: true, mode: "batch", depth: "stub" });
    expect(
      parseSmartSiteBriefRequest({ parcelNodeId: ["not-a-parcel"] }),
    ).toMatchObject({ ok: true, mode: "batch", depth: "stub" });
  });

  it("refuses over cap without truncating", () => {
    const ids = Array.from({ length: SMARTSITE_BATCH_CAP + 1 }, (_, i) =>
      `48021:${10000 + i}`,
    );
    const parsed = parseSmartSiteBriefRequest({ parcelNodeId: ids });
    expect(parsed).toEqual({
      ok: false,
      error: "parcel_batch_cap",
      cap: SMARTSITE_BATCH_CAP,
      received: SMARTSITE_BATCH_CAP + 1,
    });
  });

  it("accepts exactly the cap", () => {
    const ids = Array.from({ length: SMARTSITE_BATCH_CAP }, (_, i) =>
      `48021:${10000 + i}`,
    );
    const parsed = parseSmartSiteBriefRequest({ parcelNodeId: ids, depth: "stub" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ids).toHaveLength(SMARTSITE_BATCH_CAP);
  });

  it("refuses hop1 and subgraph as not_implemented", () => {
    expect(
      parseSmartSiteBriefRequest({
        parcelNodeId: "48021:34137",
        depth: "hop1",
      }),
    ).toEqual({ ok: false, error: "not_implemented", depth: "hop1" });
    expect(
      parseSmartSiteBriefRequest({
        parcelNodeId: "48021:34137",
        depth: "subgraph",
      }),
    ).toEqual({ ok: false, error: "not_implemented", depth: "subgraph" });
  });
});
