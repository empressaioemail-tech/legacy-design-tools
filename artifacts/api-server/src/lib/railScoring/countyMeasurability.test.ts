/**
 * PER-COUNTY MEASURABILITY — every refusal is proven able to FIRE.
 *
 * DEV_PROCESS 2.2: a gating indicator is tested for its ability to fire before
 * it is trusted, and a test that cannot fail for the right reason is a defect
 * rather than a test. This gate's whole job is to REFUSE, so a suite that only
 * checked the happy path would be checking the one thing that does not matter.
 * All six branches below, plus the ordering between them, which is part of the
 * rule.
 */

import { describe, it, expect } from "vitest";
import {
  resolveStampCellMeasurability,
  type StampCellMeasurabilityInput,
} from "./countyMeasurability";

/** A county that CAN be measured. Each test perturbs exactly one field. */
function measurable(): StampCellMeasurabilityInput {
  return {
    table: "txgio_parcel",
    hasStampColumn: true,
    wiredZoningLayers: 2,
    anyStamped: true,
    cityBoundaryRows: 1222,
    needsCityBoundary: true,
    featuresWithGeom: 63357,
  };
}

describe("resolveStampCellMeasurability", () => {
  it("passes the shape Bastrop 48021 actually has", () => {
    // 2 wired layers (bastrop-city-tx, elgin-tx), 63,357 features all with
    // geom, 1,222 boundary rows. The live positive case, not a synthetic one.
    const r = resolveStampCellMeasurability(measurable());
    expect(r.measurable).toBe(true);
    expect(r.refusal).toBeNull();
    expect(r.basis).toBeNull();
  });

  it("REFUSES a county with no parcels at all", () => {
    const r = resolveStampCellMeasurability({ ...measurable(), table: null });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-parcels");
    expect(r.basis).toContain("neither txgio_parcel");
  });

  it("REFUSES when the municipal boundary table is absent or empty", () => {
    const r = resolveStampCellMeasurability({
      ...measurable(),
      cityBoundaryRows: 0,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-city-boundary-table");
    // The basis must name the substitution it is preventing, or a reader
    // treats the refusal as a shrug.
    expect(r.basis).toContain("15.22%");
  });

  it("REFUSES Caldwell's shape: parcels present, PostGIS geom on none of them", () => {
    // The live defect this branch was written for: 26,155 features, 0 with
    // geom, jsonb geometry and bbox columns both populated. Nothing about the
    // county looks empty, and a spatial denominator over it is silently zero.
    const r = resolveStampCellMeasurability({
      ...measurable(),
      featuresWithGeom: 0,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-parcel-geometry");
    expect(r.basis).toContain("48055");
  });

  it("does NOT consult geometry when the denominator is not spatial", () => {
    // A parcel-feature denominator needs no geom. Refusing there would take a
    // working rail offline for a reason that does not apply to it — the
    // permanently-red-gate failure mode (DEV_PROCESS 2.0).
    const r = resolveStampCellMeasurability({
      ...measurable(),
      needsCityBoundary: false,
      featuresWithGeom: 0,
      cityBoundaryRows: 0,
    });
    expect(r.measurable).toBe(true);
  });

  it("REFUSES a county with no wired city zoning layer — SS-W13's rule, called not copied", () => {
    const r = resolveStampCellMeasurability({
      ...measurable(),
      wiredZoningLayers: 0,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-wired-layer");
  });

  it("REFUSES a wired county whose stamp was never rolled", () => {
    const r = resolveStampCellMeasurability({
      ...measurable(),
      anyStamped: false,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("stamp-not-rolled");
  });

  it("REFUSES a parcel table that cannot carry the stamp column", () => {
    const r = resolveStampCellMeasurability({
      ...measurable(),
      table: "txgio_parcel_staging",
      hasStampColumn: false,
    });
    expect(r.measurable).toBe(false);
    expect(r.refusal).toBe("no-zoning-column");
  });

  it("reports the UPSTREAM cause when several refusals apply at once", () => {
    // ORDER IS PART OF THE RULE. A county with no parcels also has no wired
    // layer's worth of anything; reporting `no-wired-layer` would be true and
    // would send the reader to wire a city layer for a county whose parcels
    // were never loaded.
    const r = resolveStampCellMeasurability({
      table: null,
      hasStampColumn: false,
      wiredZoningLayers: 0,
      anyStamped: false,
      cityBoundaryRows: 0,
      needsCityBoundary: true,
      featuresWithGeom: 0,
    });
    expect(r.refusal).toBe("no-parcels");
  });

  it("every refusal carries a non-empty basis", () => {
    // A refusal a reader cannot act on becomes a shrug, and a shrug is how a
    // gate gets switched off (DEV_PROCESS 2.0).
    const cases: StampCellMeasurabilityInput[] = [
      { ...measurable(), table: null },
      { ...measurable(), cityBoundaryRows: 0 },
      { ...measurable(), featuresWithGeom: 0 },
      { ...measurable(), wiredZoningLayers: 0 },
      { ...measurable(), anyStamped: false },
      { ...measurable(), table: "txgio_parcel_staging", hasStampColumn: false },
    ];
    for (const c of cases) {
      const r = resolveStampCellMeasurability(c);
      expect(r.measurable).toBe(false);
      expect(r.refusal).toBeTruthy();
      expect((r.basis ?? "").length).toBeGreaterThan(40);
    }
  });
});
