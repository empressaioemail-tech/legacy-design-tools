/**
 * TxGIO address-point ingest unit tests — feature normalization, the
 * paged service client's exit-bounded pagination (against an injected
 * fetch, no network), county routing, and the batch in-batch dedupe.
 *
 * The sample features are shaped exactly like the live StratMap Address
 * Points service response (feature.geographic.texas.gov, f=geojson),
 * captured against the Travis (48453) slice 2026-07-15.
 */

import { describe, expect, it } from "vitest";
import { normalizeAddressFeature, type AddressFeature } from "../address/parse";
import {
  countAddressPoints,
  fetchAddressFeatures,
  addressLayerUrl,
  ADDRESS_PAGE_SIZE,
  type FetchJson,
} from "../address/service";
import { resolveAddressCounty } from "../address/counties";
import { cellKeyForPoint } from "../txgio/geo";
import { newCounters } from "../types";

function feature(
  props: Record<string, unknown>,
  coords: [number, number] | null,
): AddressFeature {
  return {
    type: "Feature",
    geometry: coords ? { type: "Point", coordinates: coords } : null,
    properties: props,
  } as AddressFeature;
}

const TRAVIS_PROPS = {
  objectid: 10309641,
  full_addr: "3075 HILL ST",
  add_number: "3075",
  st_name: "Hill",
  unit: null,
  post_comm: "Round Rock",
  post_code: "78664",
  state: "TX",
  county: "Travis",
  fips: "48453",
  source: "CAPCOG",
  date_acq: "2025-04-07",
};
const TRAVIS_COORDS: [number, number] = [
  -97.61545415330451, 30.489303599782172,
];

describe("address feature normalization", () => {
  it("maps a live-shaped address point to the store record", () => {
    const c = newCounters();
    const rec = normalizeAddressFeature(
      "48453",
      feature(TRAVIS_PROPS, TRAVIS_COORDS),
      c,
    );
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      countyFips: "48453",
      fullAddr: "3075 HILL ST",
      unit: "", // null unit normalized to "" so it can sit in the PK
      objectId: 10309641,
      addNumber: "3075",
      stName: "Hill",
      postComm: "Round Rock",
      postCode: "78664",
      state: "TX",
      countyName: "Travis",
      source: "CAPCOG",
      dateAcq: "2025-04-07",
      longitude: TRAVIS_COORDS[0],
      latitude: TRAVIS_COORDS[1],
    });
    // tile_key is the same 0.02-degree cell key math as the parcel store.
    expect(rec?.tileKey).toBe(
      cellKeyForPoint(TRAVIS_COORDS[0], TRAVIS_COORDS[1]),
    );
    expect(c.rowsSkipped).toBe(0);
  });

  it("keeps a real unit as the PK tiebreaker", () => {
    const c = newCounters();
    const rec = normalizeAddressFeature(
      "48453",
      feature({ ...TRAVIS_PROPS, unit: "APT 2" }, TRAVIS_COORDS),
      c,
    );
    expect(rec?.unit).toBe("APT 2");
  });

  it("skips a feature with no full_addr", () => {
    const c = newCounters();
    const rec = normalizeAddressFeature(
      "48453",
      feature({ ...TRAVIS_PROPS, full_addr: "  " }, TRAVIS_COORDS),
      c,
    );
    expect(rec).toBeNull();
    expect(c.rowsSkipped).toBe(1);
  });

  it("skips a feature with no point geometry", () => {
    const c = newCounters();
    const rec = normalizeAddressFeature(
      "48453",
      feature(TRAVIS_PROPS, null),
      c,
    );
    expect(rec).toBeNull();
    expect(c.rowsSkipped).toBe(1);
  });

  it("skips a non-finite coordinate pair", () => {
    const c = newCounters();
    const rec = normalizeAddressFeature(
      "48453",
      feature(TRAVIS_PROPS, [Number.NaN, 30.4]),
      c,
    );
    expect(rec).toBeNull();
    expect(c.rowsSkipped).toBe(1);
  });
});

describe("address service pagination (exit-bounded)", () => {
  /** A fake service that pages `total` synthetic features at PAGE_SIZE. */
  function fakeService(total: number): {
    fetchJson: FetchJson;
    calls: string[];
  } {
    const calls: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      calls.push(url);
      if (url.includes("returnCountOnly=true")) return { count: total };
      const offsetMatch = url.match(/resultOffset=(\d+)/);
      const wantMatch = url.match(/resultRecordCount=(\d+)/);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      const want = wantMatch ? Number(wantMatch[1]) : ADDRESS_PAGE_SIZE;
      const remaining = Math.max(0, total - offset);
      const n = Math.min(want, remaining);
      const features = Array.from({ length: n }, (_v, i) =>
        feature(
          {
            ...TRAVIS_PROPS,
            objectid: offset + i,
            full_addr: `${offset + i} MAIN ST`,
          },
          TRAVIS_COORDS,
        ),
      );
      // Mirror the server: exceededTransferLimit only when a full page.
      return {
        features,
        exceededTransferLimit: n >= want && offset + n < total,
      };
    };
    return { fetchJson, calls };
  }

  it("counts via a single returnCountOnly call", async () => {
    const { fetchJson, calls } = fakeService(433083);
    const count = await countAddressPoints({ countyName: "Travis", fetchJson });
    expect(count).toBe(433083);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("returnCountOnly=true");
  });

  it("pages until the server stops, then returns (no unbounded loop)", async () => {
    // 3 pages: 2000 + 2000 + 500.
    const { fetchJson } = fakeService(4500);
    const rows: unknown[] = [];
    for await (const f of fetchAddressFeatures({
      countyName: "Travis",
      fetchJson,
      rateMs: 0,
    })) {
      rows.push(f);
    }
    expect(rows).toHaveLength(4500);
  });

  it("honors a bounded --limit and stops early", async () => {
    const { fetchJson } = fakeService(1_000_000);
    const rows: unknown[] = [];
    for await (const f of fetchAddressFeatures({
      countyName: "Travis",
      fetchJson,
      rateMs: 0,
      limit: 50,
    })) {
      rows.push(f);
    }
    expect(rows).toHaveLength(50);
  });

  it("targets the verified StratMap address-points layer", () => {
    expect(addressLayerUrl()).toBe(
      "https://feature.geographic.texas.gov/arcgis/rest/services/" +
        "Address_Points/stratmap_address_points_48_most_recent/MapServer/0",
    );
  });
});

describe("address county routing", () => {
  it("resolves a known fips and name", () => {
    expect(resolveAddressCounty("48453")?.name).toBe("Travis");
    expect(resolveAddressCounty("hays")?.fips).toBe("48209");
    expect(resolveAddressCounty("Comal")?.fips).toBe("48091");
  });

  it("returns undefined for an unknown county", () => {
    expect(resolveAddressCounty("99999")).toBeUndefined();
  });
});
