import { describe, expect, it } from "vitest";
import { computeCostUsd } from "../instrumentedClient";

describe("eval price table (Anthropic list prices cached 2026-10-06)", () => {
  it("prices claude-opus-5-5 at 4 USD in / 20 USD out per MTok", () => {
    expect(computeCostUsd("claude-opus-5-5", 1_000_000, 1_000_000)).toBeCloseTo(24);
  });
  it("prices claude-opus-4-8 at 5 USD in / 25 USD out per MTok", () => {
    expect(computeCostUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(30);
  });
});
