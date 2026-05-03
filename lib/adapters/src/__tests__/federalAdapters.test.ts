/**
 * Federal site-context adapters — DA-PI-2.
 *
 * Each adapter is exercised against a recorded fixture so the network
 * is never touched. The runner is invoked end-to-end so the gating,
 * timeout, and `AdapterRunError` translation paths are covered too.
 */

import { describe, expect, it, vi } from "vitest";
import { femaNfhlAdapter } from "../federal/fema-nfhl";
import { usgsNedAdapter } from "../federal/usgs-ned";
import { epaEjscreenAdapter } from "../federal/epa-ejscreen";
import { fccBroadbandAdapter } from "../federal/fcc-broadband";
import { runAdapters } from "../runner";
import {
  arcgisEmpty,
  jsonResponse,
} from "../__fixtures__/arcgisFixtures";
import {
  epqsElevationFeet,
  epqsNoData,
  epqsStringValue,
  ejscreenBlockGroup,
  ejscreenEmpty,
  fccBroadbandFeatures,
  femaNfhlFeature,
} from "../__fixtures__/federalFixtures";
import type { AdapterContext } from "../types";

const moab: AdapterContext = {
  parcel: { latitude: 38.5733, longitude: -109.5498 },
  jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
};
const bastrop: AdapterContext = {
  parcel: { latitude: 30.1105, longitude: -97.3186 },
  jurisdiction: { stateKey: "texas", localKey: "bastrop-tx" },
};
const offPilot: AdapterContext = {
  parcel: { latitude: 40.0, longitude: -105.27 }, // Boulder, CO
  jurisdiction: { stateKey: null, localKey: null },
};

describe("FEMA NFHL flood-zone adapter", () => {
  it("returns inSpecialFloodHazardArea=true with the FEMA flood zone for an in-floodplain parcel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(femaNfhlFeature));
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      inSpecialFloodHazardArea: boolean;
      floodZone: string | null;
    };
    expect(payload.kind).toBe("flood-zone");
    expect(payload.inSpecialFloodHazardArea).toBe(true);
    expect(payload.floodZone).toBe("AE");
    expect(outcomes[0].result?.tier).toBe("federal");
    expect(outcomes[0].result?.sourceKind).toBe("federal-adapter");
  });

  it("emits an out-of-floodplain row (rather than no-coverage) when the layer returns no features", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      inSpecialFloodHazardArea: boolean;
      floodZone: string | null;
    };
    expect(payload.inSpecialFloodHazardArea).toBe(false);
    expect(payload.floodZone).toBeNull();
    // The note attribution lets the briefing engine surface "no
    // floodplain risk" against a cited source rather than a blank.
    expect(outcomes[0].result?.note).toMatch(/Zone X/i);
  });

  it("does not run when the engagement has no resolved pilot state", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...offPilot, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("getUpstreamFreshness (Task #227)", () => {
    /**
     * The FEMA NFHL freshness probe GETs the layer's MapServer
     * metadata (`?f=json`) and compares `editingInfo.lastEditDate`
     * (Unix epoch ms) against the cached row's write time.
     */
    const cachedAt = new Date("2026-04-30T00:00:00.000Z");

    it("returns `fresh` when FEMA's lastEditDate is older than the cached row", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          editingInfo: {
            // Edited 10 days before the cache row was written.
            lastEditDate: cachedAt.getTime() - 10 * 86_400_000,
          },
        }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("fresh");
      expect(fetchImpl).toHaveBeenCalledOnce();
      // The probe hits the layer's metadata endpoint (no `/query`).
      expect(fetchImpl.mock.calls[0][0]).toMatch(/MapServer\/28\?f=json$/);
    });

    it("returns `stale` when FEMA published a newer revision after the cache row was written", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          editingInfo: {
            // Edited 1 day after the cache row was written.
            lastEditDate: cachedAt.getTime() + 86_400_000,
          },
        }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("stale");
      expect(verdict.reason).toMatch(/FEMA published a NFHL revision/);
      // The reason includes both the upstream edit timestamp and
      // the cached row's write time so the FE tooltip can show
      // both without parsing the message back apart.
      expect(verdict.reason).toContain(cachedAt.toISOString());
    });

    it("returns `unknown` when the metadata endpoint responds with HTTP 5xx", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("oops", { status: 503 }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toMatch(/HTTP 503/);
    });

    it("treats a missing `editingInfo.lastEditDate` as `fresh` rather than unknown", async () => {
      // ArcGIS only stamps lastEditDate on layers that have been
      // edited at least once — absence means the layer has never
      // changed, which is the strongest possible "still fresh".
      const fetchImpl = vi.fn(async () => jsonResponse({}));
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("fresh");
    });

    it("returns `unknown` when `lastEditDate` is present but malformed (contract drift)", async () => {
      // If FEMA ever changes the shape (e.g. strings instead of epoch
      // numbers), we shouldn't silently call it "fresh" — that would
      // mask real upstream changes. Surface as `unknown` so the FE
      // pill stays neutral instead of falsely confident.
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ editingInfo: { lastEditDate: "2026-05-01" } }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toMatch(/non-numeric lastEditDate/);
    });

    it("returns `unknown` when fetch throws (network error)", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ENOTFOUND hazards.fema.gov");
      });
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toContain("ENOTFOUND");
    });
  });
});

