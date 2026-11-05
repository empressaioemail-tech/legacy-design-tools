/**
 * Parcel history from the TxGIO annual releases, in the P-499 shape: each
 * release is a source_feature provider (txgio.parcels.<year>) written through
 * source_feature_stage. Values as published; a content-derived key that
 * includes the vintage; the as-of read picks the latest release at or
 * before the year.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { newCounters } from "../types";
import {
  countReleaseKeys,
  parcelAsOfSql,
  parcelReleaseProvider,
  publishedValue,
  publishedYear,
  releaseKey,
  releaseRowFromFeature,
  releaseYearFromLabel,
  stageReleaseRows,
  type ReleaseStageDb,
} from "../txgio/parcel-release";

const ctx = {
  year: 2022,
  vintage: "stratmap22-landparcels_48021_bastrop_202207",
  sourceUrl: "file:stratmap22-landparcels_48021_lp.zip",
  loadRunId: "run-1",
  fetchedAt: new Date("2026-11-05T06:00:00Z"),
};
const square = { type: "Polygon", coordinates: [[[-97.3174, 30.1106], [-97.3169, 30.1106], [-97.3169, 30.1109], [-97.3174, 30.1109], [-97.3174, 30.1106]]] };
const feature = (props: Record<string, unknown>, geometry: unknown = square) => ({ properties: props, geometry: geometry as never });

describe("release identity", () => {
  it("one provider per release, read from the label", () => {
    expect(parcelReleaseProvider(2022)).toBe("txgio.parcels.2022");
    expect(releaseYearFromLabel("stratmap22-landparcels_48021_bastrop_202207")).toBe(2022);
    expect(releaseYearFromLabel("stratmap19-landparcels_48021_lp")).toBe(2019);
    expect(releaseYearFromLabel("stratmap226-x")).toBeNull();
  });

  it("the key is content-derived: same feature, same key; another release or geometry, another key", () => {
    const a = releaseKey("48021", ctx.vintage, "34105", square);
    expect(releaseKey("48021", ctx.vintage, "34105", JSON.parse(JSON.stringify(square)))).toBe(a);
    expect(releaseKey("48021", "stratmap23-landparcels_48021", "34105", square)).not.toBe(a);
    const moved = { ...square, coordinates: [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]] };
    expect(releaseKey("48021", ctx.vintage, "34105", moved)).not.toBe(a);
  });

  it("key order of the geometry object does not change the key", () => {
    expect(releaseKey("48021", ctx.vintage, "1", { type: "Polygon", coordinates: square.coordinates }))
      .toBe(releaseKey("48021", ctx.vintage, "1", { coordinates: square.coordinates, type: "Polygon" }));
  });
});

describe("published values and years", () => {
  it("keeps a published 0 value, nulls a blank or non-number", () => {
    expect(publishedValue(0)).toBe(0);
    expect(publishedValue("348,459")).toBe(348459);
    expect(publishedValue("")).toBeNull();
    expect(publishedValue("n/a")).toBeNull();
    expect(publishedValue(-5)).toBeNull();
  });

  it("a year of 0 is not stated, never year 0", () => {
    expect(publishedYear(0, 1700, 2100)).toBeNull();
    expect(publishedYear(1968, 1700, 2100)).toBe(1968);
    expect(publishedYear("2022", 1900, 2100)).toBe(2022);
  });
});

describe("releaseRowFromFeature", () => {
  it("builds a source_feature stage row for the release provider", () => {
    const row = releaseRowFromFeature("48021", 7, feature({
      Prop_ID: "34105", OWNER_NAME: "EXAMPLE OWNER", LEGAL_DESC: "BUILDING BLOCK 12",
      LAND_VALUE: 90000, IMP_VALUE: 0, MKT_VALUE: 90000, TAX_YEAR: 2022, YEAR_BUILT: 0,
    }), newCounters(), ctx)!;
    expect(row).toMatchObject({ provider: "txgio.parcels.2022", stateFips: "48", countyFips: "48021", vintage: ctx.vintage, loadRunId: "run-1" });
    expect(row.providerObjectId).toBe(releaseKey("48021", ctx.vintage, "34105", row.geometry));
    expect(row.payload).toMatchObject({ release_year: 2022, prop_id: "34105", owner_name: "EXAMPLE OWNER", legal_desc: "BUILDING BLOCK 12", land_value: 90000, imp_value: 0, mkt_value: 90000, tax_year: 2022, year_built: null });
  });

  it("refuses a feature with no polygon, through the current store's own gate", () => {
    expect(releaseRowFromFeature("48021", 1, feature({ Prop_ID: "1" }, null), newCounters(), ctx)).toBeNull();
  });

  it("exact duplicate features collapse to one key", () => {
    const f = feature({ Prop_ID: "9" });
    const rows = [0, 1].map((i) => releaseRowFromFeature("48021", i, f, newCounters(), ctx)!);
    expect(countReleaseKeys(rows)).toBe(1);
  });
});

describe("stageReleaseRows writes the stage, never the live table", () => {
  it("inserts into source_feature_stage with ON CONFLICT DO NOTHING", async () => {
    let target: unknown = null;
    let onConflict = false;
    const db = {
      insert: (t: unknown) => {
        target = t;
        return { values: () => ({ onConflictDoNothing: () => { onConflict = true; return Promise.resolve({ rowCount: 1 }); } }) };
      },
    } as unknown as ReleaseStageDb;
    const { sourceFeatureStage } = await import("@workspace/db/schema");
    const row = releaseRowFromFeature("48021", 0, feature({ Prop_ID: "34105" }), newCounters(), ctx)!;
    expect(await stageReleaseRows(db, [row])).toBe(1);
    expect(target).toBe(sourceFeatureStage);
    expect(onConflict).toBe(true);
    expect(await stageReleaseRows(db, [])).toBe(0);
  });
});

describe("parcelAsOfSql", () => {
  it("selects the latest release at or before the year, release providers only", () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(parcelAsOfSql("48021", "34105", 2022) as SQL);
    expect(text).toMatch(/max\(split_part\(provider, '\.', 3\)::int\)/);
    expect(text).toMatch(/\^txgio\[\.\]parcels\[\.\]\[0-9\]\{4\}\$/);
    expect(params).toEqual(["48021", "34105", "48021", "34105", 2022]);
  });
});
