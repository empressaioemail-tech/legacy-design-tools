import { describe, expect, it } from "vitest";
import {
  assembleCommentLetter,
  groupFindingsForLetter,
  isOpenForCommentLetter,
  type CommentLetterFinding,
} from "./index";

const ctx = {
  jurisdictionLabel: "Springfield, IL",
  applicantFirm: "Acme Architects",
  submittedAt: "2026-04-01T00:00:00Z",
};

const findings: CommentLetterFinding[] = [
  {
    id: "finding:s1:1",
    severity: "blocker",
    category: "setback",
    status: "ai-produced",
    text: "Setback violates [[CODE:code:abc]].",
    elementRef: "wall:north",
  },
  {
    id: "finding:s1:2",
    severity: "advisory",
    category: "setback",
    status: "ai-produced",
    text: "Consider revising side setback.",
    elementRef: "wall:north",
  },
  {
    id: "finding:s1:3",
    severity: "concern",
    category: "height",
    status: "accepted",
    text: "Height nears overlay max.",
    elementRef: null,
  },
  {
    id: "finding:s1:4",
    severity: "blocker",
    category: "egress",
    status: "rejected",
    text: "ignored",
    elementRef: null,
  },
];

describe("assembleCommentLetter", () => {
  it("filters out rejected findings", () => {
    expect(isOpenForCommentLetter("rejected")).toBe(false);
    expect(isOpenForCommentLetter("accepted")).toBe(true);
    expect(isOpenForCommentLetter("ai-produced")).toBe(true);
  });

  it("groups by category then page label, severity-sorted", () => {
    const groups = groupFindingsForLetter(findings);
    expect(groups.map((g) => g.category)).toEqual(["setback", "height"]);
    expect(groups[0]!.pages[0]!.label).toBe("wall:north");
    expect(groups[0]!.pages[0]!.findings.map((f) => f.severity)).toEqual([
      "blocker",
      "advisory",
    ]);
    expect(groups[1]!.pages[0]!.label).toBe("General");
  });

  it("emits a deterministic markdown body with citations preserved", () => {
    const out = assembleCommentLetter({ findings, context: ctx });
    expect(out.findingCount).toBe(3);
    expect(out.subject).toBe("Plan review comments — Springfield, IL");
    expect(out.body).toContain("To: Acme Architects");
    expect(out.body).toContain("## Setbacks");
    expect(out.body).toContain("### wall:north");
    expect(out.body).toContain("[[CODE:code:abc]]");
    expect(out.body).toContain("**Blocker**");
  });

  it("renders a no-comments letter when nothing is open", () => {
    const out = assembleCommentLetter({
      findings: [findings[3]!],
      context: ctx,
    });
    expect(out.findingCount).toBe(0);
    expect(out.body).toContain("no open comments");
  });
});
