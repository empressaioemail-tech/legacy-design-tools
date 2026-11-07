import { describe, expect, it, vi } from "vitest";
import { resolveScreenQuery } from "./peScreenSaveResolveCore";

const GOLD = "48021:34137";
const JUNK = "zzzz-not-a-situs-99999";

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

  it("propagates a node-id lookup throw instead of answering [] (a refuse, never an absence)", async () => {
    const search = vi.fn(async () => {
      throw new Error("searchPlaceByPrefix must not run for a node id");
    });
    const lookup = vi.fn(async () => {
      throw new Error("store down");
    });
    await expect(resolveScreenQuery(GOLD, search, lookup)).rejects.toThrow(
      "store down",
    );
    expect(lookup).toHaveBeenCalledWith(GOLD);
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves a junk query on the situs path and never consults the node lookup", async () => {
    const search = vi.fn(async () => []);
    const lookup = vi.fn(async () => {
      throw new Error("lookup must not run for a non-node query");
    });
    await expect(resolveScreenQuery(JUNK, search, lookup)).resolves.toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ query: JUNK, limit: 10 });
    expect(lookup).not.toHaveBeenCalled();
  });
});
