/**
 * jurisdictions.ts is the lookup table that turns engagement geocode data
 * into a jurisdiction key. The three-tier fallback chain (structured city +
 * state → freeform jurisdiction string → address scan) is the bug-prone
 * part: if any tier breaks silently, retrieval returns zero atoms and the
 * Code Library tab goes blank for that engagement.
 */

import { describe, it, expect } from "vitest";
import {
  keyFromEngagement,
  getJurisdiction,
  listJurisdictions,
  JURISDICTIONS,
} from "./jurisdictions";

describe("jurisdictions registry", () => {
  it("exposes both shipped jurisdictions", () => {
    const keys = listJurisdictions().map((j) => j.key);
    expect(keys).toContain("grand_county_ut");
    expect(keys).toContain("bastrop_tx");
  });

  it("getJurisdiction returns null for unknown keys", () => {
    expect(getJurisdiction("zzz_nowhere")).toBeNull();
  });

  it("Bastrop config carries the resolved Municode clientId", () => {
    const cfg = getJurisdiction("bastrop_tx");
    expect(cfg).not.toBeNull();
    const book = cfg!.books.find((b) => b.sourceName === "bastrop_municode");
    expect(book?.config?.municodeClientId).toBe(1169);
  });

  it("every JURISDICTIONS entry's key matches its dictionary key", () => {
    for (const [k, v] of Object.entries(JURISDICTIONS)) {
      expect(v.key).toBe(k);
    }
  });
});

describe("keyFromEngagement: three-tier fallback", () => {
  it("Tier 1 — structured city + state (preferred)", () => {
    expect(
      keyFromEngagement({ jurisdictionCity: "Moab", jurisdictionState: "UT" }),
    ).toBe("grand_county_ut");
    expect(
      keyFromEngagement({ jurisdictionCity: "Bastrop", jurisdictionState: "TX" }),
    ).toBe("bastrop_tx");
  });

  it("Tier 1 is case-insensitive", () => {
    expect(
      keyFromEngagement({ jurisdictionCity: "MOAB", jurisdictionState: "ut" }),
    ).toBe("grand_county_ut");
  });

  it("Tier 1 — also accepts the county spelling for Grand County", () => {
    expect(
      keyFromEngagement({
        jurisdictionCity: "Grand County",
        jurisdictionState: "UT",
      }),
    ).toBe("grand_county_ut");
  });

  it("Tier 2 — freeform 'City, ST' jurisdiction string", () => {
    expect(keyFromEngagement({ jurisdiction: "Moab, UT" })).toBe("grand_county_ut");
    expect(keyFromEngagement({ jurisdiction: "Bastrop, TX" })).toBe("bastrop_tx");
  });

  it("Tier 2 — handles 'City, State Zip' shape from some geocoders", () => {
    expect(keyFromEngagement({ jurisdiction: "Moab, UT 84532" })).toBe(
      "grand_county_ut",
    );
  });

  it("Tier 2 — handles full state name ('Utah' not just 'UT')", () => {
    expect(keyFromEngagement({ jurisdiction: "Moab, Utah" })).toBe(
      "grand_county_ut",
    );
  });

  it("Tier 3 — scans address for a known city/state pair", () => {
    expect(
      keyFromEngagement({ address: "1421 Seguin St, Moab, UT 84532" }),
    ).toBe("grand_county_ut");
    expect(
      keyFromEngagement({ address: "200 Main St, Bastrop, TX 78602" }),
    ).toBe("bastrop_tx");
  });

  it("Tier 3 — case-insensitive address scan", () => {
    expect(
      keyFromEngagement({ address: "1 main st, MOAB, ut 84532" }),
    ).toBe("grand_county_ut");
  });

  it("Tier 3 — does NOT match 'Moab, OK' (state must match)", () => {
    expect(keyFromEngagement({ address: "Moab, OK 74661" })).toBeNull();
  });

  it("returns null when nothing is provided", () => {
    expect(keyFromEngagement({})).toBeNull();
    expect(
      keyFromEngagement({
        jurisdictionCity: null,
        jurisdictionState: null,
        jurisdiction: null,
        address: null,
      }),
    ).toBeNull();
  });

  it("returns null for an unknown jurisdiction", () => {
    expect(
      keyFromEngagement({
        jurisdictionCity: "Boise",
        jurisdictionState: "ID",
      }),
    ).toBeNull();
    expect(keyFromEngagement({ jurisdiction: "Boise, ID" })).toBeNull();
  });

  it("structured tier wins when both structured and freeform are present", () => {
    // If structured says Bastrop but freeform says Moab, the structured
    // (geocoder-blessed) value wins.
    expect(
      keyFromEngagement({
        jurisdictionCity: "Bastrop",
        jurisdictionState: "TX",
        jurisdiction: "Moab, UT",
      }),
    ).toBe("bastrop_tx");
  });

  it("freeform falls back to address when freeform is unrecognized", () => {
    expect(
      keyFromEngagement({
        jurisdiction: "Unknown Town, ZZ",
        address: "1421 Seguin St, Moab, UT 84532",
      }),
    ).toBe("grand_county_ut");
  });

  it("ignores garbage freeform without a comma", () => {
    expect(keyFromEngagement({ jurisdiction: "just a string" })).toBeNull();
  });
});
