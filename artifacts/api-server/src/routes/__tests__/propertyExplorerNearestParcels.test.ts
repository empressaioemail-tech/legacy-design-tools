/**
 * Nearest-parcels route handler seam (search + stub facts), without loading
 * the full propertyExplorer module graph.
 */

import { describe, it, expect, vi } from "vitest";
import {
  dedupeNearestKnnRows,
  searchNearestParcels,
} from "../../lib/txgioNearestParcels";

describe("nearest parcels geometry + policy", () => {
  it("refuses Dallas (48113) by name, never an empty list", async () => {
    const result = await searchNearestParcels({
      parcelNodeId: "48113:12345",
      db: { query: async () => ({ rows: [] }) },
    });
    expect(result).toMatchObject({
      refused: true,
      code: "nearest_county_out_of_scope",
    });
    if ("reason" in result) {
      expect(result.reason).toMatch(/48113/);
    }
  });

  it("honors cap after tile dedupe", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      countyFips: "48021",
      propId: String(1000 + i),
      distanceFt: i * 5,
    }));
    const out = dedupeNearestKnnRows({
      rows,
      subjectParcelNodeId: "48021:9999",
      cap: 5,
    });
    expect(out.neighbors).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });
});
