/**
 * POST /property-explorer/v1/internal/live-easement-gis/check — read-only diagnostic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

vi.mock("../../lib/gateFrontSeam", () => ({
  buildGateServiceAuth: () => ({ tenantId: "tenant-under-test" }),
}));

const { __resetServiceApiKeyCacheForTests } = await import("../../lib/serviceToken");
const { default: router, LIVE_EASEMENT_CHECK_MAX_VERTICES } = await import("../liveEasementGisCheck");

const KEY = "check-test-key";
const PATH = "/api/property-explorer/v1/internal/live-easement-gis/check";
const polygon = { type: "Polygon", coordinates: [[[-97.32, 30.11], [-97.319, 30.11], [-97.319, 30.109], [-97.32, 30.109], [-97.32, 30.11]]] };

function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", router);
  return app;
}

describe("live easement check route", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env["SERVICE_API_KEY"] = KEY;
    __resetServiceApiKeyCacheForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses without the service token", async () => {
    const res = await request(buildApp()).post(PATH).send({ countyFips: "48021", parcelKey: "48021:1", geometry: polygon });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a parcel polygon", async () => {
    const res = await request(buildApp()).post(PATH).set("Authorization", `Bearer ${KEY}`).send({ countyFips: "48021", parcelKey: "48021:1", geometry: { type: "Point", coordinates: [0, 0] } });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a polygon larger than a parcel", async () => {
    const ring = Array.from({ length: LIVE_EASEMENT_CHECK_MAX_VERTICES + 1 }, (_, i) => [-97 + i * 1e-7, 30]);
    ring.push(ring[0]!);
    const res = await request(buildApp()).post(PATH).set("Authorization", `Bearer ${KEY}`).send({ countyFips: "48021", parcelKey: "48021:1", geometry: { type: "Polygon", coordinates: [ring] } });
    expect(res.status).toBe(413);
  });

  it("answers layer statuses, feature ids and recording refs only, querying the fixed layer list", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ features: [{ id: 92, properties: { DocumentNo: 202501954, Status: "WASTEWATER EASEMENT" } }, { id: 93, properties: { DocumentNo: 202501807 } }] }),
    });
    const res = await request(buildApp()).post(PATH).set("Authorization", `Bearer ${KEY}`).send({ countyFips: "48021", parcelKey: "48021:38368", geometry: polygon });
    expect(res.status).toBe(200);
    const bastrop = res.body.layers.find((l: { sourceLayerId: string }) => l.sourceLayerId === "bastrop-city-easements");
    expect(bastrop).toEqual({ sourceLayerId: "bastrop-city-easements", featureCount: 2, featureIds: [92, 93], pages: 1 });
    expect(res.body.hits).toEqual([{ sourceLayerId: "bastrop-city-easements", featureIds: [92, 93], recordingRefs: ["202501954", "202501807"] }]);
    expect(JSON.stringify(res.body)).not.toContain("geometry");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Easements_/FeatureServer/43/query");
  });
});
