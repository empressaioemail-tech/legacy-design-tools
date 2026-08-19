/**
 * STAMP FACET MEASURABILITY — the negative cases, proven able to fire.
 *
 * The zoning ledger cell for Travis 48453 read `honest_coverage_pct 0.00`,
 * `classification true-source-gap`, `source NULL` from 2026-07-21 to
 * 2026-08-19 while the deployed Smart Site fact sheet served that county's
 * parcel `48453:149405` a zoning district of SF-2 — off the SAME
 * `txgio_parcel.zoning_district` column the scorer reads. Re-scored on
 * 2026-08-19 the county measures 33.32% (276,168 stamped of 828,773 distinct
 * parcels).
 *
 * `true-source-gap` is defined by the scorer's own header as "the facet has no
 * data because the SOURCE has none — an honest absence". It was being derived
 * from the fact that `locateCounty` had fallen back to `txgio_parcel_staging`,
 * a table with no `zoning_district` column at all. An instrument's blindness
 * is not a county's absence.
 *
 * These cases pin the three refusals and, more importantly, prove each one
 * FIRES on the exact input shape that produced the bad row (DEV_PROCESS 2.2).
 */

import { describe, it, expect } from "vitest";
import { resolveStampFacetMeasurability } from "./countyCoverageScoreCli";

describe("resolveStampFacetMeasurability", () => {
  it("REFUSES when the resolved table cannot carry zoning_district", () => {
    // The exact Travis 2026-07-21 shape: fell back to staging, which has no
    // zoning_district column, and recorded a source gap from it.
    const r = resolveStampFacetMeasurability({
      table: "txgio_parcel_staging",
      hasZoningColumn: false,
      wiredZoningLayers: 2,
      stampedPct: 0,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-zoning-column");
    expect(r.basis).toContain("txgio_parcel_staging");
  });

  it("REFUSES a county with no wired city zoning layer", () => {
    // Dallas 48113: 30-plus incorporated, zoned cities, none wired. Before
    // this rule the scorer wrote 0.00% classified `real-at-ceiling`, which
    // asserts the achievable ceiling is zero.
    const r = resolveStampFacetMeasurability({
      table: "txgio_parcel",
      hasZoningColumn: true,
      wiredZoningLayers: 0,
      stampedPct: 0,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-wired-layer");
  });

  it("REFUSES when layers are wired but the stamp roll has not run", () => {
    const r = resolveStampFacetMeasurability({
      table: "txgio_parcel",
      hasZoningColumn: true,
      wiredZoningLayers: 3,
      stampedPct: 0,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("stamp-not-rolled");
  });

  it("MEASURES a wired, stamped county — Travis at 33.32%", () => {
    const r = resolveStampFacetMeasurability({
      table: "txgio_parcel",
      hasZoningColumn: true,
      wiredZoningLayers: 2,
      stampedPct: 33.32,
    });
    expect(r.measurable).toBe(true);
    expect(r.refusal).toBeNull();
    expect(r.basis).toBeNull();
  });

  it("a refusal always carries an actionable basis", () => {
    for (const input of [
      { table: "txgio_parcel_staging", hasZoningColumn: false, wiredZoningLayers: 0, stampedPct: 0 },
      { table: "txgio_parcel", hasZoningColumn: true, wiredZoningLayers: 0, stampedPct: 0 },
      { table: "txgio_parcel", hasZoningColumn: true, wiredZoningLayers: 1, stampedPct: 0 },
    ]) {
      const r = resolveStampFacetMeasurability(input);
      expect(r.measurable).toBe(false);
      expect(r.basis, JSON.stringify(input)).toBeTruthy();
      expect((r.basis ?? "").length).toBeGreaterThan(40);
    }
  });

  it("refusal precedence: a missing column is reported before a missing layer", () => {
    // Both are true at once for a staging-resolved county in an unwired
    // county. The column is the more fundamental fact and the one that made
    // the historical rows unreadable, so it must be the reported cause.
    const r = resolveStampFacetMeasurability({
      table: "txgio_parcel_staging",
      hasZoningColumn: false,
      wiredZoningLayers: 0,
      stampedPct: 0,
    });
    expect(r.refusal).toBe("no-zoning-column");
  });
});
