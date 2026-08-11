import { describe, it, expect } from "vitest";

import { probeRailCapabilities, TEXAS_COUNTY_COUNT } from "../railCoverageCapability";

describe("probeRailCapabilities", () => {
  it("fail-closes with null and reason when no DB handle", async () => {
    const outcome = await probeRailCapabilities(undefined);
    expect(outcome.railCapabilities).toBeNull();
    expect(outcome).toHaveProperty("reason");
  });

  it("returns static hardcodes for rrc-wells and footprint when DB probes run", async () => {
    const outcome = await probeRailCapabilities({
      execute: async () => ({ rows: [{ n: 15 }] }),
    });
    expect(outcome.railCapabilities).not.toBeNull();
    const byKey = Object.fromEntries(
      outcome.railCapabilities!.map((c) => [c.railKey, c]),
    );
    expect(byKey["rrc-wells"]?.maxCountiesReachable).toBe(1);
    expect(byKey.footprint?.maxCountiesReachable).toBe(TEXAS_COUNTY_COUNT);
    expect(byKey.owner?.maxCountiesReachable).toBe(15);
  });
});
