import { describe, it, expect } from "vitest";
import { buildRulesLaySummary } from "../lib/propertyBriefLaySummary";

describe("buildRulesLaySummary", () => {
  it("returns at least 3 verdicts for in-corpus Bastrop fixture", () => {
    const result = buildRulesLaySummary({
      address: "251 Cool Water Dr, Bastrop, TX 78602",
      jurisdiction: "bastrop_tx",
      corpusStatus: "in_corpus",
      atoms: [
        {
          atomDid: "did:hauska:atom:bastrop-adu-1",
          snippet: "ADU setback rules apply",
          label: "Accessory dwelling units",
        },
      ],
      siteContext: {
        placeKey: "coord:30.11000:-97.32000",
        layers: [
          {
            layerKind: "fema-nfhl-flood-zone",
            adapterKey: "fema:nfhl-flood-zone",
            tier: "federal",
            status: "ok",
            summary: "Flood Zone AE (high-risk)",
          },
        ],
      },
      presentationMode: "consumer",
      finishedAt: new Date().toISOString(),
    });

    expect(result.verdicts.length).toBeGreaterThanOrEqual(3);
    expect(result.verdicts.map((v) => v.id)).toContain("adu");
    expect(result.verdicts.map((v) => v.id)).toContain("flood");
    expect(result.verdicts.map((v) => v.id)).toContain("corpus_coverage");
    for (const v of result.verdicts) {
      expect(["yes", "maybe", "no", "unknown"]).toContain(v.status);
      expect(v.oneLine.length).toBeGreaterThan(5);
    }
  });
});
