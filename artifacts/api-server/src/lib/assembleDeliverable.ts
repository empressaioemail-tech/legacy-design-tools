/**
 * assembleDeliverable — Track G Phase 1 print/export.
 *
 * Builds a single downloadable review-deliverable PDF from an engagement's
 * findings, AI annotations, source plan documents, and (optional) review
 * letter, using pdf-lib (pure JS). The output has four sections in order:
 *
 *   1. TITLE PAGE — brand bar + engagement metadata + fail/pass summary.
 *   2. ANNOTATED PLAN PAGES — every page of every loadable source PDF copied
 *      in order, with numbered red-circle callouts drawn over each annotation
 *      whose `location2d` maps to a copied page.
 *   3. FINDINGS SUMMARY — one row per finding with its callout number, code
 *      section / category label, severity, pass/fail marker, and wrapped body
 *      text; overflows onto additional pages.
 *   4. REVIEW LETTER — the letter draft, wrapped across as many pages as
 *      needed. Rendered only when a non-empty draft is supplied.
 *
 * The lib is intentionally free of ObjectStorageService and DB imports so it
 * is unit-testable: the caller passes source-PDF bytes in via
 * `fetchSourcePdfBytes` and pre-loaded rows via the other inputs. Structural
 * input types below are narrow local interfaces (the subset of the drizzle
 * `$inferSelect` shapes this renderer actually reads).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";

// ─── Structural input types (narrow subset of the drizzle rows) ─────────────

/** Engagement metadata drawn on the title page. All fields nullable-guarded. */
export interface DeliverableEngagement {
  id: string;
  name?: string | null;
  address?: string | null;
  jurisdiction?: string | null;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  applicantFirm?: string | null;
}

/** A finding row (subset of `findings.$inferSelect`). */
export interface DeliverableFinding {
  id: string;
  severity: string; // 'blocker' | 'concern' | 'advisory'
  category: string;
  status: string; // 'ai-produced' | 'accepted' | 'rejected' | 'overridden' | 'promoted-to-architect'
  text: string;
  confidence?: unknown;
  citations?: unknown; // jsonb array of FindingCitation
}

/** An AI annotation row (subset of `engagementAnnotations.$inferSelect`). */
export interface DeliverableAnnotation {
  id: string;
  findingId?: string | null;
  location2d?: unknown; // { submissionId, page (1-indexed), bbox [x1,y1,x2,y2] 0..1 top-left, label }
}

/** Source plan document (subset of `attachedDocuments.$inferSelect`). */
export interface DeliverableDocument {
  id: string;
  title?: string | null;
  documentType?: string | null;
  originalBlobRef: string;
}

/** In-memory letter draft shape. */
export interface DeliverableLetter {
  draft: string;
  generatedAt?: string;
}

export interface AssembleDeliverableInput {
  engagement: DeliverableEngagement;
  findings: DeliverableFinding[];
  annotations: DeliverableAnnotation[];
  documents: DeliverableDocument[];
  letter: DeliverableLetter | null;
  /**
   * Fetch the raw bytes of a source PDF by its object path. Returns null on
   * any failure (missing / non-PDF / access denied) so one bad document never
   * aborts the export. Injected by the route so this lib stays storage-free.
   */
  fetchSourcePdfBytes: (objectPath: string) => Promise<Buffer | null>;
}

// ─── Layout constants (US Letter) ───────────────────────────────────────────

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const TOP_Y = PAGE_HEIGHT - 64;
const BOTTOM_MARGIN = 56;

/**
 * Verbatim brand string — keep the em dash (U+2014) and exact casing. WinAnsi
 * (Helvetica standard encoding) includes U+2014, so drawText encodes it fine.
 * Do NOT substitute a hyphen.
 */
const BRAND_STRING = "Powered by Hauska Engine — hauska.dev";

const COLOR_INK = rgb(0.1, 0.1, 0.12);
const COLOR_MUTED = rgb(0.4, 0.4, 0.45);
const COLOR_RED = rgb(0.85, 0.15, 0.15);
const COLOR_GREEN = rgb(0.15, 0.55, 0.25);
const COLOR_WHITE = rgb(1, 1, 1);
const COLOR_BAR = rgb(0.13, 0.16, 0.22);

// ─── Small pure helpers ─────────────────────────────────────────────────────

