import { describe, it, expect } from "vitest";
import { defaultScope } from "./scope";

describe("defaultScope", () => {
  it("returns the internal-audience baseline", () => {
    const scope = defaultScope();
    expect(scope.audience).toBe("internal");
    expect(scope.requestor).toBeUndefined();
    expect(scope.asOf).toBeUndefined();
    expect(scope.permissions).toBeUndefined();
  });

  it("returns a fresh object each call (no shared mutation)", () => {
    const a = defaultScope();
    const b = defaultScope();
    expect(a).not.toBe(b);
  });
});
