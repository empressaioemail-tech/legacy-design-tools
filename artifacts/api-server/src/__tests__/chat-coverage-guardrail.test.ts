/**
 * QA-23 — in-app agent honesty guardrail.
 *
 * Pure unit test for `buildCoverageGuardrail`: when the engagement's
 * jurisdiction has no grounded code coverage the system prompt must carry
 * a hard instruction to flag code answers as ungrounded rather than
 * fabricating a confident citation (the bug that produced invented
 * "Grand County, Colorado" sections for a Pagosa Springs engagement).
 */

import { describe, it, expect } from "vitest";
import { buildCoverageGuardrail } from "../routes/coverageGuardrail";

describe("buildCoverageGuardrail", () => {
  it("appends nothing when the jurisdiction has code coverage", () => {
    expect(
      buildCoverageGuardrail({
        coverage: "covered",
        jurisdictionLabel: "Grand County, UT",
      }),
    ).toBe("");
  });

  it("emits a hard grounding guardrail when the jurisdiction has zero atoms", () => {
    const out = buildCoverageGuardrail({
      coverage: "no_atoms",
      jurisdictionLabel: "Pagosa Springs, CO",
    });
    expect(out).toContain("<jurisdiction_coverage_guardrail>");
    expect(out).toContain("</jurisdiction_coverage_guardrail>");
    // Names the jurisdiction so the agent's disclosure is specific.
    expect(out).toContain("Pagosa Springs, CO");
    // The jurisdiction is explicitly called out as absent from the corpus.
    expect(out).toContain("NOT in the Cortex code corpus");
    // The core honesty contract.
    expect(out).toContain("model-knowledge-only");
    expect(out).toContain("ungrounded");
    expect(out).toContain("quality-gate failure");
    // Fabricated citations are forbidden, not merely discouraged.
    expect(out).toMatch(/NOT present specific section numbers/);
  });

  it("emits the guardrail when the engagement has no recognized jurisdiction", () => {
    const out = buildCoverageGuardrail({
      coverage: "unrecognized",
      jurisdictionLabel: "this engagement's location",
    });
    expect(out).toContain("<jurisdiction_coverage_guardrail>");
    expect(out).toContain("no recognized jurisdiction");
    expect(out).toContain("model-knowledge-only");
    expect(out).toMatch(/NOT present specific section numbers/);
  });

  it("instructs the agent to verify against the real adopted code", () => {
    const out = buildCoverageGuardrail({
      coverage: "no_atoms",
      jurisdictionLabel: "Hutto, TX",
    });
    expect(out).toContain("Hutto, TX's actual adopted");
    expect(out).toContain("needs to be ingested");
  });
});
