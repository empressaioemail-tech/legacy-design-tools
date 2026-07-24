/**
 * Site-topography DEM ingest worker tests — Phase 2D.x PR3.
 *
 * The worker's three dependencies — USGS 3DEP HTTP fetch, GeoTIFF
 * parsing, and object storage — are all injected:
 *   - `fetchImpl` stubs the upstream call.
 *   - `vi.mock("geotiff")` stubs the GeoTIFF parser (a real GeoTIFF
 *     byte stream is non-trivial to fabricate inline; the parser is
 *     unit-tested separately by `parseDemBytes`'s own coverage).
 *   - `storage` shim writes to an in-memory Map keyed by uuid path.
 *
 * 6 dispatch-specified test cases + 2 helpful extras (atom payload
 * provenance + atom contextSummary surfaces metrics post-ingest):
 *
 *  1. Happy path — parcel-from-county-GIS → atom event + read row
 *     populated with DEM ref + contour GeoJSON.
 *  2. Bbox-fallback path — no parcel briefing → uses engagement
 *     geocode + 200m buffer → still produces atom + row.
 *  3. No-parcel-coverage skip — no parcel briefing + no geocode →
 *     worker returns `no-parcel-coverage`, no row, no atom event.
 *  4. 3DEP upstream-error — fetchImpl yields HTTP 503 → worker
 *     returns `upstream-error/usgs3dep-unavailable`, no row.
 *  5. Re-run idempotency — identical second run reuses the existing
 *     event + row (no new event appended, single active row).
 *  6. Replay-from-events — delete the materializable_elements row,
 *     trigger re-materialize-from-latest-event, row reappears with
 *     payload matching the original event.
 *  7. Atom payload shape — provenance fields land per
 *     SiteTopographyEventPayload contract.
 *  8. Atom contextSummary — post-ingest, `found: true` with key
 *     metrics derived off the latest event payload.
 */

import {
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ctx } from "./test-context";

// Hoisted mock helpers — the `geotiff` mock has to land before any
// import of `siteTopographyIngest.ts` resolves the real module.
const geotiffMockState: {
  width: number;
  height: number;
  values: number[];
  rejectWith?: Error;
} = {
  width: 10,
  height: 10,
  values: Array.from({ length: 100 }, (_, i) => 100 + i / 10),
};

vi.mock("geotiff", () => ({
  fromArrayBuffer: vi.fn(async () => {
    if (geotiffMockState.rejectWith) {
      throw geotiffMockState.rejectWith;
    }
    return {
      getImage: async () => ({
        getWidth: () => geotiffMockState.width,
        getHeight: () => geotiffMockState.height,
        readRasters: async () => [new Float32Array(geotiffMockState.values)],
      }),
    };
  }),
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("site-topography-ingest.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const {
  engagements,
  parcelBriefings,
  briefingSources,
  materializableElements,
  atomEvents,
} = dbModule;
const { resetAtomRegistryForTests, getHistoryService } = await import(
  "../atoms/registry"
);
const { ingestSiteTopography } = await import(
  "../lib/siteTopographyIngest"
);
const {
  loadActiveSiteTopographyRow,
  rematerializeFromLatestEvent,
  __countActiveSiteTopographyRowsForTests,
} = await import("../lib/siteTopographyMaterializer");
const { makeSiteTopographyAtom } = await import(
  "../atoms/site-topography.atom"
);

const ENGAGEMENT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ENGAGEMENT_NO_PARCEL_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const ENGAGEMENT_NO_GEOCODE_ID = "aaaaaaaa-0000-0000-0000-000000000003";
const BRIEFING_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const BRIEFING_SOURCE_ID = "cccccccc-0000-0000-0000-000000000001";

const MOAB_PARCEL_GEOMETRY = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-109.5499, 38.5732],
      [-109.5497, 38.5732],
      [-109.5497, 38.5734],
      [-109.5499, 38.5734],
      [-109.5499, 38.5732],
    ],
  ],
};

