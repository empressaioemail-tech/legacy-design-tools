/**
 * G-309 A26: the code-atom response schemas accept a citation-only ICC row
 * (no body / bodyPreview / bodyHtml, citationOnly true) and a city row that
 * carries them.
 */
import { describe, it, expect } from "vitest";
import {
  GetCodeAtomResponse,
  ListCodeAtomsResponse,
  ListJurisdictionAtomsResponse,
  RetrieveAtomsProbeResponse,
} from "@workspace/api-zod";

const base = {
  id: "a1",
  jurisdictionKey: "x",
  codeBook: "IRC",
  edition: "2021",
  sectionNumber: "R301.2",
  sectionTitle: "Climatic and geographic design criteria",
  sourceName: "src",
  sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1/chapter-3",
  embedded: true,
  fetchedAt: "2026-01-01T00:00:00.000Z",
};
const detailRest = {
  parentSection: null,
  embeddingModel: null,
  metadata: null,
};

describe("citation-only code-atom schemas", () => {
  it("summary: ICC row without bodyPreview validates; city row with it validates", () => {
    const icc = { ...base, citationOnly: true };
    const city = { ...base, citationOnly: false, bodyPreview: "Setback is five feet." };
    expect(ListJurisdictionAtomsResponse.safeParse([icc, city]).success).toBe(true);
    expect(
      ListCodeAtomsResponse.safeParse({ total: 2, limit: 50, offset: 0, items: [icc, city] })
        .success,
    ).toBe(true);
  });

  it("detail: ICC row without body fields validates; city row with them validates", () => {
    expect(
      GetCodeAtomResponse.safeParse({ ...base, citationOnly: true, ...detailRest }).success,
    ).toBe(true);
    expect(
      GetCodeAtomResponse.safeParse({
        ...base,
        citationOnly: false,
        bodyPreview: "Setback.",
        body: "Setback is five feet.",
        bodyHtml: null,
        ...detailRest,
      }).success,
    ).toBe(true);
  });

  it("probe: ICC item without bodyPreview validates", () => {
    const item = {
      rank: 1,
      atomId: "a1",
      codeRef: "R301.2",
      sectionTitle: null,
      citationOnly: true,
      similarity: 0.5,
      sourceBook: "IRC",
      sourceUrl: null,
      retrievalMode: "vector",
    };
    const parsed = RetrieveAtomsProbeResponse.safeParse({
      resolvedJurisdiction: "x",
      resolvedFromEngagement: false,
      query: "q",
      queryEmbedding: { available: true, model: "m", dimension: 3 },
      inclusionThreshold: 0.5,
      results: [item],
      assembledPromptBlock: "",
    });
    if (!parsed.success) console.log(JSON.stringify(parsed.error.issues));
    expect(parsed.success).toBe(true);
  });
});
