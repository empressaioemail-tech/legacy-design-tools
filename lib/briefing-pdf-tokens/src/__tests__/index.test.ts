/**
 * Contract tests for `@workspace/briefing-pdf-tokens` — the single
 * source of truth shared between
 * `artifacts/api-server/src/lib/briefingHtml.ts` (which interpolates
 * the tokens into the printed PDF's `@page @top-left` margin box) and
 * `artifacts/design-tools/src/pages/Settings.tsx` (which applies them
 * as inline styles on the live header preview).
 *
 * The token values themselves are pinned here so any accidental edit
 * to the lib lights up red in CI rather than silently shipping a
 * preview / renderer mismatch. The renderer-side drift test lives in
 * `briefing-export-pdf.test.ts` (Task #393).
 */
import { describe, it, expect } from "vitest";
import {
  BRIEFING_PDF_HEADER_TOKENS,
  DEFAULT_BRIEFING_PDF_HEADER,
} from "../index";

describe("briefing-pdf-tokens", () => {
  it("exports the platform-default header string verbatim", () => {
    // Mirrors the user-facing copy in Settings.tsx and the renderer
    // fallback — pinned so a typo in the constant is caught here
    // before either consumer can drift.
    expect(DEFAULT_BRIEFING_PDF_HEADER).toBe(
      "SmartCity Design Tools — Pre-Design Briefing",
    );
  });

  it("exposes the printed-CSS-literal typography tokens both surfaces consume", () => {
    // The values are CSS literals — Puppeteer paints them straight
    // into the page chrome and the React preview applies them as
    // inline styles, so the same string must be usable in both
    // contexts without re-encoding.
    expect(BRIEFING_PDF_HEADER_TOKENS.fontFamily).toBe(
      '-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif',
    );
    expect(BRIEFING_PDF_HEADER_TOKENS.fontSize).toBe("9pt");
    expect(BRIEFING_PDF_HEADER_TOKENS.color).toBe("#555");
  });

  it("freezes the token shape at the type level (readonly)", () => {
    // The `as const` declaration narrows the values to readonly
    // string literals; this test documents the runtime expectation
    // (no surprise mutation) without asserting on the type system.
    const tokens: { readonly fontFamily: string } = BRIEFING_PDF_HEADER_TOKENS;
    expect(typeof tokens.fontFamily).toBe("string");
  });
});