function makeGrandCountyParcelPayload() {
  return {
    kind: "parcel",
    parcel: {
      type: "Feature",
      geometry: MOAB_PARCEL_GEOMETRY,
      properties: {
        headline: "1144 N Kayenta Dr",
        fields: {
          ll_last_refresh: "2026-04-15",
          county: "Grand County",
        },
      },
    },
  };
}

/**
 * Storage shim that captures uploads in-process for assertion. Each
 * upload gets a deterministic synthetic path so the test can verify
 * the worker stored the GeoTIFF reference on the atom event payload.
 */
function makeInMemStorage() {
  const blobs = new Map<string, { bytes: Buffer; contentType: string }>();
  let counter = 0;
  return {
    blobs,
    shim: {
      async uploadObjectEntityFromBuffer(
        bytes: Buffer | Uint8Array,
        contentType: string,
      ): Promise<string> {
        counter++;
        const path = `/objects/test-dem-${counter}.tif`;
        blobs.set(path, {
          bytes: Buffer.from(bytes),
          contentType,
        });
        return path;
      },
    },
  };
}

function makeMinimalTiffResponse(): Response {
  // The bytes here are opaque to the worker because `geotiff` is
  // mocked. Any 200-OK / image/tiff body will pass through to the
  // (mocked) parser. Cast through `unknown` because TS 5.9's strict
  // `Uint8Array<ArrayBufferLike>` doesn't narrow to BodyInit.
  const body = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Response(body as unknown as any, {
    status: 200,
    headers: { "content-type": "image/tiff" },
  });
}

async function seedEngagementWithGrandCountyParcel(): Promise<void> {
  if (!ctx.schema) throw new Error("test: schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Musgrave Residence B (test)",
    nameLower: "musgrave-residence-b-test",
    jurisdiction: "Grand County, UT",
    address: "1144 N Kayenta Dr, Moab UT 84532",
    status: "active",
    latitude: "38.5733",
    longitude: "-109.5498",
  });
  await db.insert(parcelBriefings).values({
    id: BRIEFING_ID,
    engagementId: ENGAGEMENT_ID,
  });
  await db.insert(briefingSources).values({
    id: BRIEFING_SOURCE_ID,
    briefingId: BRIEFING_ID,
    layerKind: "grand-county-ut-parcels",
    sourceKind: "county-gis",
    provider: "Grand County GIS",
    snapshotDate: new Date("2026-04-15T00:00:00.000Z"),
    payload: makeGrandCountyParcelPayload(),
  });
}

async function seedEngagementWithGeocodeOnly(): Promise<void> {
  if (!ctx.schema) throw new Error("test: schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_NO_PARCEL_ID,
    name: "Geocode-only (test)",
    nameLower: "geocode-only-test",
    jurisdiction: "Bastrop, TX",
    address: "100 Main St, Bastrop TX",
    status: "active",
    latitude: "30.1105",
    longitude: "-97.3186",
  });
}

async function seedEngagementWithoutAnything(): Promise<void> {
  if (!ctx.schema) throw new Error("test: schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_NO_GEOCODE_ID,
    name: "No-geocode (test)",
    nameLower: "no-geocode-test",
    jurisdiction: null,
    address: null,
    status: "active",
    // No latitude/longitude
  });
}

beforeAll(async () => {
  ctx.schema = await createTestSchema();
});

afterAll(async () => {
  if (ctx.schema) {
    await dropTestSchema(ctx.schema);
    ctx.schema = null;
  }
});

beforeEach(async () => {
  resetAtomRegistryForTests();
  // Reset the geotiff mock to default elevation values.
  geotiffMockState.width = 10;
  geotiffMockState.height = 10;
  geotiffMockState.values = Array.from({ length: 100 }, (_, i) => 100 + i / 10);
  geotiffMockState.rejectWith = undefined;
});

afterEach(async () => {
  if (!ctx.schema) return;
  const db = ctx.schema.db;
  await db.delete(materializableElements);
  await db.delete(briefingSources);
  await db.delete(parcelBriefings);
  await db.delete(engagements);
  await db.delete(atomEvents);
});

