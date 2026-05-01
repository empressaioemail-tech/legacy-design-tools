/**
 * `@workspace/briefing-pdf-tokens` — single source of truth for the
 * stakeholder briefing PDF header / footer wording + typography.
 *
 * Two surfaces have to agree on these values byte-for-byte:
 *
 *   1. `artifacts/api-server/src/lib/briefingHtml.ts` prints the
 *      header into the `@page @top-left` margin box and the footer
 *      watermark / page-number into the `@bottom-center` /
 *      `@bottom-right` margin boxes of the exported PDF.
 *   2. `artifacts/design-tools/src/pages/Settings.tsx` renders a
 *      live mini-preview of the header (Task #365) so the architect
 *      can iterate on wording without round-tripping through a real
 *      export. A footer preview surface does not exist today, but
 *      the moment one is added (or a designer tweaks the watermark
 *      wording / colour) the same silent-drift risk reopens.
 *
 * Before this lib existed, both surfaces hard-coded the literal CSS
 * values (font stack, 9pt, #555) and the platform-default fallback
 * string. Nothing prevented them from drifting — a designer changing
 * the renderer's header colour or default text would silently
 * desync the preview, and the Settings unit tests would happily
 * pass because they too read from the duplicated literals.
 *
 * Centralising the tokens here closes that loop: the preview now
 * provably matches the printed header by construction, and a unit
 * test in `briefing-export-pdf.test.ts` pins the renderer's printed
 * CSS to the same token values the Settings preview consumes — for
 * the header (Task #393) and the footer / page-number boxes
 * (Task #396).
 */

/** Default header text when no per-architect override is configured. */
export const DEFAULT_BRIEFING_PDF_HEADER =
  "SmartCity Design Tools — Pre-Design Briefing";

/**
 * Typography tokens for the printed PDF header (`@page @top-left`
 * margin box) and its on-screen preview. The values are CSS-literal
 * strings — Puppeteer paints them straight into the page chrome and
 * the React preview applies them as inline styles, so the same
 * literal must be usable in both contexts without re-encoding.
 */
export const BRIEFING_PDF_HEADER_TOKENS = {
  fontFamily:
    '-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif',
  fontSize: "9pt",
  color: "#555",
} as const;

export type BriefingPdfHeaderTokens = typeof BRIEFING_PDF_HEADER_TOKENS;

/**
 * Default confidentiality + freshness watermark stamped into the PDF
 * footer (`@page @bottom-center` margin box) on every printed page.
 * The wording carries the brief's disclaimer that the PDF is a
 * synthesised pre-design artefact — not an authoritative regulatory
 * record — and the recipient is expected to verify against the cited
 * primary sources before any binding decision.
 */
export const DEFAULT_FOOTER_WATERMARK =
  "Pre-Design Briefing — Not a Survey or Engineering Document. Verify all data with authoritative sources before relying for design or compliance decisions.";

/**
 * Typography tokens for the printed PDF footer watermark
 * (`@page @bottom-center`). Slightly smaller than the header so the
 * disclaimer reads as a footnote rather than competing with the
 * body copy.
 */
export const BRIEFING_PDF_FOOTER_TOKENS = {
  fontFamily:
    '-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif',
  fontSize: "7.5pt",
  color: "#555",
} as const;

export type BriefingPdfFooterTokens = typeof BRIEFING_PDF_FOOTER_TOKENS;

/**
 * Typography tokens for the printed PDF page-number marker
 * (`@page @bottom-right`). Same family + size as the footer
 * watermark, but rendered in a lighter grey so the page count sits
 * visually behind the disclaimer.
 */
export const BRIEFING_PDF_PAGE_NUMBER_TOKENS = {
  fontFamily:
    '-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif',
  fontSize: "7.5pt",
  color: "#888",
} as const;

export type BriefingPdfPageNumberTokens =
  typeof BRIEFING_PDF_PAGE_NUMBER_TOKENS;
