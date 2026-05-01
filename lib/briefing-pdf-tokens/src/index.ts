/**
 * `@workspace/briefing-pdf-tokens` — single source of truth for the
 * stakeholder briefing PDF header's wording + typography.
 *
 * Two surfaces have to agree on these values byte-for-byte:
 *
 *   1. `artifacts/api-server/src/lib/briefingHtml.ts` prints the
 *      header into the `@page @top-left` margin box of the exported
 *      PDF.
 *   2. `artifacts/design-tools/src/pages/Settings.tsx` renders a
 *      live mini-preview of that same header (Task #365) so the
 *      architect can iterate on wording without round-tripping
 *      through a real export.
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
 * test in `briefingHtml.test.ts` pins the renderer's printed CSS to
 * the same token values the Settings preview consumes.
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
