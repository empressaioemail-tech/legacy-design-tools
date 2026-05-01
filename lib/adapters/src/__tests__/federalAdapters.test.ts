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
