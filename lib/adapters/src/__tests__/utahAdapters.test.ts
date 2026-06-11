/**
 * P1-3 — UGRC adapter timeout budgets.
 *
 * QA-22 (PR #63) widened the per-adapter timeout floor for known-slow
 * upstreams but only wired it onto EPA / FCC / Grand County — it missed
 * the UGRC (ArcGIS Online) statewide feeds, so `ugrc:dem`,
 * `ugrc:parcels`, and `ugrc:address-points` kept timing out at the 15s
 * runner default. P1-3 brings them onto the same
 * `SLOW_UPSTREAM_TIMEOUT_MS` floor.
 */

import { describe, it, expect, vi } from "vitest";
import {
  utahDemAdapter,
  utahParcelsAdapter,
  utahAddressPointsAdapter,
} from "../state/utah";
import { SLOW_UPSTREAM_TIMEOUT_MS } from "../timeouts";
import { jsonResponse, arcgisFeatureWithGeometry } from "../__fixtures__/arcgisFixtures";
import type { AdapterContext } from "../types";

describe("UGRC adapter timeout budgets (P1-3)", () => {
  it("ugrc:dem carries the widened SLOW_UPSTREAM_TIMEOUT_MS budget", () => {
    expect(utahDemAdapter.timeoutMs).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
  });

  it("ugrc:parcels carries the widened SLOW_UPSTREAM_TIMEOUT_MS budget", () => {
    expect(utahParcelsAdapter.timeoutMs).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
  });

  it("ugrc:address-points carries the widened SLOW_UPSTREAM_TIMEOUT_MS budget", () => {
    expect(utahAddressPointsAdapter.timeoutMs).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
  });

  it("ugrc:parcels requests outSR=4326 so stored parcel geometry is WGS84", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisFeatureWithGeometry));
    const ctx: AdapterContext = {
      parcel: { latitude: 38.5733, longitude: -109.5498 },
      jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
      fetchImpl,
    };
    await utahParcelsAdapter.run(ctx);
    expect(fetchImpl).toHaveBeenCalled();
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toMatch(/[?&]outSR=4326\b/);
  });
});
