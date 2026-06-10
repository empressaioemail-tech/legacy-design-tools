import { describe, expect, it } from "vitest";
import { renderDeliverableLetterHtml } from "../deliverableLetterHtml";

describe("renderDeliverableLetterHtml", () => {
  it("renders sections in letter order and preserves disclaimer text", () => {
    const html = renderDeliverableLetterHtml({
      title: "Pre-Bid Code & Scope Analysis",
      sections: [
        {
          kind: "signature",
          heading: "Closing",
          content: "Respectfully,\nArchitect",
          provenance: {
            responseTaskIds: [],
            sheetContentExtractionIds: [],
            findingIds: [],
            adjudicationStateIds: [],
          },
        },
        {
          kind: "cover",
          heading: "Cover",
          content: "San Marcos Triplex",
          provenance: {
            responseTaskIds: [],
            sheetContentExtractionIds: [],
            findingIds: [],
            adjudicationStateIds: [],
          },
        },
        {
          kind: "intro",
          heading: "Introduction",
          content:
            "This analysis is preliminary. Jurisdiction code is unverified — confirm against adopted ordinances.",
          provenance: {
            responseTaskIds: [],
            sheetContentExtractionIds: [],
            findingIds: ["f-1"],
            adjudicationStateIds: [],
          },
        },
      ],
    });
    const coverPos = html.indexOf("San Marcos Triplex");
    const introPos = html.indexOf("unverified");
    const sigPos = html.indexOf("Respectfully");
    expect(coverPos).toBeGreaterThan(-1);
    expect(introPos).toBeGreaterThan(coverPos);
    expect(sigPos).toBeGreaterThan(introPos);
    expect(html).toContain("1 finding(s)");
    expect(html).toContain("quality-gate");
  });
});
