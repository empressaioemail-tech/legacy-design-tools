import { describe, expect, it, vi } from "vitest";
import { utahParcelsAdapter, utahDemAdapter } from "../state/utah";
import { idahoParcelsAdapter, idahoDemAdapter } from "../state/idaho";
import {
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
  grandCountyRoadsAdapter,
} from "../local/grand-county-ut";
import {
  lemhiCountyParcelsAdapter,
  lemhiCountyZoningAdapter,
  lemhiCountyRoadsAdapter,
} from "../local/lemhi-county-id";
import { runAdapters } from "../runner";
import {
  arcgisFeatureWithGeometry,
  arcgisFeatureZoning,
  arcgisEmpty,
  jsonResponse,
  osmRoadsResponse,
} from "../__fixtures__/arcgisFixtures";
import type { AdapterContext } from "../types";

const moab: AdapterContext = {
  parcel: { latitude: 38.5733, longitude: -109.5498 },
  jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
};
const salmon: AdapterContext = {
  parcel: { latitude: 45.1755, longitude: -113.8957 },
  jurisdiction: { stateKey: "idaho", localKey: "lemhi-county-id" },
};

/** Generic OK responder used by adapters that just want a feature list. */
function okFetch(body: unknown) {
  return vi.fn(async () => jsonResponse(body));
}

describe("Moab / Grand County UT adapter chain", () => {
  it("emits state-tier UGRC parcels + DEM and local-tier Grand County parcels/zoning at a Moab lat/lng", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("UtahDEM10Meter")) {
        return jsonResponse({ samples: [{ value: 4025.4 }] });
      }
      if (url.includes("/Parcels_") || url.includes("/Cadastre/")) {
        return jsonResponse(arcgisFeatureWithGeometry);
      }
      if (url.includes("Zoning")) {
        return jsonResponse(arcgisFeatureZoning);
      }
      return jsonResponse(arcgisFeatureWithGeometry);
    });

    const outcomes = await runAdapters({
      adapters: [
        utahDemAdapter,
        utahParcelsAdapter,
        grandCountyParcelsAdapter,
        grandCountyZoningAdapter,
      ],
      context: { ...moab, fetchImpl },
    });

    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["ugrc:dem"].status).toBe("ok");
    expect(byKey["ugrc:parcels"].status).toBe("ok");
    expect(byKey["grand-county-ut:parcels"].status).toBe("ok");
    expect(byKey["grand-county-ut:zoning"].status).toBe("ok");

    // Tier metadata is what the UI uses to bucket sources — assert it
    // explicitly so a refactor that drops the field can't ship silently.
    expect(byKey["ugrc:dem"].result?.tier).toBe("state");
    expect(byKey["grand-county-ut:parcels"].result?.tier).toBe("local");
  });

  it("falls back to OSM Overpass for Grand County roads when the county GIS layer is empty", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return jsonResponse(osmRoadsResponse);
      }
      // County GIS responds 200 with no features -> trigger the fallback.
      return jsonResponse(arcgisEmpty);
    });
    const outcomes = await runAdapters({
      adapters: [grandCountyRoadsAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      source: string;
    };
    expect(payload.kind).toBe("roads");
    // The OSM fallback path tags the payload with `source: "osm"` and
    // overrides the result-level provider so the briefing engine can
    // attribute the fallback explicitly.
    expect(payload.source).toBe("osm");
    expect(outcomes[0].result?.provider).toMatch(/OpenStreetMap/i);
  });
});

describe("Salmon / Lemhi County ID adapter chain", () => {
  it("emits INSIDE Idaho DEM + Lemhi parcels/zoning/roads outcomes at a Salmon lat/lng", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return jsonResponse(osmRoadsResponse);
      }
      if (url.toLowerCase().includes("zon")) {
        return jsonResponse(arcgisFeatureZoning);
      }
      // Default: a non-empty ArcGIS feature envelope satisfies the
      // DEM/parcels adapters (they only care that `features` is present).
      return jsonResponse(arcgisFeatureWithGeometry);
    });

    const outcomes = await runAdapters({
      adapters: [
        idahoDemAdapter,
        idahoParcelsAdapter,
        lemhiCountyParcelsAdapter,
        lemhiCountyZoningAdapter,
        lemhiCountyRoadsAdapter,
      ],
      context: { ...salmon, fetchImpl },
    });

    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["inside-idaho:dem"].status).toBe("ok");
    expect(byKey["inside-idaho:parcels"].status).toBe("ok");
    expect(byKey["lemhi-county-id:parcels"].status).toBe("ok");
    expect(byKey["lemhi-county-id:zoning"].status).toBe("ok");
    expect(byKey["lemhi-county-id:roads"].status).toBe("ok");
  });

  it("isolates a Lemhi zoning failure without breaking the parcel adapter", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.toLowerCase().includes("zon")) {
        return jsonResponse(
          { error: { code: 500, message: "boom" } },
          500,
        );
      }
      return jsonResponse(arcgisFeatureWithGeometry);
    });
    const outcomes = await runAdapters({
      adapters: [lemhiCountyParcelsAdapter, lemhiCountyZoningAdapter],
      context: { ...salmon, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["lemhi-county-id:parcels"].status).toBe("ok");
    expect(byKey["lemhi-county-id:zoning"].status).toBe("failed");
  });
});
