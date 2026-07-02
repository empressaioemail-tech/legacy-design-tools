import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  assembleDeliverable,
  assignCallouts,
  codeSectionLabel,
  isFailFinding,
  parseLocation2d,
  wrapText,
  type DeliverableAnnotation,
} from "../assembleDeliverable";

/** Build a tiny in-memory multi-page source PDF for the copy path. */
async function makeSourcePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([612, 792]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe("wrapText", () => {
  it("wraps on whitespace within the max-char budget", () => {
    const lines = wrapText("the quick brown fox jumps", 9);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(9);
    expect(lines.join(" ")).toBe("the quick brown fox jumps");
  });

  it("hard-breaks a token longer than the line width", () => {
    const lines = wrapText("supercalifragilistic", 5);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(5);
    expect(lines.join("")).toBe("supercalifragilistic");
  });

  it("preserves explicit newlines as line breaks", () => {
    const lines = wrapText("line one\nline two", 40);
    expect(lines).toEqual(["line one", "line two"]);
  });
});

describe("isFailFinding", () => {
  it("marks open blockers/concerns as fail and advisories as pass", () => {
    expect(isFailFinding({ severity: "blocker", status: "ai-produced" })).toBe(
      true,
    );
    expect(isFailFinding({ severity: "concern", status: "ai-produced" })).toBe(
      true,
    );
    expect(isFailFinding({ severity: "advisory", status: "ai-produced" })).toBe(
      false,
    );
  });

  it("treats reviewer-dispositioned findings as pass regardless of severity", () => {
    expect(isFailFinding({ severity: "blocker", status: "accepted" })).toBe(
      false,
    );
    expect(isFailFinding({ severity: "blocker", status: "rejected" })).toBe(
      false,
    );
  });
});

describe("codeSectionLabel", () => {
  it("prefers the first code-section citation atomId", () => {
    expect(
      codeSectionLabel({
        category: "setback",
        citations: [
          { kind: "briefing-source", id: "b1", label: "Brief" },
          { kind: "code-section", atomId: "IBC-1004.5" },
        ],
      }),
    ).toBe("IBC-1004.5");
  });

  it("falls back to category when no code-section citation exists", () => {
    expect(codeSectionLabel({ category: "height", citations: [] })).toBe(
      "height",
    );
    expect(codeSectionLabel({ category: "egress", citations: null })).toBe(
      "egress",
    );
  });
});

describe("parseLocation2d", () => {
  it("parses a well-formed location", () => {
    expect(
      parseLocation2d({ page: 3, bbox: [0.1, 0.2, 0.3, 0.4], label: "x" }),
    ).toEqual({ page: 3, bbox: [0.1, 0.2, 0.3, 0.4] });
  });

  it("rejects malformed locations", () => {
    expect(parseLocation2d(null)).toBeNull();
    expect(parseLocation2d({ page: 0, bbox: [0, 0, 1, 1] })).toBeNull();
    expect(parseLocation2d({ page: 1, bbox: [0, 0] })).toBeNull();
    expect(parseLocation2d({ page: 1, bbox: [0, 0, "x", 1] })).toBeNull();
  });
});

describe("assignCallouts", () => {
  it("numbers annotations by page then findingId and maps findingId->number", () => {
    const anns: DeliverableAnnotation[] = [
      { id: "a2", findingId: "f-b", location2d: { page: 3, bbox: [0, 0, 1, 1] } },
      { id: "a1", findingId: "f-a", location2d: { page: 1, bbox: [0, 0, 1, 1] } },
      { id: "a3", findingId: "f-c", location2d: null }, // skipped (no loc)
    ];
    const { placements, numberByFindingId } = assignCallouts(anns);
    expect(placements.map((p) => p.number)).toEqual([1, 2]);
    expect(placements[0].location.page).toBe(1);
    expect(placements[1].location.page).toBe(3);
    expect(numberByFindingId.get("f-a")).toBe(1);
    expect(numberByFindingId.get("f-b")).toBe(2);
    expect(numberByFindingId.has("f-c")).toBe(false);
  });
});

describe("assembleDeliverable", () => {
  it("builds a well-formed PDF with title + copied source pages + summary + letter", async () => {
    const source = await makeSourcePdf(3); // 3 source pages

    const out = await assembleDeliverable({
      engagement: {
        id: "eng-1",
        name: "Test Engagement",
        address: "123 Main St",
        jurisdiction: "Bastrop, TX",
        applicantFirm: "Acme Architects",
      },
      findings: [
        {
          id: "f-1",
          severity: "blocker",
          category: "setback",
          status: "ai-produced",
          text: "Front setback is 5ft; the zoning district requires a 25ft minimum front setback.",
          confidence: 0.9,
          citations: [{ kind: "code-section", atomId: "UDC-3.2.1" }],
        },
        {
          id: "f-2",
          severity: "advisory",
          category: "other",
          status: "ai-produced",
          text: "Consider adding a landscape buffer along the north property line.",
          confidence: 0.5,
          citations: [],
        },
      ],
      annotations: [
        { id: "a-1", findingId: "f-1", location2d: { page: 1, bbox: [0.1, 0.1, 0.4, 0.3] } },
        { id: "a-2", findingId: "f-2", location2d: { page: 3, bbox: [0.5, 0.5, 0.8, 0.7] } },
      ],
      documents: [
        {
          id: "d-1",
          title: "plans.pdf",
          documentType: "narrative",
          originalBlobRef: "/objects/uploads/src-1",
        },
      ],
      letter: {
        draft:
          "Dear Applicant,\n\nThis review letter summarizes the findings for your submission. " +
          "Please address each blocker before resubmitting. ".repeat(20),
        generatedAt: new Date().toISOString(),
      },
      fetchSourcePdfBytes: async (path: string) =>
        path === "/objects/uploads/src-1" ? source : null,
    });

    const reloaded = await PDFDocument.load(out);
    const pageCount = reloaded.getPageCount();
    // title(1) + copied source pages(3) + summary(>=1) + letter(>=1)
    expect(pageCount).toBeGreaterThanOrEqual(1 + 3 + 1 + 1);
    // Sanity: the copied source contributed exactly its pages between title
    // and the summary/letter sections, so total exceeds the fixed sections.
    expect(pageCount).toBeGreaterThan(3);
  });

  it("skips corrupt/non-PDF source bytes without crashing", async () => {
    const out = await assembleDeliverable({
      engagement: { id: "eng-2" },
      findings: [],
      annotations: [],
      documents: [
        {
          id: "d-bad",
          title: "drawing.dwg",
          documentType: "narrative",
          originalBlobRef: "/objects/uploads/bad",
        },
      ],
      letter: null,
      fetchSourcePdfBytes: async () => Buffer.from("not a pdf at all"),
    });
    const reloaded = await PDFDocument.load(out);
    // title(1) + no copied pages + summary(1); no letter.
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("clamps annotations that point past the copied page range", async () => {
    const source = await makeSourcePdf(1);
    const out = await assembleDeliverable({
      engagement: { id: "eng-3" },
      findings: [],
      annotations: [
        // page 9 does not exist among the single copied page — must not throw.
        { id: "a-x", findingId: null, location2d: { page: 9, bbox: [0, 0, 1, 1] } },
      ],
      documents: [
        { id: "d-1", title: "p.pdf", documentType: "narrative", originalBlobRef: "/objects/uploads/s" },
      ],
      letter: null,
      fetchSourcePdfBytes: async () => source,
    });
    const reloaded = await PDFDocument.load(out);
    // title(1) + copied(1) + summary(1)
    expect(reloaded.getPageCount()).toBe(3);
  });
});
