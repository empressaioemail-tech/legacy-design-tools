import { describe, it, expect } from "vitest";
import { wrapForStorage, unwrapFromStorage } from "./vda";

describe("vda no-op envelope", () => {
  it("wraps and unwraps a value through the envelope", () => {
    const value = { hello: "world", n: 42 };
    const wrapped = wrapForStorage(value);
    expect(wrapped.envelope).toEqual({ version: 1, vdaApplied: false });
    expect(wrapped.payload).toBe(value);
    expect(unwrapFromStorage(wrapped)).toBe(value);
  });

  it("returns plain (non-envelope) input as-is", () => {
    const raw = { unwrapped: true };
    expect(unwrapFromStorage(raw)).toBe(raw);
  });

  it("never mutates the input value", () => {
    const value = { count: 1 };
    wrapForStorage(value);
    expect(value).toEqual({ count: 1 });
  });
});
