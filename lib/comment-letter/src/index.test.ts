import { describe, expect, it, vi } from "vitest";
import {
  assembleCommentLetter,
  buildCommentLetterPolishUserPrompt,
  COMMENT_LETTER_POLISH_SYSTEM_PROMPT,
  extractCitationTokens,
  groupFindingsForLetter,
  isOpenForCommentLetter,
  polishCommentLetter,
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

describe("extractCitationTokens", () => {
  it("counts both [[CODE:...]] and {{atom|...}} tokens including duplicates", () => {
    const body =
      "See [[CODE:code:abc]] and {{atom|briefing-source|s1|Setback map}}; [[CODE:code:abc]] again.";
    const tokens = extractCitationTokens(body);
    expect(tokens.get("[[CODE:code:abc]]")).toBe(2);
    expect(tokens.get("{{atom|briefing-source|s1|Setback map}}")).toBe(1);
    expect(tokens.size).toBe(2);
  });
});

describe("polishCommentLetter", () => {
  it("skips the polish entirely for a no-comments letter", async () => {
    const completer = vi.fn();
    const out = await polishCommentLetter(
      { findings: [findings[3]!], context: ctx },
      completer,
    );
    expect(out.polished).toBe(false);
    expect(out.fallbackReason).toBe("no_open_findings");
    expect(out.findingCount).toBe(0);
    expect(completer).not.toHaveBeenCalled();
  });

  it("returns the polished body when citations are preserved verbatim", async () => {
    const skeleton = assembleCommentLetter({ findings, context: ctx });
    const polishedDraft = `To: Acme Architects
Re: Plan-review submission (Springfield, IL)

Dear team,

We have completed our review and ask you to address the items below.

## Setbacks
### wall:north
- **Blocker** — Setback violates [[CODE:code:abc]] along the north wall.
- **Advisory** — Consider revising the side setback for better street rhythm.

## Height
### General
- **Concern** — Height nears the overlay maximum.

Please respond with a revised submission addressing each comment above.

Sincerely,
The Plan Review Team
`;
    const completer = vi.fn().mockResolvedValue(polishedDraft);
    const out = await polishCommentLetter({ findings, context: ctx }, completer);
    expect(out.polished).toBe(true);
    expect(out.fallbackReason).toBeNull();
    expect(out.findingCount).toBe(3);
    expect(out.body).toContain("[[CODE:code:abc]]");
    expect(out.body).toContain("Dear team");
    expect(out.body.endsWith("\n")).toBe(true);
    expect(completer).toHaveBeenCalledTimes(1);
    const args = completer.mock.calls[0]![0];
    expect(args.system).toBe(COMMENT_LETTER_POLISH_SYSTEM_PROMPT);
    expect(args.user).toBe(
      buildCommentLetterPolishUserPrompt(skeleton, ctx),
    );
  });

  it("falls back to the deterministic body when the LLM drops a citation", async () => {
    const completer = vi.fn().mockResolvedValue(
      "Polished body with no citations at all.",
    );
    const out = await polishCommentLetter({ findings, context: ctx }, completer);
    expect(out.polished).toBe(false);
    expect(out.fallbackReason).toBe("missing_citations");
    expect(out.body).toContain("[[CODE:code:abc]]");
    expect(out.body).toContain("**Blocker**");
  });

  it("falls back when the completer throws", async () => {
    const completer = vi.fn().mockRejectedValue(new Error("rate_limited"));
    const out = await polishCommentLetter({ findings, context: ctx }, completer);
    expect(out.polished).toBe(false);
    expect(out.fallbackReason).toBe("completer_error");
    expect(out.body).toContain("[[CODE:code:abc]]");
  });

  it("falls back when the completer returns an empty string", async () => {
    const completer = vi.fn().mockResolvedValue("   \n  ");
    const out = await polishCommentLetter({ findings, context: ctx }, completer);
    expect(out.polished).toBe(false);
    expect(out.fallbackReason).toBe("empty_completion");
  });

  it("strips a wrapping ```markdown code fence the model sometimes adds", async () => {
    const skeleton = assembleCommentLetter({ findings, context: ctx });
    const fenced = "```markdown\n" + skeleton.body + "```\n";
    const completer = vi.fn().mockResolvedValue(fenced);
    const out = await polishCommentLetter({ findings, context: ctx }, completer);
    expect(out.polished).toBe(true);
    expect(out.body).not.toContain("```");
    expect(out.body).toContain("[[CODE:code:abc]]");
  });
});
