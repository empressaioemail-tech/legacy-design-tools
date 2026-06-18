import { extractPdfPlainText } from "@workspace/codes-sources/pdf-text";
import { randomUUID } from "node:crypto";

export const ENCUMBRANCE_EXTRACT_MODEL = "encumbrance-extract-v1";
export const ENCUMBRANCE_EXTRACT_VERSION = "1.0.0";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

const CLAUSE_HEADER_RE =
  /^(?:Article\s+[IVXLC\d]+(?:\s*§\s*[\d.]+)?|Section\s+\d+(?:\.\d+)*|§\s*[\d.]+)\b/im;

export interface ExtractedClauseCandidate {
  clausePath: string;
  bodyText: string;
  sourceCitation: string;
  sourcePage: number | null;
  confidence: number;
  reasoningSummary: string;
}

export interface EncumbranceExtractResult {
  plainText: string;
  pageCount: number;
  clauses: ExtractedClauseCandidate[];
  metadata: {
    documentModel: string;
    documentModelVersion: string;
    extractedAt: string;
  };
}

function isPdfMagic(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

export async function extractEncumbranceClausesFromPdf(
  bytes: Buffer,
): Promise<EncumbranceExtractResult> {
  if (bytes.length > MAX_PDF_BYTES) {
    throw new Error("pdf_too_large");
  }
  if (!isPdfMagic(bytes)) {
    throw new Error("pdf_unparseable");
  }
  let parsed: { text: string; numpages: number };
  try {
    parsed = await extractPdfPlainText(bytes);
  } catch {
    throw new Error("pdf_unparseable");
  }
  const plainText = parsed.text.trim();
  const pageCount = parsed.numpages;
  const clauses = splitClauseCandidates(plainText, pageCount);
  const extractedAt = new Date().toISOString();

  return {
    plainText,
    pageCount,
    clauses,
    metadata: {
      documentModel: ENCUMBRANCE_EXTRACT_MODEL,
      documentModelVersion: ENCUMBRANCE_EXTRACT_VERSION,
      extractedAt,
    },
  };
}

function splitClauseCandidates(
  text: string,
  pageCount: number,
): ExtractedClauseCandidate[] {
  if (!text) {
    return [
      fallbackClause(
        "Upload contained no extractable text — review the scanned PDF manually.",
        pageCount,
        0.35,
      ),
    ];
  }

  const lines = text.split("\n");
  const blocks: Array<{ header: string; bodyLines: string[] }> = [];
  let currentHeader = "Document";
  let currentBody: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (CLAUSE_HEADER_RE.test(trimmed)) {
      if (currentBody.length > 0) {
        blocks.push({ header: currentHeader, bodyLines: currentBody });
      }
      currentHeader = trimmed.slice(0, 120);
      currentBody = [];
      CLAUSE_HEADER_RE.lastIndex = 0;
      continue;
    }
    currentBody.push(trimmed);
  }
  if (currentBody.length > 0) {
    blocks.push({ header: currentHeader, bodyLines: currentBody });
  }

  if (blocks.length <= 1 && text.length > 200) {
    return chunkByParagraphs(text, pageCount);
  }

  const out: ExtractedClauseCandidate[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const bodyText = b.bodyLines.join(" ").trim();
    if (bodyText.length < 20) continue;
    const approxPage = Math.min(
      pageCount,
      Math.max(1, Math.floor((i / Math.max(blocks.length, 1)) * pageCount) + 1),
    );
    out.push({
      clausePath: b.header,
      bodyText: bodyText.slice(0, 4000),
      sourceCitation: `${b.header} (approx. p. ${approxPage})`,
      sourcePage: approxPage,
      confidence: 0.72,
      reasoningSummary:
        "Clause boundary inferred from document heading pattern (machine extract).",
    });
    if (out.length >= 40) break;
  }
  return out;
}

function chunkByParagraphs(
  text: string,
  pageCount: number,
): ExtractedClauseCandidate[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 40);
  if (paras.length === 0) {
    return [fallbackClause(text.slice(0, 500), pageCount, 0.5)];
  }
  return paras.slice(0, 25).map((bodyText, i) => {
    const approxPage = Math.min(
      pageCount,
      Math.max(1, Math.floor((i / paras.length) * pageCount) + 1),
    );
    return {
      clausePath: `Paragraph ${i + 1}`,
      bodyText: bodyText.slice(0, 4000),
      sourceCitation: `Body text (approx. p. ${approxPage})`,
      sourcePage: approxPage,
      confidence: 0.65,
      reasoningSummary:
        "No article/section headers detected; split on paragraph boundaries (machine extract).",
    };
  });
}

function fallbackClause(
  bodyText: string,
  pageCount: number,
  confidence: number,
): ExtractedClauseCandidate {
  return {
    clausePath: "Full document",
    bodyText,
    sourceCitation: `Full document (p. 1–${pageCount})`,
    sourcePage: 1,
    confidence,
    reasoningSummary: "Single-clause fallback when structural headers were not found.",
  };
}

export function mintInstrumentDid(engagementId: string): string {
  return `did:hauska:instrument:engagement-${engagementId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
}

export function mintClauseDid(instrumentDid: string, index: number): string {
  return `${instrumentDid}:clause:${index + 1}`;
}

export function sourceDocumentCidFromObjectPath(objectPath: string): string {
  const normalized = objectPath.startsWith("/") ? objectPath : `/${objectPath}`;
  return `gcs:${normalized}`;
}
