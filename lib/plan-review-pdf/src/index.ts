/**
 * `@workspace/plan-review-pdf` — PLR-11 PDF rendering primitives.
 *
 * Two pure(ish) builders that operate on already-loaded data so the
 * api-server route layer owns the DB / object-storage I/O and this
 * lib stays trivially testable:
 *
 *   - {@link renderStampedPlanSet}  — a multi-page PDF that embeds the
 *     submission's full-resolution sheet PNGs and stamps a city-seal
 *     "APPROVED" block on every page (permit number + approval date +
 *     approver name) sourced from the decision-event payload.
 *   - {@link renderCommentLetter}   — a tenant-letterhead PDF that
 *     renders the AI-drafted comment-letter markdown body, ordered by
 *     discipline and page label.
 *
 * Both functions return raw `Uint8Array` PDF bytes; persistence to
 * object storage is the caller's responsibility.
 *
 * Design notes:
 *   - Strategic decision SD-4 — the stamp is a *render* of the
 *     decision-event atom's data, not a separate set of stamp objects.
 *     Re-rendering the same decision-event therefore yields the same
 *     stamp text byte-for-byte (modulo PDF object-id bookkeeping).
 *   - SD-5 — issued PDF reflects the submission's contemporaneous
 *     sheet set; the caller resolves which sheets to pass in.
 *   - SD-7 — the V1 stamp uses Empressa as the test tenant; tenant
 *     letterhead text is provided by the caller so a future tenant
 *     config layer can swap it without touching this module.
 */

