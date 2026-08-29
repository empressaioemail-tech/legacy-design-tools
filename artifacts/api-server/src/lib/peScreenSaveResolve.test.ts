import { describe, expect, it, vi } from "vitest";
import { resolveScreenQuery } from "./peScreenSaveResolveCore";

const GOLD = "48021:34137";
const JUNK = "zzzz-not-a-situs-99999";

describe("resolveScreenQuery", () => {
  it("returns a parsed node id without calling situs search", async () => {
    const search = vi.fn(async () => {
      throw new Error("searchPlaceByPrefix must not run for a node id");
    });
    await expect(resolveScreenQuery(GOLD, search)).resolves.toEqual([
      { parcelNodeId: GOLD, label: GOLD },
    ]);
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves a junk query on the situs path", async () => {
    const search = vi.fn(async () => []);
    await expect(resolveScreenQuery(JUNK, search)).resolves.toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toEqual({ query: JUNK, limit: 10 });
  });
});
