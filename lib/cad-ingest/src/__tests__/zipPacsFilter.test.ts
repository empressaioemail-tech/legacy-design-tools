/**
 * County-aware PACS zip-extraction filter (P-169 / A-132). The generic
 * PACS_ENTRY_FILTER runs at extraction time, BEFORE discoverFiles ever
 * sees the file list — a declaration wired only into discoverFiles would
 * still have this filter silently discard a declared county's real
 * entries (e.g. TCAD's PROP.TXT / IMP_DET.TXT) during extraction.
 */

import { describe, expect, it } from "vitest";
import { PACS_ENTRY_FILTER, pacsEntryFilterFor } from "../zip";

describe("pacsEntryFilterFor", () => {
  it("TCAD (48453): admits PROP.TXT / IMP_DET.TXT, rejects the generic-pattern names and other TCAD entries", () => {
    const filter = pacsEntryFilterFor("48453");
    expect(filter("PROP.TXT")).toBe(true);
    expect(filter("IMP_DET.TXT")).toBe(true);
    expect(filter("prop.txt")).toBe(true); // case-insensitive
    expect(filter("some/path/IMP_DET.TXT")).toBe(true); // basename match
    expect(filter("APPRAISAL_INFO.TXT")).toBe(false);
    expect(filter("APPRAISAL_IMPROVEMENT_DETAIL.TXT")).toBe(false);
    expect(filter("IMP_INFO.TXT")).toBe(false);
    expect(filter("LAND_DET.TXT")).toBe(false);
    expect(filter("IMP_ATR.TXT")).toBe(false);
  });

  it("a county with no declaration falls back to the unchanged generic filter", () => {
    const filter = pacsEntryFilterFor("48021"); // Bastrop, no declaration
    expect(filter).toBe(PACS_ENTRY_FILTER);
    expect(filter("BASTROP_APPRAISAL_INFO.TXT")).toBe(true);
    expect(filter("BASTROP_APPRAISAL_IMPROVEMENT_DETAIL.TXT")).toBe(true);
    expect(filter("PROP.TXT")).toBe(false);
  });

  it("no fips at all falls back to the unchanged generic filter", () => {
    expect(pacsEntryFilterFor(undefined)).toBe(PACS_ENTRY_FILTER);
  });
});
