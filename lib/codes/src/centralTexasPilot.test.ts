import { describe, it, expect } from "vitest";
import { keyFromEngagement } from "./jurisdictions";
import {
  BLOCKED_CITY_STATE_KEYS,
  resolveCentralTexasJurisdictionKey,
  getPilotCoverageTier,
  listPilotJurisdictionManifest,
} from "./centralTexasPilot";

describe("centralTexasPilot geocode", () => {
  it("resolves Round Rock and Plano via geocode aliases", () => {
    expect(
      keyFromEngagement({
        jurisdictionCity: "Round Rock",
        jurisdictionState: "TX",
      }),
    ).toBe("round_rock_tx");
    expect(
      keyFromEngagement({
        jurisdictionCity: "Plano",
        jurisdictionState: "TX",
      }),
    ).toBe("plano_tx");
    expect(resolveCentralTexasJurisdictionKey("round rock|tx")).toBe(
      "round_rock_tx",
    );
    expect(resolveCentralTexasJurisdictionKey("plano|tx")).toBe("plano_tx");
  });

  it("blocks Dallas city partnership keys", () => {
    expect(
      keyFromEngagement({
        jurisdictionCity: "Dallas",
        jurisdictionState: "TX",
      }),
    ).toBeNull();
    expect(BLOCKED_CITY_STATE_KEYS["dallas|tx"]).toBe("blocked_partnership");
  });

  it("marks warmed LDT jurisdictions as neon tier", () => {
    expect(getPilotCoverageTier("cedar_hill_tx")).toBe("neon");
    expect(getPilotCoverageTier("austin_tx")).toBe("engine_only");
  });

  it("manifest lists engine corpus keys for coverage endpoint", () => {
    const manifest = listPilotJurisdictionManifest();
    const keys = manifest.map((m) => m.key);
    expect(keys).toContain("round_rock_tx");
    expect(keys).toContain("bastrop_tx");
    expect(manifest.find((m) => m.key === "round_rock_tx")?.tier).toBe(
      "engine_only",
    );
  });
});
