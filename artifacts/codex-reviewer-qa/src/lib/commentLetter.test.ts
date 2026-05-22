import { describe, it, expect } from "vitest";
import { makeFinding } from "../__fixtures__/findings";
import {
  composeCommentLetterDraft,
  findingProvenanceIds,
  isLetterEligible,
  letterEligibleFindings,
} from "./commentLetter";

describe("isLetterEligible", () => {
  it("includes accepted findings", () => {
    expect(isLetterEligible(makeFinding({ status: "accepted" }))).toBe(true);
  });

  it("includes an edited (overridden) revision row", () => {
    expect(
      isLetterEligible(
        makeFinding({ status: "overridden", revisionOf: "finding:sub-1:00" }),
      ),
    ).toBe(true);
  });

  it("excludes the superseded override original (no revisionOf)", () => {
    expect(
      isLetterEligible(makeFinding({ status: "overridden", revisionOf: null })),
    ).toBe(false);
  });

  it("excludes rejected, ai-produced, and promoted findings", () => {
    expect(isLetterEligible(makeFinding({ status: "rejected" }))).toBe(false);
    expect(isLetterEligible(makeFinding({ status: "ai-produced" }))).toBe(false);
    expect(
      isLetterEligible(makeFinding({ status: "promoted-to-architect" })),
    ).toBe(false);
  });
});

describe("letterEligibleFindings", () => {
  it("keeps only accepted + edited findings and orders blockers first", () => {
    const findings = [
      makeFinding({ id: "f-advisory", severity: "advisory", status: "accepted" }),
      makeFinding({ id: "f-rejected", status: "rejected" }),
      makeFinding({ id: "f-blocker", severity: "blocker", status: "accepted" }),
      makeFinding({ id: "f-ai", status: "ai-produced" }),
    ];
    const result = letterEligibleFindings(findings);
    expect(result.map((f) => f.id)).toEqual(["f-blocker", "f-advisory"]);
  });
});

describe("findingProvenanceIds", () => {
  it("names just the finding atom when it is not a revision", () => {
    expect(findingProvenanceIds(makeFinding({ id: "f1", revisionOf: null }))).toEqual(
      ["f1"],
    );
  });

  it("names the revision and the original AI atom it revised", () => {
    expect(
      findingProvenanceIds(
        makeFinding({ id: "f1-rev", revisionOf: "f1-original" }),
      ),
    ).toEqual(["f1-rev", "f1-original"]);
  });
});

describe("composeCommentLetterDraft", () => {
  const baseInput = {
    engagementName: "Musgrave Residence",
    jurisdiction: "Grand County",
    submittedAt: "2026-05-20T00:00:00.000Z",
  };

  it("orders sections cover, intro, per-comment..., signature", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [
        makeFinding({ id: "f1", status: "accepted" }),
        makeFinding({ id: "f2", severity: "advisory", status: "accepted" }),
      ],
    });
    expect(draft.sections.map((s) => s.kind)).toEqual([
      "cover",
      "intro",
      "per-comment-response",
      "per-comment-response",
      "signature",
    ]);
  });

  it("excludes rejected and un-adjudicated findings from the body", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [
        makeFinding({ id: "f1", status: "accepted" }),
        makeFinding({ id: "f2", status: "rejected" }),
        makeFinding({ id: "f3", status: "ai-produced" }),
      ],
    });
    const perComment = draft.sections.filter(
      (s) => s.kind === "per-comment-response",
    );
    expect(perComment).toHaveLength(1);
  });

  it("maps each per-comment section to its finding provenance by index", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [
        makeFinding({ id: "f-blocker", severity: "blocker", status: "accepted" }),
        makeFinding({
          id: "f-edit",
          severity: "concern",
          status: "overridden",
          revisionOf: "f-edit-original",
        }),
      ],
    });
    expect(draft.provenancePlan).toEqual([
      { sectionIndex: 2, findingIds: ["f-blocker"] },
      { sectionIndex: 3, findingIds: ["f-edit", "f-edit-original"] },
    ]);
  });

  it("carries reasoning, citations, and confidence in a comment body", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [
        makeFinding({
          id: "f1",
          status: "accepted",
          text: "Front setback is 12 ft; R-1 requires 25 ft.",
          confidence: 0.82,
        }),
      ],
    });
    const body = draft.sections[2]!.content;
    expect(body).toContain("Front setback is 12 ft; R-1 requires 25 ft.");
    expect(body).toContain("Code cited: code-section:grand-county:r1-setbacks");
    expect(body).toContain("Engine confidence: 82%");
  });

  it("notes a reviewer revision and comment on an edited finding", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [
        makeFinding({
          id: "f1",
          status: "overridden",
          revisionOf: "f1-original",
          reviewerComment: "Tightened the wording.",
        }),
      ],
    });
    const body = draft.sections[2]!.content;
    expect(body).toContain("revised by the reviewer");
    expect(body).toContain("Reviewer note: Tightened the wording.");
  });

  it("titles the letter after the engagement and names the jurisdiction", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [makeFinding({ status: "accepted" })],
    });
    expect(draft.title).toBe("Comment Letter — Musgrave Residence");
    expect(draft.sections[0]!.content).toContain("Musgrave Residence");
    expect(draft.sections[0]!.content).toContain("Grand County");
  });

  it("still composes a complete shell when no findings are eligible", () => {
    const draft = composeCommentLetterDraft({
      ...baseInput,
      findings: [makeFinding({ status: "rejected" })],
    });
    expect(draft.sections.map((s) => s.kind)).toEqual([
      "cover",
      "intro",
      "signature",
    ]);
    expect(draft.provenancePlan).toEqual([]);
  });
});