import {
  PDFArray,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";
import {
  COMMENT_LETTER_CATEGORY_LABELS,
  groupFindingsForLetter,
  type CommentLetterFinding,
} from "@workspace/comment-letter";

/**
 * One sheet from the submission's plan set, supplied as already-
 * decoded PNG bytes plus its label / dimensions. The render function
 * embeds the bytes verbatim so the upstream loader controls
 * compression / pixel ratio decisions.
 */
export interface StampPlanSheet {
  /** Display label printed above the stamp (e.g. "A-101"). */
  sheetNumber: string;
  /** Optional secondary label printed under the sheet number. */
  sheetName?: string | null;
  /** Decoded PNG bytes for the full-resolution rendering. */
  fullPng: Uint8Array;
  /** Pixel dimensions (used to preserve aspect ratio when fitting). */
  fullWidth: number;
  fullHeight: number;
}

/**
 * Decision-event projection consumed by {@link renderStampedPlanSet}.
 * Mirrors the fields the route reads off the `decision-event.recorded`
 * row's payload + actor envelope. Kept narrow so this lib has no
 * dependency on the api-server's DB types.
 */
export interface StampDecisionEvent {
  /** Stable permit number derived from the tenant counter. */
  permitNumber: string;
  /** Decision verdict ("approve" or "approve_with_conditions"). */
  verdict: "approve" | "approve_with_conditions";
  /** Approval date — uses the decision-event's `occurredAt`. */
  approvalDate: Date;
  /** Display name of the reviewer who recorded the verdict. */
  approverName: string;
  /** Optional verdict comment carried into the stamp footer. */
  comment?: string | null;
}

export interface RenderStampedPlanSetInput {
  /** Tenant display name printed in the stamp seal. */
  tenantName: string;
  /** Submission identifier printed for traceability. */
  submissionId: string;
  /** Sheets in the order they should appear in the issued PDF. */
  sheets: ReadonlyArray<StampPlanSheet>;
  /** Decision-event details that drive the stamp text. */
  decisionEvent: StampDecisionEvent;
}

const STAMP_WIDTH = 220;
const STAMP_HEIGHT = 110;
const STAMP_MARGIN = 24;
const PAGE_MARGIN = 18;
const HEADER_HEIGHT = 28;

/**
 * Stamp coordinates. Exported so the snapshot test can pin the
 * rectangle's origin + size on every page without re-deriving the
 * geometry from the renderer's body.
 */
export interface StampPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeStampPlacement(pageWidth: number): StampPlacement {
  return {
    x: pageWidth - STAMP_WIDTH - STAMP_MARGIN,
    y: STAMP_MARGIN,
    width: STAMP_WIDTH,
    height: STAMP_HEIGHT,
  };
}

function formatStampDate(d: Date): string {
  // Use ISO calendar date so the stamp reads identically regardless
  // of the renderer's locale. The route layer commits to UTC for the
  // decision-event `occurredAt` column.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const VERDICT_HEADLINE: Record<StampDecisionEvent["verdict"], string> = {
  approve: "APPROVED",
  approve_with_conditions: "APPROVED WITH CONDITIONS",
};

function drawStamp(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  input: RenderStampedPlanSetInput,
): StampPlacement {
  const placement = computeStampPlacement(page.getWidth());
  const { x, y, width, height } = placement;

  // Stamp border + background.
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.55, 0.05, 0.05),
    borderWidth: 1.5,
  });
  page.drawRectangle({
    x: x + 4,
    y: y + 4,
    width: width - 8,
    height: height - 8,
    borderColor: rgb(0.55, 0.05, 0.05),
    borderWidth: 0.5,
  });

  const headline = VERDICT_HEADLINE[input.decisionEvent.verdict];
  const ev = input.decisionEvent;

  page.drawText(input.tenantName.toUpperCase(), {
    x: x + 12,
    y: y + height - 18,
    size: 8,
    font: bold,
    color: rgb(0.55, 0.05, 0.05),
  });
  page.drawText(headline, {
    x: x + 12,
    y: y + height - 36,
    size: 13,
    font: bold,
    color: rgb(0.55, 0.05, 0.05),
  });
  page.drawText(`Permit #: ${ev.permitNumber}`, {
    x: x + 12,
    y: y + height - 54,
    size: 9,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText(`Date: ${formatStampDate(ev.approvalDate)}`, {
    x: x + 12,
    y: y + height - 68,
    size: 9,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText(`Approved by: ${ev.approverName}`, {
    x: x + 12,
    y: y + height - 82,
    size: 9,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText(`Submission ${input.submissionId.slice(0, 8)}`, {
    x: x + 12,
    y: y + 10,
    size: 7,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  return placement;
}

/**
 * Render a multi-page PDF embedding every supplied sheet image and
 * stamping a city-seal block on every page. Returns the raw PDF
 * bytes; the caller persists them to object storage.
 *
 * Stamp coordinates are deterministic per page width (see
 * {@link computeStampPlacement}) so a snapshot test can pin the
 * placement across a multi-sheet fixture.
 */
export async function renderStampedPlanSet(
  input: RenderStampedPlanSetInput,
): Promise<{ bytes: Uint8Array; stampPlacements: StampPlacement[] }> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Issued plan set — ${input.submissionId}`);
  doc.setSubject(
    `Permit ${input.decisionEvent.permitNumber} (${VERDICT_HEADLINE[input.decisionEvent.verdict]})`,
  );
  doc.setProducer("@workspace/plan-review-pdf");
  doc.setCreationDate(input.decisionEvent.approvalDate);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const placements: StampPlacement[] = [];

  if (input.sheets.length === 0) {
    // Always produce at least one page so the PDF is valid + so the
    // stamp is still inspectable when a submission has no sheets
    // attached (defensive — the route layer should normally catch
    // this earlier).
    const page = doc.addPage([612, 792]);
    page.drawText("No sheets attached to this submission.", {
      x: PAGE_MARGIN,
      y: page.getHeight() / 2,
      size: 14,
      font,
    });
    placements.push(drawStamp(page, font, bold, input));
  } else {
    for (const sheet of input.sheets) {
      // Page sized to the sheet's aspect ratio at a fixed long-edge so
      // every page in the issued PDF reads at the same scale.
      const longEdge = 1024;
      const aspect = sheet.fullWidth / Math.max(sheet.fullHeight, 1);
      let pageW: number;
      let pageH: number;
      if (aspect >= 1) {
        pageW = longEdge;
        pageH = longEdge / aspect;
      } else {
        pageH = longEdge;
        pageW = longEdge * aspect;
      }
      const page = doc.addPage([pageW, pageH]);

      const png = await doc.embedPng(sheet.fullPng);
      const drawW = pageW - PAGE_MARGIN * 2;
      const drawH = pageH - PAGE_MARGIN * 2 - HEADER_HEIGHT;
      const scale = Math.min(drawW / png.width, drawH / png.height);
      const imgW = png.width * scale;
      const imgH = png.height * scale;
      page.drawImage(png, {
        x: (pageW - imgW) / 2,
        y: PAGE_MARGIN + (drawH - imgH) / 2,
        width: imgW,
        height: imgH,
      });

      // Sheet header strip across the top.
      page.drawText(sheet.sheetNumber, {
        x: PAGE_MARGIN,
        y: pageH - PAGE_MARGIN - 14,
        size: 12,
        font: bold,
        color: rgb(0, 0, 0),
      });
      if (sheet.sheetName) {
        page.drawText(sheet.sheetName, {
          x: PAGE_MARGIN + 80,
          y: pageH - PAGE_MARGIN - 14,
          size: 10,
          font,
          color: rgb(0.25, 0.25, 0.25),
        });
      }

      placements.push(drawStamp(page, font, bold, input));
    }
  }

  const bytes = await doc.save();
  return { bytes, stampPlacements: placements };
}

// ---------------------------------------------------------------------------
// Comment-letter PDF
// ---------------------------------------------------------------------------

export interface CommentLetterPdfInput {
  tenantName: string;
  tenantAddressLines?: ReadonlyArray<string>;
  subject: string;
  /**
   * Verbatim body text the reviewer hit Send with. Rendered with
   * paragraph breaks preserved (`\n\n`) and word-wrap inside each
   * paragraph. This is the source of truth — `findings` is appended
   * only as a citation appendix and to drive page-label hyperlinks.
   */
  body: string;
  /** Cited findings, used solely for the citation appendix and links. */
  findings: ReadonlyArray<CommentLetterFinding>;
  recipientName: string | null;
  sentAt: Date;
  issuedPlanSetUrl?: string | null;
  pageLabelToIssuedPage?: ReadonlyMap<string, number>;
}

const LETTER_PAGE_W = 612; // US letter @72dpi
const LETTER_PAGE_H = 792;
const LETTER_MARGIN = 54;
const LETTER_LINE_HEIGHT = 13;
const LETTER_BODY_FONT_SIZE = 10;

/** Strip inline citation tokens that aren't useful in a printed letter. */
function stripCitationTokens(s: string): string {
  return s
    .replace(/\[\[CODE:[^\]]+\]\]/g, "")
    .replace(/\{\{atom\|[^|]+\|[^|]+\|([^}]+)\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    const w = font.widthOfTextAtSize(candidate, size);
    if (w > maxWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

interface LetterCursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
}

function newLetterPage(cursor: LetterCursor): void {
  cursor.page = cursor.doc.addPage([LETTER_PAGE_W, LETTER_PAGE_H]);
  cursor.y = LETTER_PAGE_H - LETTER_MARGIN;
}

function ensureSpace(cursor: LetterCursor, needed: number): void {
  if (cursor.y - needed < LETTER_MARGIN) {
    newLetterPage(cursor);
  }
}

function drawLine(
  cursor: LetterCursor,
  text: string,
  opts: {
    font?: PDFFont;
    size?: number;
    color?: ReturnType<typeof rgb>;
    indent?: number;
  } = {},
): void {
  const size = opts.size ?? LETTER_BODY_FONT_SIZE;
  ensureSpace(cursor, size + 2);
  cursor.page.drawText(text, {
    x: LETTER_MARGIN + (opts.indent ?? 0),
    y: cursor.y - size,
    size,
    font: opts.font ?? cursor.font,
    color: opts.color ?? rgb(0, 0, 0),
  });
  cursor.y -= LETTER_LINE_HEIGHT;
}

/**
 * Render the comment-letter PDF on tenant letterhead. Findings are
 * grouped by discipline (`category`) and ordered by page label,
 * mirroring the assembler's grouping. When an `issuedPlanSetUrl` is
 * supplied each page-label heading carries an `#page=N` anchor link
 * back into the issued plan set.
 */
export async function renderCommentLetter(
  input: CommentLetterPdfInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.subject);
  doc.setProducer("@workspace/plan-review-pdf");
  doc.setCreationDate(input.sentAt);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const cursor: LetterCursor = {
    doc,
    page: doc.addPage([LETTER_PAGE_W, LETTER_PAGE_H]),
    y: LETTER_PAGE_H - LETTER_MARGIN,
    font,
    bold,
  };

  // Letterhead.
  drawLine(cursor, input.tenantName, { font: bold, size: 14 });
  for (const ln of input.tenantAddressLines ?? []) {
    drawLine(cursor, ln, { size: 9, color: rgb(0.3, 0.3, 0.3) });
  }
  cursor.y -= 6;

  drawLine(cursor, formatStampDate(input.sentAt), {
    size: 9,
    color: rgb(0.3, 0.3, 0.3),
  });
  cursor.y -= 6;
  drawLine(cursor, `To: ${input.recipientName ?? "Architect of record"}`, {
    size: 10,
  });
  drawLine(cursor, `Re: ${input.subject}`, { size: 10, font: bold });
  cursor.y -= 8;

  // Render the reviewer-edited body verbatim, paragraph-aware.
  const paragraphs = input.body.split(/\n{2,}/);
  for (const para of paragraphs) {
    const cleaned = stripCitationTokens(para);
    if (cleaned.length === 0) continue;
    for (const ln of wrapText(
      cleaned,
      font,
      LETTER_BODY_FONT_SIZE,
      LETTER_PAGE_W - LETTER_MARGIN * 2,
    )) {
      drawLine(cursor, ln);
    }
    cursor.y -= 4;
  }

  // Citation appendix: grouped page-label index back into the issued
  // plan set. Provides the per-page-label hyperlinks even when the
  // body doesn't enumerate findings inline.
  const grouped = groupFindingsForLetter(input.findings);
  if (grouped.length > 0) {
    cursor.y -= 6;
    drawLine(cursor, "Cited sheets:", { font: bold, size: 11 });
    for (const group of grouped) {
      ensureSpace(cursor, 18);
      drawLine(cursor, COMMENT_LETTER_CATEGORY_LABELS[group.category], {
        font: bold,
        size: 10,
      });
      for (const page of group.pages) {
        ensureSpace(cursor, 14);
        const headerSize = 10;
        const headerY = cursor.y - headerSize;
        const headerText = `  ${page.label} (${page.findings.length})`;
        cursor.page.drawText(headerText, {
          x: LETTER_MARGIN + 8,
          y: headerY,
          size: headerSize,
          font,
          color: rgb(0, 0, 0.55),
        });
        const issuedPage = input.pageLabelToIssuedPage?.get(page.label);
        if (input.issuedPlanSetUrl && issuedPage) {
          const w = font.widthOfTextAtSize(headerText, headerSize);
          attachUriLinkAnnotation(cursor.page, {
            x: LETTER_MARGIN + 8,
            y: headerY - 2,
            width: w,
            height: headerSize + 2,
            uri: `${input.issuedPlanSetUrl}#page=${issuedPage}`,
          });
        }
        cursor.y -= LETTER_LINE_HEIGHT;
      }
    }
  }

  if (input.issuedPlanSetUrl) {
    cursor.y -= 8;
    const linkText = `Issued plan set: ${input.issuedPlanSetUrl}`;
    const headerY = cursor.y - LETTER_BODY_FONT_SIZE;
    cursor.page.drawText(linkText, {
      x: LETTER_MARGIN,
      y: headerY,
      size: LETTER_BODY_FONT_SIZE,
      font,
      color: rgb(0, 0, 0.55),
    });
    const w = font.widthOfTextAtSize(linkText, LETTER_BODY_FONT_SIZE);
    attachUriLinkAnnotation(cursor.page, {
      x: LETTER_MARGIN,
      y: headerY - 2,
      width: w,
      height: LETTER_BODY_FONT_SIZE + 2,
      uri: input.issuedPlanSetUrl,
    });
    cursor.y -= LETTER_LINE_HEIGHT;
  }

  return await doc.save();
}

/**
 * Attach a `Link` annotation with a URI action to the supplied page
 * over the given rectangle. pdf-lib doesn't expose a high-level
 * `addLink` helper, so we construct the annotation dictionary
 * directly and append it to the page's `/Annots` array.
 */
function attachUriLinkAnnotation(
  page: PDFPage,
  rect: { x: number; y: number; width: number; height: number; uri: string },
): void {
  const ctx = page.doc.context;
  const linkAnnot = ctx.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Border: [0, 0, 0],
    A: {
      Type: "Action",
      S: "URI",
      URI: rect.uri,
    },
  });
  const annotsKey = PDFName.of("Annots");
  const existing = page.node.lookupMaybe(annotsKey, PDFArray);
  if (existing) {
    existing.push(linkAnnot);
    return;
  }
  page.node.set(annotsKey, ctx.obj([linkAnnot]));
}
