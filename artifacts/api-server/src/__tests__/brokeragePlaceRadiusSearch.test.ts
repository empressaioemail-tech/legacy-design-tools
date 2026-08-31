import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { brokeragePlaceRadiusSearchRouter } from "../routes/brokeragePlaceRadiusSearch";
import type { RadiusSearchResult } from "../lib/txgioRadiusSearch";

const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(
    async (): Promise<RadiusSearchResult> => ({
      hits: [],
      cap: 50,
      received: 0,
      truncated: false,
      radiusFt: 500,
    }),
  ),
}));

vi.mock("../lib/txgioRadiusSearch", () => ({
  RADIUS_SEARCH_CAP: 50,
  RADIUS_SEARCH_MAX_FT: 5280,
  searchParcelsByRadius: (input: unknown) => searchMock(input),
}));

function buildApp() {
  const app = express();
  app.use("/api/brokerage/v1/place", brokeragePlaceRadiusSearchRouter);
  return app;
}

describe("GET /api/brokerage/v1/place/radius-search", () => {
  beforeEach(() => {
    searchMock.mockClear();
    searchMock.mockResolvedValue({
      hits: [
        {
          parcelNodeId: "48021:34137",
          situsAddress: "908 PINE , BASTROP, TX 78602",
          countyFips: "48021",
          distanceFt: 0,
        },
      ],
      cap: 50,
      received: 1,
      truncated: false,
      radiusFt: 500,
    });
  });

  it("returns hits with cap, received, truncated", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/radius-search")
      .query({ lat: 30.10981, lng: -97.31654, radiusFt: 500 });

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.cap).toBe(50);
    expect(res.body.received).toBe(1);
    expect(res.body.hits[0].parcelNodeId).toBe("48021:34137");
  });

  it("422s a refused unbounded search", async () => {
    searchMock.mockResolvedValue({
      refused: true,
      code: "radius_unbounded",
      reason: "Candidate set exceeded 2000.",
    });
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/radius-search")
      .query({ lat: 29.76, lng: -95.36, radiusFt: 5280 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("radius_unbounded");
  });

  it("400s when radiusFt is missing", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/radius-search")
      .query({ lat: 30.1, lng: -97.3 });
    expect(res.status).toBe(400);
  });
});
