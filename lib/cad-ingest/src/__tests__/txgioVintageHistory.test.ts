/**
 * Parcel history from the TxGIO annual releases (txgio_parcel_vintage).
 *
 * Values are taken as published: a blank is NULL, a year of 0 ("not stated")
 * is NULL, a published 0 value is kept. Geometry goes through the same gate
 * as the current store. The insert is append-only (ON CONFLICT DO NOTHING),
 * and the as-of read picks the latest release at or before the year.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { newCounters } from "../types";
import {
  historyRowFromFeature,
  insertVintageRows,
  parcelAsOfSql,
  publishedValue,
  publishedYear,
  vintageYearFromLabel,
  type VintageHistoryDb,
} from "../txgio/vintage-history";

const ctx = { sourceVintage: "stratmap22-landparcels_48021_bastrop_202207", vintageYear: 2022, sourceFile: "stratmap22-landparcels_48021_lp.zip" };

const feature = (props: Record<string, unknown>, geometry: unknown = {
  type: "Polygon",
  coordinates: [[[-97.3174, 30.1106], [-97.3169, 30.1106], [-97.3169, 30.1109], [-97.3174, 30.1109], [-97.3174, 30.1106]]],
}) => ({ properties: props, geometry: geometry as never });

describe("vintageYearFromLabel", () => {
  it("reads the program year from a release label", () => {
    expect(vintageYearFromLabel("stratmap22-landparcels_48021_bastrop_202207")).toBe(2022);
    expect(vintageYearFromLabel("stratmap19-landparcels_48021_lp")).toBe(2019);
    expect(vintageYearFromLabel("stratmap226-x")).toBeNull();
    expect(vintageYearFromLabel("landparcels_48021")).toBeNull();
  });
});

describe("published values and years", () => {
  it("keeps a published 0 value, nulls a blank or non-number", () => {
    expect(publishedValue(0)).toBe("0");
    expect(publishedValue("348,459")).toBe("348459");
    expect(publishedValue("")).toBeNull();
    expect(publishedValue(null)).toBeNull();
    expect(publishedValue("n/a")).toBeNull();
    expect(publishedValue(-5)).toBeNull();
  });

  it("a year of 0 is not stated, never year 0", () => {
    expect(publishedYear(0, 1700, 2100)).toBeNull();
    expect(publishedYear(1968, 1700, 2100)).toBe(1968);
    expect(publishedYear("2022", 1900, 2100)).toBe(2022);
    expect(publishedYear(19.5, 1700, 2100)).toBeNull();
  });
});

describe("historyRowFromFeature", () => {
  it("carries the release's owner, values, tax year and year built", () => {
    const row = historyRowFromFeature("48021", 7, feature({
      Prop_ID: "34105", GEO_ID: "R34105", OWNER_NAME: "EXAMPLE OWNER", SITUS_ADDR: "902 CHESTNUT ST",
      LEGAL_DESC: "BUILDING BLOCK 12 E W ST", LAND_VALUE: 90000, IMP_VALUE: 0, MKT_VALUE: 90000, TAX_YEAR: 2022, YEAR_BUILT: 0,
    }), newCounters(), ctx)!;
    expect(row).toMatchObject({
      countyFips: "48021", sourceVintage: ctx.sourceVintage, vintageYear: 2022, featureIndex: 7,
      propId: "34105", ownerName: "EXAMPLE OWNER", legalDesc: "BUILDING BLOCK 12 E W ST",
      landValue: "90000", impValue: "0", mktValue: "90000", taxYear: 2022, yearBuilt: null,
    });
    expect(row.westLng).toBeCloseTo(-97.3174);
  });

  it("refuses a feature with no polygon, through the current store's own gate", () => {
    const counters = newCounters();
    expect(historyRowFromFeature("48021", 1, feature({ Prop_ID: "1" }, null), counters, ctx)).toBeNull();
  });
});

describe("insertVintageRows is append-only", () => {
  it("inserts with ON CONFLICT DO NOTHING and never an update", async () => {
    let compiled = "";
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => {
            compiled = "on conflict do nothing";
            return Promise.resolve({ rowCount: 1 });
          },
          onConflictDoUpdate: () => {
            throw new Error("history must never update a published row");
          },
        }),
      }),
    } as unknown as VintageHistoryDb;
    const row = historyRowFromFeature("48021", 0, feature({ Prop_ID: "34105" }), newCounters(), ctx)!;
    expect(await insertVintageRows(db, [row])).toBe(1);
    expect(compiled).toBe("on conflict do nothing");
    expect(await insertVintageRows(db, [])).toBe(0);
  });
});

describe("parcelAsOfSql", () => {
  it("selects the latest release at or before the year", () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(parcelAsOfSql("48021", "34105", 2022) as SQL);
    expect(text).toMatch(/max\(vintage_year\)/);
    expect(text).toMatch(/vintage_year <= \$\d/);
    expect(params).toEqual(["48021", "34105", "48021", "34105", 2022]);
  });
});
