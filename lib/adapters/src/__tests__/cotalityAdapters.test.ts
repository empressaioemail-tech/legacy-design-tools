/**
 * Cotality national parcel + zoning adapter pair — 2026-06-06 decision.
 *
 * Mirrors the Regrid SCOPE B test coverage. When COTALITY_API_KEY is absent
 * the adapters surface no-coverage (clean fallback; no upstream call, no
 * errors propagated to callers). When present they exercise the live path
 * (or stub) and emit the same payload.parcel / payload.zoning GeoJSON Feature
 * shape so overlays.ts and the briefing engine are unchanged.
 *
 * Fixture uses a realistic trial-tier shaped response (CLIP + attributes +
 * geometry in a common vendor form) that the adapter must normalize.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cotalityParcelsAdapter,
  cotalityZoningAdapter,
  __resetCotalityDedupForTests,
} from "../national/cotality";
import { runAdapters } from "../runner";
import { FEDERAL_ADAPTERS, ALL_ADAPTERS } from "../registry";
import type { AdapterContext } from "../types";

/** Stable Round Rock-ish lat/lng (the dispatch test address). */
const ROUND_ROCK: AdapterContext = {
  parcel: { latitude: 30.5083, longitude: -97.6789, address: "1904 Heathwood Cir, Round Rock, TX 78664" },
  jurisdiction: { stateKey: "texas", localKey: null },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stand-in for a Cotality Property Characteristics / parcel point response
 * as expected from the 30-day developer-portal trial (post 2026-06-06 decision).
 * The adapter must defensively pull CLIP, geometry (here nested under parcel),
 * zoning (flattened or block), and a vintage/refresh signal.
 */
function cotalityResponseFixture(opts: {
  withParcel?: boolean;
  withZoning?: boolean;
  clip?: string | number;
  county?: string;
} = {}): Record<string, unknown> {
  const { withParcel = true, withZoning = true, clip = 9876543210, county = "Williamson" } = opts;

  const parcelBlock: Record<string, unknown> = withParcel
    ? {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-97.6791, 30.5081],
              [-97.6787, 30.5081],
              [-97.6787, 30.5085],
              [-97.6791, 30.5085],
              [-97.6791, 30.5081],
            ],
          ],
        },
        attributes: {
          apn: "R-16-1234-5678-90",
          owner: "Test Owner LLC",
          county,
          // zoning may appear flattened on the parcel record in some trial shapes
          zoning: withZoning ? "R-1" : undefined,
          zoning_description: withZoning ? "Single-Family Residential" : undefined,
        },
      }
    : { geometry: null, attributes: {} };

  const zoningBlock: Record<string, unknown> | undefined = withZoning
    ? {
        code: "R-1",
        description: "Single-Family Residential",
        zoningType: "residential",
      }
    : undefined;

  const out: Record<string, unknown> = {
    clip,
    parcel: parcelBlock,
    vintage: "2026-03-15",
    county,
  };
  if (zoningBlock) out.zoning = zoningBlock;
  return out;
}

