/**
 * Snapshot test pinning the stamp coordinates on every page of a
 * multi-sheet fixture. Per PLR-11 step 5, the renderer MUST land the
 * city-seal stamp on every sheet — this test would catch a
 * regression that skipped or misplaced the stamp on, say, the last
 * page only.
 */

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  computeStampPlacement,
  renderCommentLetter,
  renderStampedPlanSet,
  type StampPlanSheet,
} from "../index";

/**
 * Build a single solid-colour PNG of the requested pixel size. We use
 * the smallest valid 1x1 PNG since pdf-lib only needs a real PNG
 * stream — the dimensions in the manifest are independent of the
 * embedded pixel count for our purposes (the `fullWidth` /
 * `fullHeight` numbers drive page sizing).
 */
function tinyPng(): Uint8Array {
  // 1x1 transparent PNG.
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

const FIXTURE_SHEETS: StampPlanSheet[] = [
  {
    sheetNumber: "A-101",
    sheetName: "Site plan",
    fullPng: tinyPng(),
    fullWidth: 2400,
    fullHeight: 1800,
  },
  {
    sheetNumber: "A-201",
    sheetName: "Floor plan",
    fullPng: tinyPng(),
    fullWidth: 1800,
    fullHeight: 2400,
  },
  {
    sheetNumber: "A-301",
    sheetName: "Elevations",
    fullPng: tinyPng(),
    fullWidth: 2400,
    fullHeight: 1800,
  },
];

describe("renderStampedPlanSet", () => {
  it("produces one stamped page per sheet with deterministic coordinates", async () => {
    const result = await renderStampedPlanSet({
      tenantName: "Empressa Test City",
      submissionId: "11111111-2222-3333-4444-555555555555",
      sheets: FIXTURE_SHEETS,
      decisionEvent: {
        permitNumber: "EMP-2026-0001",
        verdict: "approve",
        approvalDate: new Date("2026-05-03T15:00:00Z"),
        approverName: "Reviewer A",
        comment: null,
      },
    });

    // One placement per sheet.
    expect(result.stampPlacements).toHaveLength(FIXTURE_SHEETS.length);

    // Each placement matches the deterministic geometry helper.
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(FIXTURE_SHEETS.length);
    for (let i = 0; i < reloaded.getPageCount(); i++) {
      const page = reloaded.getPage(i);
      const expected = computeStampPlacement(page.getWidth());
      expect(result.stampPlacements[i]).toEqual(expected);
    }
  });

  it("still stamps a single fallback page when the submission has no sheets", async () => {
    const result = await renderStampedPlanSet({
      tenantName: "Empressa Test City",
      submissionId: "abc",
      sheets: [],
      decisionEvent: {
        permitNumber: "EMP-2026-0002",
        verdict: "approve_with_conditions",
        approvalDate: new Date("2026-05-03T15:00:00Z"),
        approverName: "Reviewer B",
        comment: "minor revisions",
      },
    });
    expect(result.stampPlacements).toHaveLength(1);
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });
});

describe("renderCommentLetter", () => {
  it("renders a non-empty PDF with a letterhead and finding bullets", async () => {
    const bytes = await renderCommentLetter({
      tenantName: "Empressa Test City",
      tenantAddressLines: ["123 Main St", "Bastrop, TX"],
      subject: "Plan review comments — Bastrop, TX",
      recipientName: "Acme Architects",
      sentAt: new Date("2026-05-03T15:00:00Z"),
      issuedPlanSetUrl: "/api/submissions/sub-1/issued-pdf",
      pageLabelToIssuedPage: new Map([["A-101", 1]]),
      body:
        "Dear team,\n\nWe have completed our review and identified the following items.\n\nPlease address them and resubmit.",
      findings: [
        {
          id: "f1",
          severity: "blocker",
          category: "setback",
          status: "ai-produced",
          text: "Front setback below 25ft minimum.",
          elementRef: "A-101",
        },
        {
          id: "f2",
          severity: "concern",
          category: "height",
          status: "accepted",
          text: "Height exceeds overlay cap; verify against [[CODE:height-overlay-1]].",
          elementRef: null,
        },
      ],
    });
    expect(bytes.byteLength).toBeGreaterThan(500);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
