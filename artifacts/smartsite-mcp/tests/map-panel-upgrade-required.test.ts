/**
 * find_parcel map panel: a plan refusal is said as a plan refusal.
 *
 * Measured live 2026-11-05 (correlation ids 06e1f3e6-... at 03:46Z and
 * 65c3f816-... at 05:45Z): find_parcel("48021:34105") returned the hit with
 * mapWiring "failed" and "The parcel list could not be loaded for the map
 * panel." The map wire POSTs /property-explorer/v1/research/brief, which is
 * behind requirePePaidOrPropertyUnlocked; for that caller the same read via
 * get_smart_site returned refused upgrade_required. fetchNodeBriefWire
 * flattened that declared 402 into map_wiring_failed, so a plan limit read
 * as a load failure.
 *
 * FALSIFIER: on main the 402 upgrade_required body yields map_wiring_failed.
 * Controls: any other non-OK still says map_wiring_failed and now carries the
 * HTTP status; a 402 without the upgrade_required error is not a plan refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCortexFetch = vi.fn();
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => ({ baseUrl: "http://cortex.test", serviceApiKey: "k" }),
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const { wireFindParcelForMap } = await import("../src/map-tool-wire.js");
const { mapGroundReasonWords } = await import("../src/map-reason-words.js");

const config = { baseUrl: "http://cortex.test", serviceApiKey: "k" };
const findBody = JSON.stringify({
  hits: [{ parcelNodeId: "48021:34105", situsAddress: "902 CHESTNUT ST", countyFips: "48021", source: "parcel-node-id" }],
});

function respond(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function wire(): Promise<Record<string, unknown>> {
  const text = await wireFindParcelForMap(config, "u_test", findBody, false);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  mockCortexFetch.mockReset();
  vi.stubEnv("SMARTSITE_MAP_WIRE", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("find_parcel map panel: plan refusal is not a load failure", () => {
  it("FALSIFIER: a 402 upgrade_required brief says the plan limit, mapWiring refused", async () => {
    mockCortexFetch.mockResolvedValue(
      respond({ error: "upgrade_required", message: "Unlock this property or go Pro to run this report", tier: "free" }, 402),
    );
    const out = await wire();
    expect(out.mapPanelReason).toBe("map_upgrade_required");
    expect(out.mapWiring).toBe("refused");
    expect(out.mapPanelNote).toBe(mapGroundReasonWords("map_upgrade_required"));
    expect(String(out.mapPanelNote)).toMatch(/plan/);
    expect(out).not.toHaveProperty("mapPanelHttpStatus");
    // The hit itself is still served.
    expect(out.hits).toHaveLength(1);
  });

  it("control: a 500 still says could not be loaded, and names the status", async () => {
    mockCortexFetch.mockResolvedValue(respond({ error: "internal" }, 500));
    const out = await wire();
    expect(out.mapPanelReason).toBe("map_wiring_failed");
    expect(out.mapWiring).toBe("failed");
    expect(out.mapPanelHttpStatus).toBe(500);
  });

  it("control: a 402 without the upgrade_required error is not a plan refusal", async () => {
    mockCortexFetch.mockResolvedValue(respond({ error: "payment_failed" }, 402));
    const out = await wire();
    expect(out.mapPanelReason).toBe("map_wiring_failed");
    expect(out.mapPanelHttpStatus).toBe(402);
  });
});
