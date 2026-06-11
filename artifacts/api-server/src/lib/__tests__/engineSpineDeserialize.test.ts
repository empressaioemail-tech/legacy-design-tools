import { describe, expect, it } from "vitest";
import type { GenerateOrchestratedFindingsResult } from "@workspace/finding-engine";
import { rehydrateSpineFindingsResult } from "../engineSpineDeserialize";

describe("rehydrateSpineFindingsResult", () => {
  it("coerces ISO date strings on findings and generatedAt to Date", () => {
    const iso = "2026-06-11T05:50:24.000Z";
    const wire = {
      findings: [
        {
          atomId: "finding:sub:ABC",
          submissionId: "sub",
          severity: "concern",
          category: "egress",
          text: "test",
          citations: [],
          confidence: 0.8,
          lowConfidence: false,
          elementRef: null,
          sourceRef: null,
          aiGeneratedAt: iso,
        },
      ],
      invalidCitations: [],
      discardedFindings: [],
      generatedAt: iso,
      producer: "anthropic",
      orchestration: {
        orchestrated: true,
        disciplinesRun: ["building"],
        pieceCount: 1,
        deduplicatedCount: 0,
      },
    } as unknown as GenerateOrchestratedFindingsResult;
    const result = rehydrateSpineFindingsResult(wire);

    expect(result.generatedAt).toBeInstanceOf(Date);
    expect(result.findings[0]!.aiGeneratedAt).toBeInstanceOf(Date);
    expect(result.findings[0]!.aiGeneratedAt.toISOString()).toBe(iso);
  });

  it("passes through existing Date objects unchanged", () => {
    const now = new Date("2026-06-11T05:50:24.000Z");
    const result = rehydrateSpineFindingsResult({
      findings: [
        {
          atomId: "finding:sub:ABC",
          submissionId: "sub",
          severity: "concern",
          category: "egress",
          text: "test",
          citations: [],
          confidence: 0.8,
          lowConfidence: false,
          elementRef: null,
          sourceRef: null,
          aiGeneratedAt: now,
        },
      ],
      invalidCitations: [],
      discardedFindings: [],
      generatedAt: now,
      producer: "mock",
    });

    expect(result.generatedAt).toBe(now);
    expect(result.findings[0]!.aiGeneratedAt).toBe(now);
  });
});
