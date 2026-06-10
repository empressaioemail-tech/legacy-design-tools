/**
 * S1 integration — multi-standard accessibility input produces a single
 * governing precedence finding with all compared citations preserved.
 */

import { describe, expect, it } from "vitest";
import { generateFindings } from "../engine";
import {
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
} from "../precedence";
import type { GenerateFindingsInput } from "../types";

function baseInput(
  codeSections: GenerateFindingsInput["codeSections"],
): GenerateFindingsInput {
  return {
    submission: {
      id: "sub-s1-test",
      jurisdiction: "bastrop-tx",
      projectName: "S1 precedence wire",
      note: null,
    },
    sources: [],
    codeSections,
    bimElements: [],
  };
}

describe("S1 — precedence in production finding path", () => {
  it("ADA+FHA+A117.1 produces governing finding with all compared atomIds", async () => {
    const result = await generateFindings(
      baseInput([
        {
          atomId: ADA_DOOR_CLEARANCE_ATOM_ID,
          label: "ADA §404.2.3.2 latch-side clearance",
          snippet: "Minimum 18 inches latch-side clearance.",
        },
        {
          atomId: FHA_DOOR_CLEARANCE_ATOM_ID,
          label: "FHA Design Manual Ch.4 door maneuvering clearance",
          snippet: "24 inches latch-side clearance at entrance doors.",
        },
        {
          atomId: A1171_DOOR_CLEARANCE_ATOM_ID,
          label: "A117.1 §404.2.3.2 latch-side clearance (stub)",
          snippet: "Stub section — 18 inches latch-side clearance.",
        },
      ]),
      { mode: "mock", ulid: () => "S1TESTULID00000000001" },
    );

    const precedenceFindings = result.findings.filter((f) =>
      f.text.includes("Precedence reconciliation"),
    );
    expect(precedenceFindings.length).toBeGreaterThanOrEqual(1);

    const finding = precedenceFindings[0]!;
    expect(finding.text).toContain("most-stringent-governs");
    expect(finding.text).toContain(FHA_DOOR_CLEARANCE_ATOM_ID);
    expect(finding.citations.map((c) => (c.kind === "code-section" ? c.atomId : c.id))).toEqual(
      expect.arrayContaining([
        ADA_DOOR_CLEARANCE_ATOM_ID,
        FHA_DOOR_CLEARANCE_ATOM_ID,
        A1171_DOOR_CLEARANCE_ATOM_ID,
      ]),
    );
    expect(finding.confidence).toBe(0.75);
  });

  it("single accessibility section does not emit precedence finding", async () => {
    const result = await generateFindings(
      baseInput([
        {
          atomId: ADA_DOOR_CLEARANCE_ATOM_ID,
          label: "ADA §404.2.3.2 latch-side clearance",
        },
      ]),
      { mode: "mock", ulid: () => "S1TESTULID00000000002" },
    );

    expect(
      result.findings.some((f) => f.text.includes("Precedence reconciliation")),
    ).toBe(false);
  });
});