describe("USGS NED elevation adapter", () => {
  it("normalizes a numeric EPQS elevation into the payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(epqsElevationFeet));
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      elevationFeet: number | null;
      units: string;
    };
    expect(payload.kind).toBe("elevation-point");
    expect(payload.elevationFeet).toBeCloseTo(4032.7, 1);
    expect(payload.units).toBe("Feet");
    expect(outcomes[0].result?.tier).toBe("federal");
  });

  it("sends only the EPQS-supported query params (no wkid / includeDate)", async () => {
    // EPQS v1 rejects `wkid` / `includeDate` with HTTP 400.
    const fetchImpl = vi.fn(async () => jsonResponse(epqsElevationFeet));
    await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toMatch(/[?&]x=-109\.5498\b/);
    expect(calledUrl).toMatch(/[?&]y=38\.5733\b/);
    expect(calledUrl).toMatch(/[?&]units=Feet\b/);
    expect(calledUrl).toMatch(/[?&]output=json\b/);
    expect(calledUrl).not.toMatch(/[?&]wkid=/);
    expect(calledUrl).not.toMatch(/[?&]includeDate=/);
  });

  it("translates a deterministic HTTP 400 into an `upstream-error` failed outcome (no retry)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "invalid URL" }, 400),
    );
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("upstream-error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts the legacy stringified `value` shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(epqsStringValue));
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      elevationFeet: number | null;
    };
    expect(payload.elevationFeet).toBeCloseTo(1284.5, 1);
  });

  it("normalizes the EPQS no-data sentinel to a null elevation with a note", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(epqsNoData));
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      elevationFeet: number | null;
    };
    expect(payload.elevationFeet).toBeNull();
    expect(outcomes[0].result?.note).toMatch(/no elevation/i);
  });

  it("translates an HTTP 5xx to an upstream-error failed outcome", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "boom" }, 503),
    );
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("upstream-error");
  });
});

describe("EPA EJScreen adapter", () => {
  it("emits the normalized block-group indicators alongside the raw envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      population: number | null;
      pm25Percentile: number | null;
      raw: Record<string, unknown>;
    };
    expect(payload.kind).toBe("ejscreen-blockgroup");
    expect(payload.population).toBe(1234);
    expect(payload.pm25Percentile).toBeCloseTo(72, 0);
    expect(payload.raw).toBeDefined();
  });

  it("treats an empty `data.main` envelope as no-coverage", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenEmpty));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.code).toBe("no-coverage");
  });

  it("translates a broker error envelope into an upstream-error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "geometry out of bounds" }),
    );
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("upstream-error");
    expect(outcomes[0].error?.message).toMatch(/geometry/);
  });

  it("targets the broker3 endpoint (legacy `.aspx` deprecated 2023)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...bastrop, fetchImpl },
    });
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toContain("ejscreenRESTbroker3.aspx");
  });

  it("retries a transient HTTP 503 from the broker before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("FCC broadband adapter", () => {
  it("rolls up provider rows into a fastest-tier summary", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fccBroadbandFeatures));
    const outcomes = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      providerCount: number;
      fastestDownstreamMbps: number | null;
      fastestUpstreamMbps: number | null;
      providers: Array<{ provider: string | null }>;
    };
    expect(payload.kind).toBe("broadband-availability");
    expect(payload.providerCount).toBe(2);
    expect(payload.fastestDownstreamMbps).toBe(1000);
    expect(payload.fastestUpstreamMbps).toBe(35);
    expect(payload.providers.map((p) => p.provider).sort()).toEqual([
      "FastNet",
      "RuralWisp",
    ]);
  });

  it("emits a zero-providers row (rather than no-coverage) when FCC has no deployment", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      providerCount: number;
      fastestDownstreamMbps: number | null;
    };
    expect(payload.providerCount).toBe(0);
    expect(payload.fastestDownstreamMbps).toBeNull();
    expect(outcomes[0].result?.note).toMatch(/no fixed-broadband/i);
  });

  it("hits the BDC v2 location/availability endpoint with lat+lng", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fccBroadbandFeatures));
    await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toContain("broadbandmap.fcc.gov");
    expect(calledUrl).toContain("/published/location/availability");
    expect(calledUrl).toMatch(/[?&]lat=38\.5733\b/);
    expect(calledUrl).toMatch(/[?&]lng=-109\.5498\b/);
    // The old broken path produced `/feature/0/query`; guard against
    // any regression that brings it back.
    expect(calledUrl).not.toContain("/feature/0/query");
  });

  it("retries an FCC HTTP 502 once before succeeding on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse(fccBroadbandFeatures));
    const outcomes = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("federal adapter gating", () => {
  it("skips every federal adapter when the engagement has no resolved pilot state", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [
        femaNfhlAdapter,
        usgsNedAdapter,
        epaEjscreenAdapter,
        fccBroadbandAdapter,
      ],
      context: { ...offPilot, fetchImpl },
    });
    expect(outcomes.every((o) => o.status === "no-coverage")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
