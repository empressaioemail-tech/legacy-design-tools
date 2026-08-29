import { describe, expect, it, vi } from "vitest";
import { resolveScreenQuery } from "../../api-server/src/lib/peScreenSaveResolveCore.ts";

const GOLD = "48021:34137";
const JUNK = "zzzz-not-a-situs-99999";

// Same assertions as api-server peScreenSaveResolve.test.ts. This copy
// exists so the iframe worktree can fail closed without api-server node_modules.
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
  });
});
