import { describe, it, expect } from "vitest";
import { extractMudPidAssessmentFlags } from "@workspace/adapters/national/cotalityInvestorDepth";
import { computePencilsAt } from "../brokeragePencilsAt";
import { lookupOpportunityZone } from "../opportunityZoneAdapter";

describe("investor radar depth helpers", () => {
  it("extractMudPidAssessmentFlags detects MUD/PID in tax payload", () => {
    const flags = extractMudPidAssessmentFlags(
      { lineItems: ["PID assessment district 42"] },
      null,
    );
    expect(flags.mudPidDetected).toBe(true);
  });

  it("computePencilsAt returns basis from cited inputs", () => {
    const result = computePencilsAt({
      buyBox: { capRateFloor: 0.1, rehabPerSf: 0, rentSpreadTolerance: 0 },
      monthlyRent: 2000,
      annualTax: 5000,
    });
    expect(result.pencilsAtBasis).toBeGreaterThan(0);
    expect(result.disclaimer).toMatch(/not an appraisal/i);
  });

  it("lookupOpportunityZone hits Austin fixture tract", () => {
    const oz = lookupOpportunityZone({ latitude: 30.25, longitude: -97.77 });
    expect(oz.inOpportunityZone).toBe(true);
    expect(oz.tractListVersion).toBe("oz-1.0");
  });
});
