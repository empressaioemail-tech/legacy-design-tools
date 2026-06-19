import { describe, it, expect } from "vitest";
import {
  tileKey,
  normalizeAddrKey,
  getTileCacheTtlMs,
  getGeocodeCacheTtlMs,
  getPropertyAttrCacheTtlMs,
  getTileGridDeg,
  DEFAULT_TILE_CACHE_TTL_MS,
  DEFAULT_GEOCODE_CACHE_TTL_MS,
  DEFAULT_PROPERTY_ATTR_CACHE_TTL_MS,
  DEFAULT_TILE_GRID_DEG,
  type TileBbox,
} from "../brokerageGisCache";

describe("tileKey — snapped grid coalescing", () => {
  const grid = 0.02;
  const bboxA: TileBbox = {
    westLng: -97.327,
    southLat: 30.101,
    eastLng: -97.313,
    northLat: 30.118,
  };
  // A small pan that stays inside the same grid cells.
  const bboxNudged: TileBbox = {
    westLng: -97.325,
    southLat: 30.103,
    eastLng: -97.312,
    northLat: 30.119,
  };

  it("snaps two overlapping viewports in the same cell to the same key", () => {
    expect(tileKey("parcels", bboxA, grid)).toBe(
      tileKey("parcels", bboxNudged, grid),
    );
  });

  it("keys distinct cells differently", () => {
    const far: TileBbox = {
      westLng: -97.05,
      southLat: 30.5,
      eastLng: -97.03,
      northLat: 30.52,
    };
    expect(tileKey("parcels", bboxA, grid)).not.toBe(
      tileKey("parcels", far, grid),
    );
  });

  it("namespaces by layer", () => {
    expect(tileKey("parcels", bboxA, grid)).not.toBe(
      tileKey("fema", bboxA, grid),
    );
  });

  it("is byte-stable (fixed precision, deterministic)", () => {
    expect(tileKey("parcels", bboxA, grid)).toBe(
      tileKey("parcels", bboxA, grid),
    );
    expect(tileKey("parcels", bboxA, grid)).toMatch(
      /^parcels:g0\.02:-?\d+\.\d{5},-?\d+\.\d{5},-?\d+\.\d{5},-?\d+\.\d{5}$/,
    );
  });

  it("snaps down (floor), not round, so the cell corner is stable", () => {
    // -97.327 / 0.02 = -4866.35 -> floor -4867 -> * 0.02 = -97.34
    expect(tileKey("parcels", bboxA, grid)).toContain("-97.34000,30.10000");
  });
});

describe("normalizeAddrKey", () => {
  it("lowercases, trims, collapses whitespace, uppercases state", () => {
    expect(normalizeAddrKey("  251  Cool Water Dr ", "Bastrop", "tx")).toBe(
      "251 cool water dr|bastrop|TX",
    );
  });

  it("coalesces case/whitespace variants of the same address", () => {
    expect(normalizeAddrKey("251 Cool Water Dr", "Bastrop", "TX")).toBe(
      normalizeAddrKey("251 COOL WATER DR", "bastrop", "tx"),
    );
  });
});

describe("TTL resolvers", () => {
  it("fall back to defaults on undefined/empty/garbage/negative", () => {
    expect(getTileCacheTtlMs(undefined)).toBe(DEFAULT_TILE_CACHE_TTL_MS);
    expect(getTileCacheTtlMs("")).toBe(DEFAULT_TILE_CACHE_TTL_MS);
    expect(getTileCacheTtlMs("abc")).toBe(DEFAULT_TILE_CACHE_TTL_MS);
    expect(getTileCacheTtlMs("-5")).toBe(DEFAULT_TILE_CACHE_TTL_MS);
    expect(getGeocodeCacheTtlMs(undefined)).toBe(DEFAULT_GEOCODE_CACHE_TTL_MS);
    expect(getPropertyAttrCacheTtlMs(undefined)).toBe(
      DEFAULT_PROPERTY_ATTR_CACHE_TTL_MS,
    );
  });

  it("honor an explicit value, and 0 (disabled)", () => {
    expect(getTileCacheTtlMs("60000")).toBe(60000);
    expect(getTileCacheTtlMs("0")).toBe(0);
  });
});

describe("getTileGridDeg", () => {
  it("falls back to the default on garbage / non-positive", () => {
    expect(getTileGridDeg(undefined)).toBe(DEFAULT_TILE_GRID_DEG);
    expect(getTileGridDeg("0")).toBe(DEFAULT_TILE_GRID_DEG);
    expect(getTileGridDeg("-1")).toBe(DEFAULT_TILE_GRID_DEG);
    expect(getTileGridDeg("abc")).toBe(DEFAULT_TILE_GRID_DEG);
  });

  it("honors an explicit positive grid", () => {
    expect(getTileGridDeg("0.05")).toBe(0.05);
  });
});
