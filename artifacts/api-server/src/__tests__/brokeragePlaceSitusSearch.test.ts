/**
 * Route test for GET /api/brokerage/v1/place/situs-search (router only).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { brokeragePlaceSitusSearchRouter } from "../routes/brokeragePlaceSitusSearch";
import type {
  PlaceSearchResult,
  SitusSearchHit,
} from "../lib/txgioAddressResolve";

const { searchMock, lookupMock } = vi.hoisted(() => ({
  searchMock: vi.fn(
    async (_input: { query: string; limit?: number }): Promise<PlaceSearchResult> => ({
      hits: [
        {
          parcelNodeId: "48209:193340",
          situsAddress: "6026 MARSH LN, BUDA, TX 78610",
          countyFips: "48209",
          source: "parcel-situs",
        },
      ],
    }),
  ),
  lookupMock: vi.fn(
    async (_input: { parcelNodeId: string }): Promise<SitusSearchHit | null> =>
      null,
  ),
}));

vi.mock("../lib/txgioAddressResolve", () => ({
  searchPlaceByPrefix: (input: { query: string; limit?: number }) =>
    searchMock(input),
  lookupSitusByParcelNodeId: (input: { parcelNodeId: string }) =>
    lookupMock(input),
}));

function buildApp() {
  const app = express();
  app.use("/api/brokerage/v1/place", brokeragePlaceSitusSearchRouter);
  return app;
}

describe("GET /api/brokerage/v1/place/situs-search", () => {
  beforeEach(() => {
    searchMock.mockClear();
    lookupMock.mockClear();
    lookupMock.mockResolvedValue(null);
  });

  it("returns situs hits", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "6026 Marsh", limit: 5 });

    expect(res.status).toBe(200);
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].parcelNodeId).toBe("48209:193340");
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "6026 Marsh", limit: 5 }),
    );
  });

  it("400s when q is missing", async () => {
    const res = await request(buildApp()).get(
      "/api/brokerage/v1/place/situs-search",
    );

    expect(res.status).toBe(400);
  });

  it("400s when limit is out of range", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "6026 Marsh", limit: 99 });

    expect(res.status).toBe(400);
  });

  it("returns situs when q is a parcel node id with a store row", async () => {
    lookupMock.mockResolvedValueOnce({
      parcelNodeId: "48021:34137",
      situsAddress: "123 MAIN ST, BASTROP, TX 78602",
      countyFips: "48021",
    });

    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "48021:34137" });

    expect(res.status).toBe(200);
    expect(res.body.hits).toEqual([
      {
        parcelNodeId: "48021:34137",
        situsAddress: "123 MAIN ST, BASTROP, TX 78602",
        countyFips: "48021",
        source: "parcel-node-id",
      },
    ]);
    expect(lookupMock).toHaveBeenCalledWith({ parcelNodeId: "48021:34137" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns node id only when q is a parcel node id without situs", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "48021:34137" });

    expect(res.status).toBe(200);
    expect(res.body.hits).toEqual([
      { parcelNodeId: "48021:34137", source: "parcel-node-id" },
    ]);
    expect(lookupMock).toHaveBeenCalledWith({ parcelNodeId: "48021:34137" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("completed empty carries missClass no-hit", async () => {
    searchMock.mockResolvedValueOnce({ hits: [], missClass: "no-hit" });
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "zzzz-not-a-situs-99999" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hits: [], missClass: "no-hit" });
  });

  it("budget empty carries missClass situs-search-budget-exceeded", async () => {
    searchMock.mockResolvedValueOnce({
      hits: [],
      missClass: "situs-search-budget-exceeded",
    });
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "908 Pine, Bastrop TX" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hits: [],
      missClass: "situs-search-budget-exceeded",
    });
    expect(res.body.missClass).not.toBe("no-hit");
  });

  it("out-of-coverage empty carries missClass out_of_coverage plus outOfCoverageState (P-107 / OPS-16 A-072)", async () => {
    searchMock.mockResolvedValueOnce({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "1600 E Camelback Rd, Phoenix, AZ" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
    expect(res.body.missClass).not.toBe("no-hit");
  });

  it("does not attach outOfCoverageState to a plain no-hit (no cross-contamination)", async () => {
    searchMock.mockResolvedValueOnce({ hits: [], missClass: "no-hit" });
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/situs-search")
      .query({ q: "zzzz-not-a-situs-99999" });

    expect(res.body).toEqual({ hits: [], missClass: "no-hit" });
    expect(res.body).not.toHaveProperty("outOfCoverageState");
  });
});