describe("site-topography ingest worker", () => {
  it("[1] happy path — parcel-from-county-GIS → atom event + materializable_elements row", async () => {
    await seedEngagementWithGrandCountyParcel();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim, blobs } = makeInMemStorage();

    const result = await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.eventType).toBe("site-topography.ingested");
    expect(result.parcelOrigin).toBe("county-gis-parcel");
    expect(result.reusedExisting).toBe(false);
    expect(result.contourCount).toBeGreaterThan(0);
    expect(result.demGcsObjectPath).toMatch(/^\/objects\/test-dem-/);
    // One blob upload on the happy path: the DEM GeoTIFF only.
    expect(blobs.size).toBe(1);

    // atom_events row landed.
    const events = await ctx.schema!.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "site-topography"),
          eq(atomEvents.entityId, ENGAGEMENT_ID),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("site-topography.ingested");

    // materializable_elements row landed.
    const row = await loadActiveSiteTopographyRow(ENGAGEMENT_ID);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(result.materializableElementId);
    const ps = row!.propertySet as Record<string, unknown>;
    expect(ps.demRef).toBe(result.demGcsObjectPath);
    expect(ps.atomEventId).toBe(result.atomEventId);
    expect(
      (ps.contoursGeoJson as { features: unknown[] }).features.length,
    ).toBeGreaterThan(0);
  });

  it("[2] bbox-fallback — no parcel briefing, only engagement geocode → still produces atom + row", async () => {
    await seedEngagementWithGeocodeOnly();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim } = makeInMemStorage();

    const result = await ingestSiteTopography({
      engagementId: ENGAGEMENT_NO_PARCEL_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.parcelOrigin).toBe("engagement-geocode-fallback");

    const row = await loadActiveSiteTopographyRow(ENGAGEMENT_NO_PARCEL_ID);
    expect(row).not.toBeNull();
  });

  it("[3] no-parcel-coverage — engagement without geocode AND without parcel briefing → no row, no atom event", async () => {
    await seedEngagementWithoutAnything();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim } = makeInMemStorage();

    const result = await ingestSiteTopography({
      engagementId: ENGAGEMENT_NO_GEOCODE_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });

    expect(result.status).toBe("no-parcel-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
    const events = await ctx.schema!.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "site-topography"),
          eq(atomEvents.entityId, ENGAGEMENT_NO_GEOCODE_ID),
        ),
      );
    expect(events).toHaveLength(0);
    const row = await loadActiveSiteTopographyRow(ENGAGEMENT_NO_GEOCODE_ID);
    expect(row).toBeNull();
  });

  it("[4] 3DEP upstream error — HTTP 503 → upstream-error status, no atom event, no row", async () => {
    await seedEngagementWithGrandCountyParcel();
    const fetchImpl = vi.fn(
      async () =>
        new Response("backend DB down", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
    );
    const { shim } = makeInMemStorage();

    const result = await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });

    expect(result.status).toBe("upstream-error");
    if (result.status !== "upstream-error") throw new Error("unreachable");
    expect(result.code).toBe("usgs3dep-unavailable");

    // No atom event written (failure path is logged-only, not
    // persisted as an event in this implementation — matches
    // ifcIngest.ts convention).
    const events = await ctx.schema!.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "site-topography"),
          eq(atomEvents.entityId, ENGAGEMENT_ID),
        ),
      );
    expect(events).toHaveLength(0);
    const row = await loadActiveSiteTopographyRow(ENGAGEMENT_ID);
    expect(row).toBeNull();
  });

  it("[5] re-run idempotency — second run with same inputs reuses the existing event + row", async () => {
    await seedEngagementWithGrandCountyParcel();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim } = makeInMemStorage();

    const first = await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unreachable");
    expect(first.reusedExisting).toBe(false);

    const second = await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });
    expect(second.status).toBe("ok");
    if (second.status !== "ok") throw new Error("unreachable");
    expect(second.reusedExisting).toBe(true);
    expect(second.atomEventId).toBe(first.atomEventId);

    // Only one upstream call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Only one atom event.
    const events = await ctx.schema!.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "site-topography"),
          eq(atomEvents.entityId, ENGAGEMENT_ID),
        ),
      );
    expect(events).toHaveLength(1);

    // Exactly one active materializable_elements row.
    const activeCount = await __countActiveSiteTopographyRowsForTests(
      ENGAGEMENT_ID,
    );
    expect(activeCount).toBe(1);
  });

  it("[6] replay-from-events — deleted row re-materializes from latest event", async () => {
    await seedEngagementWithGrandCountyParcel();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim } = makeInMemStorage();

    const first = await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unreachable");

    // Simulate the read row going missing (manual deletion, partial
    // failure, schema-pull regression).
    await ctx.schema!.db.delete(materializableElements);
    const missing = await loadActiveSiteTopographyRow(ENGAGEMENT_ID);
    expect(missing).toBeNull();

    // Replay path re-materializes from the atom event.
    const replayed = await rematerializeFromLatestEvent({
      history: getHistoryService(),
      engagementId: ENGAGEMENT_ID,
    });
    expect(replayed.status).toBe("ok");

    const row = await loadActiveSiteTopographyRow(ENGAGEMENT_ID);
    expect(row).not.toBeNull();
    const ps = row!.propertySet as Record<string, unknown>;
    expect(ps.atomEventId).toBe(first.atomEventId);
    expect(ps.demRef).toBe(first.demGcsObjectPath);
  });

  it("[7] atom payload shape — provenance fields land per SiteTopographyEventPayload", async () => {
    await seedEngagementWithGrandCountyParcel();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim } = makeInMemStorage();

    await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
      contourIntervalMeters: 2,
      catchmentBufferMeters: 300,
      demResolutionMeters: 10,
    });

    const events = await ctx.schema!.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "site-topography"),
          eq(atomEvents.entityId, ENGAGEMENT_ID),
        ),
      );
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.computedOrigin).toBe(true);
    expect(payload.aiOrigin).toBe(false);
    expect(payload.workerVersion).toMatch(/^site-topography-ingest@/);
    expect(typeof payload.inputSignature).toBe("string");
    const dem = payload.dem as Record<string, unknown>;
    expect(dem.source).toBe("usgs-3dep");
    expect(dem.resolutionMeters).toBe(10);
    const contours = payload.contours as Record<string, unknown>;
    expect(contours.intervalMeters).toBe(2);
    expect(Array.isArray(contours.thresholds)).toBe(true);
    const catchment = payload.catchment as Record<string, unknown>;
    expect(catchment.bufferMeters).toBe(300);
    const parcel = payload.parcel as Record<string, unknown>;
    expect(parcel.origin).toBe("county-gis-parcel");
    expect(parcel.briefingSourceId).toBe(BRIEFING_SOURCE_ID);
  });

  it("[8] atom contextSummary — found:true with key metrics post-ingest", async () => {
    await seedEngagementWithGrandCountyParcel();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    const { shim } = makeInMemStorage();

    await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl,
      storage: shim,
    });

    const atom = makeSiteTopographyAtom({ history: getHistoryService() });
    const summary = await atom.contextSummary(ENGAGEMENT_ID, {
      audience: "internal",
    });
    const typed = summary.typed as {
      id: string;
      found: boolean;
      demSource?: string;
      contourCount?: number;
      contourIntervalMeters?: number;
      parcelOrigin?: string;
    };
    expect(typed.found).toBe(true);
    expect(typed.demSource).toBe("usgs-3dep");
    expect(typed.contourCount).toBeGreaterThan(0);
    expect(typed.contourIntervalMeters).toBe(5);
    expect(typed.parcelOrigin).toBe("county-gis-parcel");
    expect(summary.keyMetrics.length).toBeGreaterThan(0);
    expect(summary.prose).toMatch(/contour features/i);
  });
});
