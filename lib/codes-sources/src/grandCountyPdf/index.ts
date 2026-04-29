/**
 * Grand County, UT — 2006 Wildland-Urban Interface Code (PDF) parser.
 *
 * Source PDF: https://www.grandcountyutah.net/DocumentCenter/View/3611
 *
 * The other PDF linked from /146/Design-Criteria (View/1869) is a scanned
 * image-only document that yields no extractable text; it is intentionally
 * NOT ingested here. OCR is out of scope for this sprint.
 *
 * The pure header-chunking heuristic lives in `./parser.ts` for unit testing.
 */

// pdf-parse-fork has no shipped types; the default export is callable.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types
import pdfParse from "pdf-parse-fork";
import type { CodeSource, TocEntry, AtomCandidate, FetchContext } from "../types";
import { chunkByHeader } from "./parser";

export { chunkByHeader, MAX_CHARS_PER_CHUNK, type PdfChunk } from "./parser";

const PDF_URL = "https://www.grandcountyutah.net/DocumentCenter/View/3611";
const USER_AGENT =
  process.env.HAUSKA_USER_AGENT ?? "Hauska-CodeAtoms/0.1 (+nick@hauska.io)";

async function fetchPdfBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/pdf" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `grandCountyPdf: GET ${url} -> HTTP ${res.status} ${res.statusText}`,
    );
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export const grandCountyPdfSource: CodeSource = {
  id: "grand_county_pdf",
  label: "Grand County, UT — 2006 Wildland-Urban Interface Code (PDF)",
  sourceType: "pdf",
  licenseType: "public_record",

  async listToc(_input): Promise<TocEntry[]> {
    return [
      {
        sectionUrl: PDF_URL,
        sectionRef: "IWUIC-2006",
        sectionTitle: "2006 International Wildland-Urban Interface Code",
        parentSection: null,
        context: { kind: "iwuic_pdf_full" },
      },
    ];
  },

  async fetchSection(
    sectionUrl: string,
    _ctx: FetchContext,
  ): Promise<AtomCandidate[]> {
    const buf = await fetchPdfBuffer(sectionUrl);
    const parsed = await pdfParse(buf);
    const pageCount = parsed.numpages;
    const text = (parsed.text ?? "").replace(/\u0000/g, "");
    const chunks = chunkByHeader(text);

    return chunks.map((c) => ({
      sectionRef: c.ref,
      sectionTitle: c.title,
      parentSection: c.ref?.startsWith("CHAPTER") ? null : "IWUIC-2006",
      body: c.body,
      bodyHtml: null,
      sourceUrl: sectionUrl,
      metadata: {
        kind: "iwuic_pdf_chunk",
        codeBookEdition: "IWUIC 2006",
        pdfPageCount: pageCount,
        chunkBytes: c.body.length,
        scrapedAt: new Date().toISOString(),
      },
    }));
  },
};