/**
 * Determination rule (documented): a finding is treated as a FAIL-style (red)
 * row when its severity is 'blocker' or 'concern' AND it has not been
 * explicitly resolved by a reviewer (status 'accepted' or 'rejected'). A
 * severity of 'advisory', or any 'accepted'/'rejected' status, renders as a
 * PASS-style (green) row. Rationale: blockers/concerns are open compliance
 * issues (fail) until a reviewer dispositions them; advisories are
 * informational (pass). Anything else defaults to pass.
 */
export function isFailFinding(f: {
  severity: string;
  status: string;
}): boolean {
  if (f.status === "accepted" || f.status === "rejected") return false;
  return f.severity === "blocker" || f.severity === "concern";
}

/**
 * Word-wrap `text` to at most `maxChars` per line. Splits on whitespace;
 * a single token longer than maxChars is hard-broken so it never overflows.
 * Newlines in the source are preserved as line breaks.
 */
export function wrapText(text: string, maxChars: number): string[] {
  const max = Math.max(1, Math.floor(maxChars));
  const out: string[] = [];
  const paragraphs = String(text ?? "").split(/\r?\n/);
  for (const para of paragraphs) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let line = "";
    for (let word of words) {
      // Hard-break tokens that exceed the line width on their own.
      while (word.length > max) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, max));
        word = word.slice(max);
      }
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= max) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Coerce an unknown value to a finite number, else null. */
function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface ParsedLocation2d {
  page: number; // 1-indexed
  bbox: [number, number, number, number]; // normalized 0..1, top-left origin
}

/** Parse a `location2d` jsonb blob into a typed shape, or null if unusable. */
export function parseLocation2d(raw: unknown): ParsedLocation2d | null {
  if (!raw || typeof raw !== "object") return null;
  const loc = raw as { page?: unknown; bbox?: unknown };
  const page = asFiniteNumber(loc.page);
  if (page == null || page < 1) return null;
  if (!Array.isArray(loc.bbox) || loc.bbox.length < 4) return null;
  const nums = loc.bbox.slice(0, 4).map((n) => asFiniteNumber(n));
  if (nums.some((n) => n == null)) return null;
  return {
    page: Math.floor(page),
    bbox: nums as [number, number, number, number],
  };
}

/**
 * Derive a "code section" label for the summary: the first citation whose
 * kind === 'code-section' (its atomId), else fall back to the finding
 * category. Defensive against malformed jsonb.
 */
export function codeSectionLabel(f: {
  category: string;
  citations?: unknown;
}): string {
  if (Array.isArray(f.citations)) {
    for (const c of f.citations) {
      if (
        c &&
        typeof c === "object" &&
        (c as { kind?: unknown }).kind === "code-section"
      ) {
        const atomId = (c as { atomId?: unknown }).atomId;
        if (typeof atomId === "string" && atomId.trim()) return atomId;
      }
    }
  }
  return f.category || "other";
}

// ─── Callout ordering ───────────────────────────────────────────────────────

interface CalloutPlacement {
  number: number;
  annotation: DeliverableAnnotation;
  location: ParsedLocation2d;
}

/**
 * Assign stable callout numbers to annotations that have a usable location2d.
 * Stable order: page ascending, then findingId (string), then annotation id.
 * Returns the ordered placements plus a findingId -> number lookup so the
 * findings summary can print the same number next to the matching finding.
 */
export function assignCallouts(annotations: DeliverableAnnotation[]): {
  placements: CalloutPlacement[];
  numberByFindingId: Map<string, number>;
} {
  const withLoc: Array<{ ann: DeliverableAnnotation; loc: ParsedLocation2d }> =
    [];
  for (const ann of annotations) {
    const loc = parseLocation2d(ann.location2d);
    if (loc) withLoc.push({ ann, loc });
  }
  withLoc.sort((a, b) => {
    if (a.loc.page !== b.loc.page) return a.loc.page - b.loc.page;
    const fa = a.ann.findingId ?? "";
    const fb = b.ann.findingId ?? "";
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.ann.id < b.ann.id ? -1 : a.ann.id > b.ann.id ? 1 : 0;
  });
  const placements: CalloutPlacement[] = [];
  const numberByFindingId = new Map<string, number>();
  withLoc.forEach((entry, i) => {
    const number = i + 1;
    placements.push({ number, annotation: entry.ann, location: entry.loc });
    // First callout wins the finding's number if several annotations share a
    // findingId (rare); the summary shows one number per finding.
    if (entry.ann.findingId && !numberByFindingId.has(entry.ann.findingId)) {
      numberByFindingId.set(entry.ann.findingId, number);
    }
  });
  return { placements, numberByFindingId };
}

