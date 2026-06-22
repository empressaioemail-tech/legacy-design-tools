import { describe, expect, it } from "vitest";
import {
  buildDeduplicatedReferences,
  mintReferenceEntry,
  reconcileReferencesWithFindings,
} from "../references";
import type { CodeSectionInput, EngineFinding } from "../types";

const sectionA: CodeSectionInput = {
  atomId: "code-ibc-404",
  label: "§404 — Door Clearance",
  provenance: {
    sectionIdentifier: "§404",
    sectionTitle: "Door Clearance",
    edition: "2021",
    sourceUrl: "https://example.test/ibc/404",
    codeTitle: "IBC",
  },
};

const sectionB: CodeSectionInput = {
  atomId: "code-ipmc-302",
  label: "302 — Light and Ventilation",
  provenance: {
    sectionIdentifier: "302",
    sectionTitle: "Light and Ventilation",
    edition: "2018",
    sourceUrl: "https://example.test/ipmc/302",
    codeTitle: "IPMC",
  },
};

function makeFinding(
  atomId: string,
  overrides: Partial<EngineFinding> = {},
): EngineFinding {
  return {
    atomId: "finding:sub-1:ULID",
    submissionId: "sub-1",
    severity: "concern",
    category: "egress",
    text: `Issue under [[CODE:${atomId}]] for review.`,
    citations: [{ kind: "code-section", atomId }],
    confidence: 0.8,
    lowConfidence: false,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("references", () => {
  it("mints reference rows from gate-returned provenance", () => {
    expect(mintReferenceEntry(sectionA)).toEqual({
      atomId: "code-ibc-404",
      sectionIdentifier: "§404",
      sectionTitle: "Door Clearance",
      edition: "2021",
      sourceUrl: "https://example.test/ibc/404",
      codeTitle: "IBC",
    });
  });

  it("builds deduplicated references only for cited allow-list atoms", () => {
    const findings = [
      makeFinding("code-ibc-404"),
      makeFinding("code-ibc-404"),
      makeFinding("code-ipmc-302"),
    ];
    const references = buildDeduplicatedReferences(findings, [
      sectionA,
      sectionB,
      { atomId: "code-not-cited", label: "Unused" },
    ]);
    expect(references).toHaveLength(2);
    expect(references.map((ref) => ref.atomId)).toEqual([
      "code-ibc-404",
      "code-ipmc-302",
    ]);
  });

  it("excludes hallucinated atom ids not in codeSections", () => {
    const findings = [makeFinding("code-fabricated")];
    const references = buildDeduplicatedReferences(findings, [sectionA]);
    expect(references).toEqual([]);
  });

  it("reconciles inline tokens against references[]", () => {
    const findings = [makeFinding("code-ibc-404")];
    const references = buildDeduplicatedReferences(findings, [sectionA]);
    expect(reconcileReferencesWithFindings(findings, references)).toEqual({
      orphanedInlineTokens: [],
      uncitedReferenceAtomIds: [],
    });
  });
});
