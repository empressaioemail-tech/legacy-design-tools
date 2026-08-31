import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { brokeragePlaceStreetSearchRouter } from "../routes/brokeragePlaceStreetSearch";
import type { StreetSearchResult } from "../lib/txgioStreetSearch";

const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(
    async (): Promise<StreetSearchResult> => ({
      hits: [],
      cap: 50,
      received: 0,
      truncated: false,
    }),
  ),
}));

vi.mock("../lib/txgioStreetSearch", () => ({
  STREET_SEARCH_CAP: 50,
  searchParcelsByBareStreet: (input: unknown) => searchMock(input),
}));

function buildApp() {
  const app = express();
  app.use("/api/brokerage/v1/place", brokeragePlaceStreetSearchRouter);
  return app;
}

describe("GET /api/brokerage/v1/place/street-search", () => {
  beforeEach(() => {
    searchMock.mockClear();
    searchMock.mockResolvedValue({
      hits: [
        {
          parcelNodeId: "48021:34137",
          situsAddress: "908 PINE , BASTROP, TX 78602",
          countyFips: "48021",
        },
      ],
      cap: 50,
      received: 1,
      truncated: false,
    });
  });

  it("returns hits with declared truncation fields", async () => {
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/street-search")
      .query({ q: "Pine St, Bastrop, TX" });

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.cap).toBe(50);
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Pine St, Bastrop, TX" }),
    );
  });

  it("422s an unbounded refuse", async () => {
    searchMock.mockResolvedValue({
      refused: true,
      code: "bare_street_unbounded",
      reason: "Bare street search requires a city, ZIP, or countyFips.",
    });
    const res = await request(buildApp())
      .get("/api/brokerage/v1/place/street-search")
      .query({ q: "Pine St" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("bare_street_unbounded");
  });
});
