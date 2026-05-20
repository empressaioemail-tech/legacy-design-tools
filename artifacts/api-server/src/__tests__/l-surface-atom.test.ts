/**
 * Unit coverage for the shared L-surface atom helper
 * (`lib/lSurfaceAtom.ts`) — the `contentHash` derivation every L1-L6
 * row→atom mapper depends on.
 */

import { describe, it, expect } from "vitest";
import {
  L_SURFACE_SOURCE_ADAPTER,
  contentHashOf,
} from "../lib/lSurfaceAtom";

describe("L_SURFACE_SOURCE_ADAPTER", () => {
  it("is the legacy-design-tools runtime identifier", () => {
    expect(L_SURFACE_SOURCE_ADAPTER).toBe("legacy-design-tools");
  });
});

describe("contentHashOf", () => {
  it("returns a 64-char sha256 hex digest", () => {
    const hash = contentHashOf({ title: "T", state: "open" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical input", () => {
    const a = contentHashOf({ title: "T", state: "open", findingId: null });
    const b = contentHashOf({ title: "T", state: "open", findingId: null });
    expect(a).toBe(b);
  });

  it("is independent of object key order", () => {
    const a = contentHashOf({ title: "T", state: "open" });
    const b = contentHashOf({ state: "open", title: "T" });
    expect(a).toBe(b);
  });

  it("changes when a domain field changes", () => {
    const open = contentHashOf({ title: "T", state: "open" });
    const done = contentHashOf({ title: "T", state: "done" });
    expect(open).not.toBe(done);
  });

  it("is sensitive to array element order (order is semantic)", () => {
    const ab = contentHashOf({ sections: ["a", "b"] });
    const ba = contentHashOf({ sections: ["b", "a"] });
    expect(ab).not.toBe(ba);
  });

  it("canonicalizes nested objects regardless of nested key order", () => {
    const a = contentHashOf({ spec: { x: 1, y: 2 } });
    const b = contentHashOf({ spec: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });
});