describe("Cotality adapters — 2026-06-06 decision scaffold", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.COTALITY_API_KEY;
    __resetCotalityDedupForTests();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.COTALITY_API_KEY;
    } else {
      process.env.COTALITY_API_KEY = originalApiKey;
    }
    __resetCotalityDedupForTests();
  });

  it("[1] happy path — both adapters emit ok from a single upstream call (key present)", async () => {
    process.env.COTALITY_API_KEY = "trial-cotality-key-30day";
    const fetchImpl = vi.fn(async () => jsonResponse(cotalityResponseFixture()));
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("ok");
    expect(byKey["cotality:zoning"]?.status).toBe("ok");

    const p = byKey["cotality:parcels"]?.result;
    expect(p?.tier).toBe("federal");
    expect(p?.sourceKind).toBe("national-aggregator");
    expect(p?.layerKind).toBe("cotality-parcel");
    expect(p?.provider).toContain("Cotality");
    expect(p?.snapshotDate).toMatch(/^2026-03-15/);
    const parcelPayload = p?.payload as { kind: string; parcel: { type: string; geometry: { type: string } } };
    expect(parcelPayload?.kind).toBe("parcel");
    expect(parcelPayload?.parcel?.type).toBe("Feature");
    expect(parcelPayload?.parcel?.geometry?.type).toBe("Polygon");
    // CLIP carried through
    expect((parcelPayload?.parcel?.properties as any)?.clip).toBe(9876543210);

    const z = byKey["cotality:zoning"]?.result;
    const zoningPayload = z?.payload as { kind: string; zoning: { type: string } };
    expect(zoningPayload?.kind).toBe("zoning");
    expect(zoningPayload?.zoning?.type).toBe("Feature");

    // One upstream despite two adapters (in-mem dedup)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("propertycharacteristics");
    expect(calledUrl).toContain("lat=30.5083");
    expect(calledUrl).toContain("lon=-97.6789");
    expect(calledUrl).toContain("apikey=trial-cotality-key-30day");
  });

  it("[2] zoning absent on response — parcel ok, zoning no-coverage (key present)", async () => {
    process.env.COTALITY_API_KEY = "trial-cotality-key-30day";
    const fetchImpl = vi.fn(async () =>
      jsonResponse(cotalityResponseFixture({ withZoning: false })),
    );
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("ok");
    expect(byKey["cotality:zoning"]?.status).toBe("no-coverage");
    expect(byKey["cotality:zoning"]?.error?.code).toBe("no-coverage");
  });

  it("[3] missing COTALITY_API_KEY — both adapters surface no-coverage (no upstream call)", async () => {
    delete process.env.COTALITY_API_KEY;
    const fetchImpl = vi.fn(async () => jsonResponse(cotalityResponseFixture()));
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("no-coverage");
    expect(byKey["cotality:parcels"]?.error?.message).toMatch(/COTALITY_API_KEY/i);
    expect(byKey["cotality:zoning"]?.status).toBe("no-coverage");
    // No network when key absent (clean fallback; Regrid supplies data)
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[4] HTTP 5xx — surfaces as upstream-error", async () => {
    process.env.COTALITY_API_KEY = "trial-cotality-key-30day";
    const fetchImpl = vi.fn(async () =>
      new Response("Service Unavailable", { status: 503, headers: { "content-type": "text/plain" } }),
    );
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("upstream-error");
    expect(outcomes[0]?.error?.message).toContain("HTTP 503");
  });

  it("[5] malformed JSON — parse-error", async () => {
    process.env.COTALITY_API_KEY = "trial-cotality-key-30day";
    const fetchImpl = vi.fn(async () =>
      new Response("<not-json>", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("parse-error");
  });

  it("[6] cache hit — second call within TTL skips upstream", async () => {
    process.env.COTALITY_API_KEY = "trial-cotality-key-30day";
    const fetchImpl = vi.fn(async () => jsonResponse(cotalityResponseFixture()));
    const first = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(first.every((o) => o.status === "ok")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(second.every((o) => o.status === "ok")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[7] registry shape — cotality adapters present in FEDERAL and ALL", () => {
    const keys = ALL_ADAPTERS.map((a) => a.adapterKey);
    expect(keys).toContain("cotality:parcels");
    expect(keys).toContain("cotality:zoning");
    const fed = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
    expect(fed).toContain("cotality:parcels");
    expect(fed).toContain("cotality:zoning");
  });

  it("[8] 401 on mounted key — upstream-error (diagnostics)", async () => {
    process.env.COTALITY_API_KEY = "trial-cotality-key-30day";
    const fetchImpl = vi.fn(async () =>
      new Response("Unauthorized trial key", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("upstream-error");
    expect(outcomes[0]?.error?.message).toMatch(/401|Unauthorized|entitlement/i);
  });
});
