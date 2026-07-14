/**
 * Hydrology spine routing — EngineEnvelope unwrap regression tests.
 *
 * engine-api seals every /v1 response in `{ payload, confidence,
 * dataVintage, coverage, source }`. These routes previously read result
 * fields off the raw body, so every field came back `undefined`, the
 * drainage ingest returned upstream-error on every run, and the tile
 * showed "not-run" ("ensure the parcel is geocoded") forever.
 *
 * The mocked envelope bodies below mirror verbatim live engine-api
 * responses captured 2026-07-14 against
 * https://hauska-engine-api-h7gvu7rgcq-uc.a.run.app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// engine-spine-test-setup.ts mocks this module globally (offline seam for
// integration tests); these tests exercise the REAL spine routing, so undo
// the suite-wide mock for this file.
vi.unmock("../engineSpineHydrology");

// engineSpineClient imports gateFrontSeam → userProfiles → @workspace/db,
// and @workspace/engine-core's partition module also imports the db —
// both demand DATABASE_URL at import time. These are pure HTTP-unwrap
// unit tests that never run a query; satisfy the import-time guard with
// a placeholder (pg pools connect lazily) and stub the seam.
vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgres://unused:unused@localhost:5432/unused";
});
vi.mock("../gateFrontSeam", () => ({
  resolveRequestJurisdictionTenant: () => null,
}));

import {
  routeFetchUsgs3depDem,
  routeResolveRainfallForcing,
  routeRunHydrologyWorker,
} from "../engineSpineHydrology";

const ctx = { jurisdictionTenant: null };

function envelope(payload: unknown, coverage?: { degraded: boolean; reason?: string }) {
  return {
    payload,
    confidence: { value: 1, kind: "deterministic" },
    dataVintage: null,
    coverage: coverage ?? { degraded: false },
    source: { adapter: "hydrology:test" },
  };
}

function stubFetchJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

const emptyFc = { type: "FeatureCollection", features: [] };

const okWorkerPayload = {
  status: "ok",
  library: "native-d8",
  libraryVersion: "1.0.0",
  routing: "d8",
  accumulationThreshold: 50,
  drainageZonesGeoJson: emptyFc,
  flowLinesGeoJson: emptyFc,
  rainfallResultGeoJson: null,
  pourPoint: { lng: -97.92817, lat: 29.87408 },
  fallbackUsed: true,
  fallbackReason: "pysheds worker exceeded 45000ms",
};

const workerRequest = {
  demBytes: new ArrayBuffer(8),
  pourLng: -97.92817,
  pourLat: 29.87408,
  catchmentBbox: {
    westLng: -97.932,
    southLat: 29.871,
    eastLng: -97.9245,
    northLat: 29.8772,
  },
  width: 2,
  height: 1,
  elevation: new Float32Array([1, 2]),
};

describe("hydrology spine envelope unwrap", () => {
  beforeEach(() => {
    vi.stubEnv("ENGINE_API_URL", "https://engine-api.test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("routeRunHydrologyWorker unwraps an enveloped ok result (incl. fallback flags)", async () => {
    stubFetchJson(
      envelope(okWorkerPayload, {
        degraded: true,
        reason: "pysheds worker exceeded 45000ms",
      }),
    );
    const result = await routeRunHydrologyWorker(workerRequest, ctx);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.library).toBe("native-d8");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toMatch(/pysheds/);
  });

  it("routeRunHydrologyWorker flattens an enveloped worker error", async () => {
    stubFetchJson(
      envelope(
        {
          status: "error",
          error: {
            status: "error",
            code: "worker-exit",
            message: "python exited 1",
          },
        },
        { degraded: true, reason: "python exited 1" },
      ),
    );
    const result = await routeRunHydrologyWorker(workerRequest, ctx);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.code).toBe("worker-exit");
    expect(result.message).toBe("python exited 1");
  });

  it("routeRunHydrologyWorker still accepts a bare legacy (pre-envelope) body", async () => {
    stubFetchJson(okWorkerPayload);
    const result = await routeRunHydrologyWorker(workerRequest, ctx);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.library).toBe("native-d8");
  });

  it("routeResolveRainfallForcing unwraps an enveloped forcing source", async () => {
    // Shape from a verbatim live response (2026-07-14).
    stubFetchJson(
      envelope({
        kind: "noaa-atlas-14",
        returnPeriodYears: 100,
        depthInches: 4,
        estimate: {
          lat: 29.87408,
          lng: -97.92817,
          source: "noaa-atlas-14-pfds",
          fetchedAt: "2026-07-14T12:23:28.640Z",
          designStorms: [],
          endpoint: "https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py",
        },
      }),
    );
    const forcing = await routeResolveRainfallForcing(
      { lat: 29.87408, lng: -97.92817, useCotalityForcing: false, cotalityForcing: null },
      ctx,
    );
    expect(forcing.kind).toBe("noaa-atlas-14");
    expect(forcing.depthInches).toBe(4);
  });

  it("routeResolveRainfallForcing throws on the engine's degraded empty result", async () => {
    stubFetchJson(
      envelope(
        { status: "empty", message: "Atlas 14 fetch failed" },
        { degraded: true, reason: "rainfall forcing fetch failed" },
      ),
    );
    await expect(
      routeResolveRainfallForcing(
        { lat: 29.87408, lng: -97.92817, useCotalityForcing: false, cotalityForcing: null },
        ctx,
      ),
    ).rejects.toThrow(/no forcing source/);
  });

  it("routeFetchUsgs3depDem unwraps an enveloped DEM response", async () => {
    const demBytes = Buffer.from([1, 2, 3, 4]);
    stubFetchJson(
      envelope({
        widthPx: 2,
        heightPx: 2,
        bbox: workerRequest.catchmentBbox,
        demBytesBase64: demBytes.toString("base64"),
      }),
    );
    const result = await routeFetchUsgs3depDem(
      workerRequest.catchmentBbox,
      { resolutionMeters: 10 },
      ctx,
    );
    expect(result.widthPx).toBe(2);
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("routeFetchUsgs3depDem throws (not undefined-bytes) when payload is missing", async () => {
    stubFetchJson(envelope({ unexpected: true }));
    await expect(
      routeFetchUsgs3depDem(
        workerRequest.catchmentBbox,
        { resolutionMeters: 10 },
        ctx,
      ),
    ).rejects.toThrow(/demBytesBase64/);
  });
});
