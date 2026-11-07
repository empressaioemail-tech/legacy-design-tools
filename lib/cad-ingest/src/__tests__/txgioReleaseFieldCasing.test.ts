/**
 * TxGIO StratMap releases name the account field `PROP_ID` (2019, 2021, 2026) or `Prop_ID` (2022-2025),
 * and the 2026 Bastrop DBF carries NUL bytes inside text fields (2026-11-06). Rows below are copied from
 * the real Bastrop 48021 DBF headers and first records.
 * FALSIFIERS: on main a `PROP_ID` row gives prop_id null, and a NUL survives into the payload.
 */
import { describe, expect, it } from "vitest";

import { newCounters } from "../types";
import { describeDbError, releaseRowFromFeature } from "../txgio/parcel-release";
import { isNullPlaceholderFeature, propIdOf } from "../txgio/parse";

const square = { type: "Polygon", coordinates: [[[-97.3174, 30.1106], [-97.3169, 30.1106], [-97.3169, 30.1109], [-97.3174, 30.1109], [-97.3174, 30.1106]]] };
const ctx = (year: number) => ({
  year,
  vintage: `stratmap${String(year).slice(2)}-landparcels_48021_bastrop`,
  sourceUrl: `file:stratmap${String(year).slice(2)}-landparcels_48021_lp.zip`,
  loadRunId: "run-1",
  fetchedAt: new Date("2026-11-06T06:00:00Z"),
});
const row = (year: number, props: Record<string, unknown>) =>
  releaseRowFromFeature("48021", 0, { properties: props, geometry: square as never }, newCounters(), ctx(year));

describe("account id field casing", () => {
  it("FALSIFIER: a 2026 row (PROP_ID) keeps its prop_id", () => {
    // The 2026 Bastrop DBF's first record: PROP_ID 10002, GEO_ID R10002.
    const r = row(2026, { PROP_ID: "10002", GEO_ID: "R10002", OWNER_NAME: "SAMPLE OWNER", TAX_YEAR: 2025 });
    expect(r?.payload.prop_id).toBe("10002");
    expect(r?.payload.geo_id).toBe("R10002");
  });

  it("a 2025 row (Prop_ID) is unchanged, and a 2019/2021 row (PROP_ID) reads too", () => {
    expect(row(2025, { Prop_ID: "10319", GEO_ID: "R10319" })?.payload.prop_id).toBe("10319");
    expect(row(2019, { PROP_ID: "34105", GEO_ID: "R34105" })?.payload.prop_id).toBe("34105");
  });

  it("the key differs once the id is read, so a reload replaces the id-less 2019/2021 rows", () => {
    const withId = row(2021, { PROP_ID: "34105", GEO_ID: "R34105" })!;
    const without = row(2021, { GEO_ID: "R34105" })!;
    expect(withId.providerObjectId).not.toBe(without.providerObjectId);
  });

  it("propIdOf reads either spelling, Prop_ID first", () => {
    expect(propIdOf({ PROP_ID: "1" })).toBe("1");
    expect(propIdOf({ Prop_ID: "2", PROP_ID: "1" })).toBe("2");
    expect(propIdOf({})).toBeUndefined();
  });

  it("a placeholder is recognised under either spelling", () => {
    expect(isNullPlaceholderFeature({ PROP_ID: "0", GEO_ID: "" })).toBe(true);
    expect(isNullPlaceholderFeature({ PROP_ID: "10002", GEO_ID: "" })).toBe(false);
  });
});

describe("NUL bytes in text fields", () => {
  it("FALSIFIER: the 2026 SITUS_ADDR ', ,\\0TX' reaches the payload without a NUL", () => {
    const r = row(2026, { PROP_ID: "10002", GEO_ID: "R10002", SITUS_ADDR: ", ,\u0000TX", LEGAL_DESC: "LOT 1\u0000BLK 2" })!;
    expect(JSON.stringify(r.payload)).not.toContain("\\u0000");
    expect(r.payload.situs_address).toBe(", , TX");
    expect(r.payload.legal_desc).toBe("LOT 1 BLK 2");
  });
});

describe("describeDbError", () => {
  it("names the SQLSTATE from drizzle's wrapped pg error", () => {
    const pgErr = Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05", detail: "\\u0000 cannot be converted to text." });
    const wrapped = Object.assign(new Error("Failed query: insert into ..."), { cause: pgErr });
    expect(describeDbError(wrapped)).toBe("SQLSTATE 22P05: unsupported Unicode escape sequence (\\u0000 cannot be converted to text.)");
    expect(describeDbError(new Error("boom"))).toBe("SQLSTATE unknown: boom");
  });
});
