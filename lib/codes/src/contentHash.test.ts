import { describe, it, expect } from "vitest";
import { contentHash, CONTENT_HASH_JOINER } from "./contentHash";

describe("contentHash", () => {
  it("returns a 64-char hex sha256", () => {
    const h = contentHash(["a", "b", "c"]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same inputs → same hash", () => {
    const h1 = contentHash(["alpha", "beta", "gamma"]);
    const h2 = contentHash(["alpha", "beta", "gamma"]);
    expect(h1).toBe(h2);
  });

  it("changes when any input changes", () => {
    const base = contentHash(["x", "y", "z"]);
    expect(contentHash(["x", "y", "Z"])).not.toBe(base);
    expect(contentHash(["x", "y", "z", ""])).not.toBe(base);
  });

  it("is order-sensitive", () => {
    const h1 = contentHash(["a", "b", "c"]);
    const h2 = contentHash(["c", "b", "a"]);
    expect(h1).not.toBe(h2);
  });

  it("is unambiguous across part boundaries (the joiner is U+0001)", () => {
    expect(CONTENT_HASH_JOINER).toBe("\u0001");
    // Join naively (concat with empty string) would collide; the joiner must
    // ensure these distinct part-arrays produce distinct hashes.
    const h1 = contentHash(["abc", "def"]);
    const h2 = contentHash(["abcdef"]);
    expect(h1).not.toBe(h2);
  });

  it("handles empty parts safely", () => {
    expect(contentHash([])).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash([""])).toMatch(/^[0-9a-f]{64}$/);
  });
});
