/**
 * Grand County, UT — 2006 Wildland-Urban Interface Code (PDF) parser.
 *
 * Source PDF: https://www.grandcountyutah.net/DocumentCenter/View/3611
 *
 * The other PDF linked from /146/Design-Criteria (View/1869) is a scanned
 * image-only document that yields no extractable text; it is intentionally
 * NOT ingested here. OCR is out of scope for this sprint.
 */

// pdf-parse-fork has no shipped types; the default export is callable.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types
import pdfParse from "pdf-parse-fork";
import type { CodeSource, TocEntry, AtomCandidate, FetchContext } from "../types";

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

/**
 * Heuristic chunker. The 2006 IWUIC has top-level chapters and sections
 * that begin with patterns like "CHAPTER 4" or "SECTION 401" or "401.1 ".
 * We split on those, keeping each chunk reasonably small (~max 4000 chars).
 */
function chunkByHeader(text: string): Array<{
  ref: string | null;
  title: string | null;
  body: string;
}> {
  const lines = text.split(/\r?\n/);
  const chunks: Array<{ ref: string | null; title: string | null; body: string }> =
    [];

  let curRef: string | null = null;
  let curTitle: string | null = null;
  let curBuf: string[] = [];

  const flush = () => {
    const body = curBuf.join("\n").trim();
    if (body.length > 0) {
      chunks.push({ ref: curRef, title: curTitle, body });
    }
    curBuf = [];
  };

  // Patterns:
  //   "CHAPTER 4" / "CHAPTER 4 - SPECIAL"
  //   "SECTION 401" / "SECTION 401 - GENERAL"
  //   "401.1 General." (subsection number followed by sentence-cased title)
  const chapterRe = /^(CHAPTER\s+\d+)(?:\s*[-—–]\s*(.+))?$/;
  const sectionRe = /^(SECTION\s+\d+)(?:\s*[-—–]\s*(.+))?$/;
  const subsectionRe = /^(\d{3,}(?:\.\d+)+)\s+([A-Z][^.]{0,80}\.)\s*$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      curBuf.push("");
      continue;
    }
    const ch = chapterRe.exec(line);
    const sec = sectionRe.exec(line);
    const sub = subsectionRe.exec(line);
    if (ch) {
      flush();
      curRef = ch[1];
      curTitle = ch[2] ? ch[2].trim() : ch[1];
    } else if (sec) {
      flush();
      curRef = sec[1];
      curTitle = sec[2] ? sec[2].trim() : sec[1];
    } else if (sub) {
      flush();
      curRef = sub[1];
      curTitle = sub[2].trim();
      curBuf.push(line);
    } else {
      curBuf.push(line);
    }
  }
  flush();

  // Hard cap per chunk for embedding model context safety.
  const MAX_CHARS = 4000;
  const out: Array<{ ref: string | null; title: string | null; body: string }> =
    [];
  for (const c of chunks) {
    if (c.body.length <= MAX_CHARS) {
      out.push(c);
      continue;
    }
    let i = 0;
    let part = 1;
    while (i < c.body.length) {
      const slice = c.body.slice(i, i + MAX_CHARS);
      out.push({
        ref: c.ref ? `${c.ref}#part${part}` : null,
        title: c.title ? `${c.title} (part ${part})` : null,
        body: slice,
      });
      i += MAX_CHARS;
      part += 1;
    }
  }
  return out;
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