// ─── Drawing helpers ────────────────────────────────────────────────────────

/**
 * Draw a numbered filled red circle at the top-left corner of a bbox on the
 * given page, plus a thin red rectangle outline around the bbox. Everything
 * guarded so a malformed geometry never throws out of the render loop.
 */
function drawCallout(
  page: PDFPage,
  loc: ParsedLocation2d,
  number: number,
  font: PDFFont,
): void {
  try {
    const { width, height } = page.getSize();
    const [x1, y1, x2, y2] = loc.bbox;
    // bbox is 0..1 normalized, origin top-left; pdf-lib origin is bottom-left.
    const px = Math.min(x1, x2) * width;
    const pw = Math.abs(x2 - x1) * width;
    const ryTop = Math.min(y1, y2) * height;
    const rh = Math.abs(y2 - y1) * height;
    const ry = height - ryTop - rh;
    page.drawRectangle({
      x: px,
      y: ry,
      width: pw,
      height: rh,
      borderColor: COLOR_RED,
      borderWidth: 1.5,
    });
    const radius = 10;
    // Anchor the badge at the top-left corner of the bbox.
    const cx = px;
    const cy = ry + rh;
    page.drawCircle({
      x: cx,
      y: cy,
      size: radius,
      color: COLOR_RED,
    });
    const label = String(number);
    const size = 9;
    const textWidth = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: cx - textWidth / 2,
      y: cy - size / 2 + 1,
      size,
      font,
      color: COLOR_WHITE,
    });
  } catch {
    // Never crash on a malformed bbox / page geometry.
  }
}

// ─── Main assembler ─────────────────────────────────────────────────────────

