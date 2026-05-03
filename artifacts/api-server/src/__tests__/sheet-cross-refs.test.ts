/**
 * Unit tests for {@link extractSheetCrossRefs} (PLR-8).
 *
 * Covers:
 *   - keyword form ("SEE A-301", "REFER TO SHEET A101")
 *   - detail-on-sheet form ("5/A-501")
 *   - case insensitivity + uppercase normalization
 *   - mixed forms within the same body, in source order
 *   - overlap suppression so "SEE 5/A-501" doesn't double-fire
 *   - rejection of bare numbers / non-sheet-shaped tokens
 *   - empty / null-ish input safety
 */
import { describe, it, expect } from "vitest";
import { extractSheetCrossRefs } from "../lib/sheetCrossRefs";

describe("extractSheetCrossRefs", () => {
  it("returns an empty array for empty input", () => {
    expect(extractSheetCrossRefs("")).toEqual([]);
  });

  it("captures the keyword + sheet form", () => {
    const refs = extractSheetCrossRefs("SEE A-301 for typical detail.");
    expect(refs).toEqual([
      { raw: "SEE A-301", sheetNumber: "A-301" },
    ]);
  });

  it("normalizes the sheet number to upper case", () => {
    const refs = extractSheetCrossRefs("see a-301 for typical detail.");
    expect(refs).toEqual([
      { raw: "see a-301", sheetNumber: "A-301" },
    ]);
  });

  it("captures the detail-on-sheet form with detailNumber", () => {
    const refs = extractSheetCrossRefs("Reference 5/A-501 for section.");
    expect(refs).toEqual([
      { raw: "5/A-501", sheetNumber: "A-501", detailNumber: "5" },
    ]);
  });

  it("captures multiple references in source order", () => {
    const refs = extractSheetCrossRefs(
      "Coordinate with SEE A-301 and detail 12/S-201.1 elsewhere.",
    );
    expect(refs).toEqual([
      { raw: "SEE A-301", sheetNumber: "A-301" },
      { raw: "12/S-201.1", sheetNumber: "S-201.1", detailNumber: "12" },
    ]);
  });

  it("suppresses overlapping keyword + detail/sheet matches", () => {
    // The keyword form would match "SEE 5/A-501" via "SEE 5..." BUT the
    // detail/sheet form correctly captures "5/A-501". Either way, only
    // one ref should land for that span.
    const refs = extractSheetCrossRefs("SEE 5/A-501 for section detail.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      raw: "5/A-501",
      sheetNumber: "A-501",
      detailNumber: "5",
    });
  });

  it("recognizes REFER TO SHEET ... and DWG variants", () => {
    const refs = extractSheetCrossRefs(
      "REFER TO SHEET A101. Also see DWG. M-201 for HVAC.",
    );
    expect(refs).toEqual([
      { raw: "REFER TO SHEET A101", sheetNumber: "A101" },
      { raw: "DWG. M-201", sheetNumber: "M-201" },
    ]);
  });

  it("ignores bare numbers and non-sheet tokens", () => {
    expect(
      extractSheetCrossRefs("Note 12 — see chapter 4 of the spec."),
    ).toEqual([]);
  });

  it("handles paragraph text with no references", () => {
    expect(
      extractSheetCrossRefs("All work shall conform to local code."),
    ).toEqual([]);
  });
});
