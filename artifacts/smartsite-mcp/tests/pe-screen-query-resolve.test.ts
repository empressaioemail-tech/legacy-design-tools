import { describe, expect, it, vi } from "vitest";
import { resolveScreenQuery } from "../../api-server/src/lib/peScreenSaveResolveCore.ts";

const GOLD = "48021:34137";
const JUNK = "zzzz-not-a-situs-99999";

// Same assertions as api-server peScreenSaveResolve.test.ts. This copy
// exists so the iframe worktree can fail closed without api-server node_modules.
describe("resolveScreenQuery", () => {
  it("returns a looked-up node id without calling situs search", async () => {
    const search = vi.fn(async () => {
      throw new Error("searchPlaceByPrefix must not run for a node id");
    });
    const lookup = vi.fn(async () => ({
      parcelNodeId: GOLD,
      label: "908 PINE , BASTROP, TX 78602",
    }));
    await expect(resolveScreenQuery(GOLD, search, lookup)).resolves.toEqual([
      { parcelNodeId: GOLD, label: "908 PINE , BASTROP, TX 78602" },
    ]);
    expect(search).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith(GOLD);
  });

  it("leaves a parsed node id unresolved when the parcel row is absent", async () => {
    const search = vi.fn(async () => {
      throw new Error("searchPlaceByPrefix must not run for a node id");
    });
    const lookup = vi.fn(async () => null);
    await expect(
      resolveScreenQuery("48021:900001", search, lookup),
    ).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not treat parse as found when lookup is missing", async () => {
    const search = vi.fn(async () => []);
    await expect(resolveScreenQuery(GOLD, search)).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves a junk query on the situs path", async () => {
    const search = vi.fn(async () => []);
    await expect(resolveScreenQuery(JUNK, search)).resolves.toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
