/**
 * Pure validation + atom-shaping logic for the L2 routes
 * (`sheet-content-extraction` + `attached-document`). Kept free of
 * `@workspace/db` and Express imports so it is unit-testable without a
 * database.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L2.
 */

import {
  ATTACHED_DOCUMENT_TYPES,
  type AttachedDocumentType,
  type SheetTextSegment,
} from "@workspace/atoms-l-surface";

/** Discriminated result of a query-param parse. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Full-page bounding box (normalized `[0, 1]`). The legacy sheet vision
 * pass produces a single flat free-text body — not per-region segments
 * — so the whole body maps to one page-spanning segment.
 */
export const FULL_PAGE_BOUNDING_BOX = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
} as const;

/**
 * Build the L2a `extractedTextSegments` array from a flat OCR body.
 *
 * The existing legacy vision pass (`extractSheetContentBody`) returns
 * one free-text body, not bounding-boxed segments — so the body
 * becomes a single page-spanning segment. An empty body yields zero
 * segments. A richer extractor that produces per-region segments +
 * classified structured annotations is a separate feature (surfaced
 * to the planner in the C.4.2 PR).
 */
export function buildTextSegments(ocrBody: string): SheetTextSegment[] {
  const trimmed = ocrBody.trim();
  if (trimmed.length === 0) return [];
  return [
    {
      text: trimmed,
      boundingBox: { ...FULL_PAGE_BOUNDING_BOX },
      // The flat pass carries no per-segment confidence; a nominal 1
      // is used. Revisit when the structured extractor lands.
      sourceConfidence: 1,
    },
  ];
}

/** True when `v` is one of the four `AttachedDocumentType` values. */
export function isAttachedDocumentType(
  v: unknown,
): v is AttachedDocumentType {
  return (
    typeof v === "string" &&
    (ATTACHED_DOCUMENT_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Validate the optional `?documentType=` filter on the attached-document
 * list route. A missing filter resolves to `null` (no filtering); an
 * unknown value is a 400.
 */
export function parseDocumentTypeFilter(
  raw: unknown,
): ParseResult<AttachedDocumentType | null> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (!isAttachedDocumentType(raw)) {
    return { ok: false, error: "invalid_document_type" };
  }
  return { ok: true, value: raw };
}

/* -------------------------------------------------------------------------- */
/*  QA-18 — operator-driven attached-document upload                          */
/* -------------------------------------------------------------------------- */

/**
 * Document category an operator upload defaults to when none is given —
 * "narrative" is the catch-all for client-supplied material (PDFs,
 * photos, notes) that is not a spec / calculation / product-data sheet.
 */
export const DEFAULT_ATTACHED_DOCUMENT_TYPE: AttachedDocumentType =
  "narrative";

/** Upper bound on a stored document title; defends the `text` column. */
export const MAX_DOCUMENT_TITLE_CHARS = 200;

/**
 * Resolve the `documentType` field on an attached-document upload. A
 * missing / empty value defaults to {@link DEFAULT_ATTACHED_DOCUMENT_TYPE};
 * a present but unrecognized value is a 400.
 */
export function parseUploadedDocumentType(
  raw: unknown,
): ParseResult<AttachedDocumentType> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: DEFAULT_ATTACHED_DOCUMENT_TYPE };
  }
  if (!isAttachedDocumentType(raw)) {
    return { ok: false, error: "invalid_document_type" };
  }
  return { ok: true, value: raw };
}

/**
 * MIME families the attached-document upload accepts — client PDFs,
 * photos, and text notes (QA-18). Everything else is a 415.
 */
const ACCEPTED_DOCUMENT_MIME: ReadonlyArray<string> = [
  "application/pdf",
  "image/", // any image/* — png, jpeg, webp, gif, heic…
  "text/", // any text/* — plain, markdown…
];

/** Normalize a Content-Type header value down to the bare MIME type. */
function bareMime(mime: string): string {
  return (mime.toLowerCase().split(";")[0] ?? "").trim();
}

/** True when an uploaded file's MIME type is an accepted document kind. */
export function isAcceptedDocumentMime(mime: string): boolean {
  const m = bareMime(mime);
  if (m.length === 0) return false;
  return ACCEPTED_DOCUMENT_MIME.some((p) =>
    p.endsWith("/") ? m.startsWith(p) : m === p,
  );
}

/**
 * True for a `text/*` upload — its decoded body is stored directly as the
 * atom's `extractedText` so the in-app agent can read a client note.
 * PDFs and images instead carry the operator's note (if any) there.
 */
export function isTextMime(mime: string): boolean {
  return bareMime(mime).startsWith("text/");
}

/**
 * Resolve the stored document title: the operator-provided title, else
 * the uploaded filename, else a generic default. Trimmed and length-
 * capped so a pathological filename cannot bloat the row.
 */
export function resolveDocumentTitle(
  providedTitle: unknown,
  filename: string | undefined,
): string {
  const fromField =
    typeof providedTitle === "string" ? providedTitle.trim() : "";
  if (fromField) return fromField.slice(0, MAX_DOCUMENT_TITLE_CHARS);
  const fromFile = (filename ?? "").trim();
  if (fromFile) return fromFile.slice(0, MAX_DOCUMENT_TITLE_CHARS);
  return "Untitled document";
}

/** Cap aligned with encumbrance extract and dispatch acceptance criteria. */
export const MAX_ATTACHED_PDF_BYTES = 25 * 1024 * 1024;

/** Minimum extracted chars before flagging raster/low-text PDFs for P2 vision. */
export const LOW_TEXT_EXTRACTION_THRESHOLD = 80;

export interface AttachedDocumentExtractResult {
  extractedText: string;
  /** Present when PDF text extraction yielded little content (image-only sheet). */
  lowTextExtraction?: boolean;
}

/**
 * Build `extractedText` for an attached-document upload.
 * Text MIME: operator note + decoded body. PDF: pdf-parse plain text + note.
 */
export async function buildAttachedDocumentExtractedText(args: {
  mimeType: string;
  note: string;
  fileBytes: Buffer;
  maxChars: number;
  extractPdfPlainText: (
    bytes: Buffer,
  ) => Promise<{ text: string; numpages: number }>;
}): Promise<AttachedDocumentExtractResult> {
  const note = args.note.trim();
  let body = "";

  if (isTextMime(args.mimeType)) {
    body = args.fileBytes.toString("utf-8");
  } else if (bareMime(args.mimeType) === "application/pdf") {
    if (args.fileBytes.length > MAX_ATTACHED_PDF_BYTES) {
      throw new Error("pdf_too_large");
    }
    const parsed = await args.extractPdfPlainText(args.fileBytes);
    body = parsed.text.trim();
  }

  let extractedText = note;
  if (body) {
    extractedText = extractedText ? `${extractedText}\n\n${body}` : body;
  }
  extractedText = extractedText.slice(0, args.maxChars);

  const lowTextExtraction =
    bareMime(args.mimeType) === "application/pdf" &&
    body.length < LOW_TEXT_EXTRACTION_THRESHOLD;

  return {
    extractedText,
    ...(lowTextExtraction ? { lowTextExtraction: true } : {}),
  };
}