export async function assembleDeliverable(
  input: AssembleDeliverableInput,
): Promise<Uint8Array> {
  const { engagement, findings, annotations, documents, letter } = input;

  const outDoc = await PDFDocument.create();
  const helvetica = await outDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  const failCount = findings.filter((f) => isFailFinding(f)).length;
  const passCount = findings.length - failCount;

  // ── Section 1: TITLE PAGE ─────────────────────────────────────────────────
  const title = outDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  // Header brand bar.
  title.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 96,
    width: PAGE_WIDTH,
    height: 96,
    color: COLOR_BAR,
  });
  title.drawText("REVIEW DELIVERABLE", {
    x: MARGIN_X,
    y: PAGE_HEIGHT - 56,
    size: 26,
    font: helveticaBold,
    color: COLOR_WHITE,
  });
  // Brand sub-line inside the header bar (verbatim brand string).
  title.drawText(BRAND_STRING, {
    x: MARGIN_X,
    y: PAGE_HEIGHT - 82,
    size: 11,
    font: helvetica,
    color: rgb(0.78, 0.82, 0.9),
  });

  // Metadata block.
  const jurisdiction =
    engagement.jurisdiction ??
    [engagement.jurisdictionCity, engagement.jurisdictionState]
      .filter(Boolean)
      .join(", ");
  const metaRows: Array<[string, string]> = [
    ["Case / Name", engagement.name ?? ""],
    ["Address", engagement.address ?? ""],
    ["Jurisdiction", jurisdiction || ""],
    ["Applicant", engagement.applicantFirm ?? ""],
    ["Export Date", new Date().toISOString()],
  ];
  let my = PAGE_HEIGHT - 150;
  for (const [label, value] of metaRows) {
    title.drawText(label.toUpperCase(), {
      x: MARGIN_X,
      y: my,
      size: 9,
      font: helveticaBold,
      color: COLOR_MUTED,
    });
    title.drawText(value || "—", {
      x: MARGIN_X + 130,
      y: my,
      size: 12,
      font: helvetica,
      color: COLOR_INK,
    });
    my -= 26;
  }

  // Fail / pass summary line.
  my -= 12;
  title.drawText(
    `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${failCount} fail, ${passCount} pass`,
    {
      x: MARGIN_X,
      y: my,
      size: 13,
      font: helveticaBold,
      color: COLOR_INK,
    },
  );

  // Footer brand string (verbatim, second placement for redundancy).
  title.drawText(BRAND_STRING, {
    x: MARGIN_X,
    y: 40,
    size: 9,
    font: helvetica,
    color: COLOR_MUTED,
  });

  // ── Section 2: ANNOTATED PLAN PAGES ───────────────────────────────────────
  // Copy every page of every loadable source PDF, tracking a flat array in
  // order so location2d.page (1-indexed) maps to copiedPages[page - 1].
  const copiedPages: PDFPage[] = [];
  for (const docRow of documents) {
    let bytes: Buffer | null = null;
    try {
      bytes = await input.fetchSourcePdfBytes(docRow.originalBlobRef);
    } catch {
      bytes = null;
    }
    if (!bytes) continue;
    try {
      const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const indices = srcDoc.getPageIndices();
      const copied = await outDoc.copyPages(srcDoc, indices);
      for (const p of copied) {
        outDoc.addPage(p);
        copiedPages.push(p);
      }
    } catch {
      // Not a loadable PDF (DWG / image / corrupt) — skip, never crash.
    }
  }

  const { placements, numberByFindingId } = assignCallouts(annotations);
  for (const placement of placements) {
    const page = copiedPages[placement.location.page - 1];
    if (!page) continue; // clamp out-of-range pages
    drawCallout(page, placement.location, placement.number, helveticaBold);
  }

  // ── Section 3: FINDINGS SUMMARY ───────────────────────────────────────────
  // Real multi-page overflow: start a fresh page whenever y drops below the
  // bottom margin.
  const wrapCharsBody = 78;
  let summary = outDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let sy = TOP_Y;

  const newSummaryPage = (): void => {
    summary = outDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    sy = TOP_Y;
  };

  summary.drawText("FINDINGS SUMMARY", {
    x: MARGIN_X,
    y: sy,
    size: 18,
    font: helveticaBold,
    color: COLOR_INK,
  });
  sy -= 30;

  if (findings.length === 0) {
    summary.drawText("No findings recorded for this engagement.", {
      x: MARGIN_X,
      y: sy,
      size: 11,
      font: helvetica,
      color: COLOR_MUTED,
    });
  }

  for (const f of findings) {
    const fail = isFailFinding(f);
    const marker = fail ? "FAIL" : "PASS";
    const markerColor = fail ? COLOR_RED : COLOR_GREEN;
    const calloutNum = numberByFindingId.get(f.id);
    const calloutLabel = calloutNum != null ? `[${calloutNum}]` : "—";
    const sectionLabel = codeSectionLabel(f);
    const bodyLines = wrapText(f.text ?? "", wrapCharsBody);

    // Estimate row height (header line + body lines + spacing); page-break if
    // it won't fit.
    const rowHeight = 16 + bodyLines.length * 12 + 12;
    if (sy - rowHeight < BOTTOM_MARGIN) newSummaryPage();

    // Header line: [n] section · severity · MARKER
    summary.drawText(calloutLabel, {
      x: MARGIN_X,
      y: sy,
      size: 11,
      font: helveticaBold,
      color: COLOR_INK,
    });
    summary.drawText(`${sectionLabel}  ·  ${f.severity}`, {
      x: MARGIN_X + 40,
      y: sy,
      size: 11,
      font: helveticaBold,
      color: COLOR_INK,
    });
    summary.drawText(marker, {
      x: PAGE_WIDTH - MARGIN_X - 40,
      y: sy,
      size: 11,
      font: helveticaBold,
      color: markerColor,
    });
    sy -= 16;

    for (const line of bodyLines) {
      if (sy - 12 < BOTTOM_MARGIN) newSummaryPage();
      summary.drawText(line, {
        x: MARGIN_X + 12,
        y: sy,
        size: 10,
        font: helvetica,
        color: COLOR_INK,
      });
      sy -= 12;
    }
    sy -= 12; // inter-row gap
  }

  // ── Section 4: REVIEW LETTER ──────────────────────────────────────────────
  if (letter?.draft && letter.draft.trim().length > 0) {
    const wrapCharsLetter = 88;
    let letterPage = outDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let ly = TOP_Y;

    letterPage.drawText("REVIEW LETTER", {
      x: MARGIN_X,
      y: ly,
      size: 18,
      font: helveticaBold,
      color: COLOR_INK,
    });
    ly -= 30;

    const lines = wrapText(letter.draft, wrapCharsLetter);
    for (const line of lines) {
      if (ly - 14 < BOTTOM_MARGIN) {
        letterPage = outDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        ly = TOP_Y;
      }
      letterPage.drawText(line, {
        x: MARGIN_X,
        y: ly,
        size: 11,
        font: helvetica,
        color: COLOR_INK,
      });
      ly -= 14;
    }
  }

  return outDoc.save();
}
