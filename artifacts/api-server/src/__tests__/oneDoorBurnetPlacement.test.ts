/**
 * ONE DOOR Burnet 48053 (`_design/2026-10-15_burnet_publish_without_bake.md`
 * items 3, 4, 5): a county with no baked snapshot and no boundary-edge atoms,
 * served `on`, is fully usable through the one door.
 *
 *  - facets + node brief: placed from the reader's `parcelGeometry`
 *    (point + outline), no bake read, no edges fabricated;
 *  - stub depth (screens, saved properties, nearest rows, multi-hit
 *    find_parcel wiring): composed from the reader, no `baked_snapshot_not_found`;
 *  - nearest: Burnet is admitted by the reader, not refused out of scope;
 *  - `off` / `shadow`: unchanged.
 *
 * Same harness as `oneDoorRoutes.test.ts`: no database (every read returns no
 * rows, i.e. no bake), the reader injected through the client's own seam.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

vi.hoisted(() => {
  if (!process.env.DATABASE_URL?.trim()) {
    process.env.DATABASE_URL = "postgres://one-door-test:unused@127.0.0.1:1/unused";
  }
});

vi.mock("@workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  const empty = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin", "groupBy", "offset"]) {
      chain[m] = () => chain;
    }
    chain.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(res, rej);
    return chain;
  };
  return {
    ...actual,
    db: {
      select: () => empty(),
      selectDistinct: () => empty(),
      execute: async () => ({ rows: [] }),
    },
  };
});

vi.mock("../lib/peEntitlement", async () => {
  const actual = await vi.importActual<typeof import("../lib/peEntitlement")>("../lib/peEntitlement");
  return {
    ...actual,
    resolvePeEntitlement: vi.fn(async () => ({
      userId: "user-od-studio",
      subscriptionTier: "studio",
      accessTier: "paid",
    })),
    grantsOwnerCoGatedFields: vi.fn(async () => true),
    requirePeAuthenticated: (_req: Request, _res: Response, next: NextFunction) => next(),
    requirePePaidOrPropertyUnlocked: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

const { brokerageNodeFacetsRouter, setOneDoorPlacementReaderForTests } = await import(
  "../routes/brokerageNodeFacets"
);
const { default: propertyExplorerRouter } = await import("../routes/propertyExplorer");
const { setOneDoorFetcherForTests, resetOneDoorModeMemoryForTests } = await import(
  "../lib/oneDoor/oneDoorReaderClient"
);
const { setParcelRecordFetcherForTests, resetParcelRecordFetcherForTests } = await import(
  "../lib/parcelRecordReaderClient"
);
const { assembleSmartSiteStubBody } = await import("../lib/smartSiteStubServe");
const { loadNearestParcelFactRow } = await import("../lib/nearestParcelFacts");
const { searchNearestParcels, NEAREST_PARCELS_SERVING_COUNTIES } = await import(
  "../lib/txgioNearestParcels"
);
const { oneDoorParcelGeometry, oneDoorRingInDrawFrame } = await import(
  "../lib/oneDoor/oneDoorParcelGeometry"
);
const {
  TX_PARCEL_COUNTIES,
  resolveTxParcelCounty,
  storeCountiesContainingPoint,
  countiesContainingPoint,
  allStoreCounties,
} = await import("../lib/brokerageTxParcels");
const { parseOneDoorRecord } = await import("../lib/oneDoor/oneDoorReaderClient");
const { OD_PARCEL, odReaderBody, odState, odValue } = await import("./oneDoorFixtures");
const {
  BURNET_PARCEL,
  BURNET_POINT,
  BURNET_POLYGON,
  burnetFacts,
  burnetGeometryValue,
  burnetReaderBody,
} = await import("./oneDoorBurnetFixtures");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = {
      tenantId: "default",
      requestor: { kind: "user", id: "user-od-studio" },
    };
    (req as unknown as { brokerageAuth: unknown }).brokerageAuth = { tier: "user" };
    next();
  });
  a.use("/api/brokerage/v1/place", brokerageNodeFacetsRouter);
  a.use("/api", propertyExplorerRouter);
  return a;
}

/** Reader seam: one body per parcel id (default: Burnet `on`). */
function reader(bodies: Record<string, { status?: number; body: unknown }>): string[] {
  const asked: string[] = [];
  setOneDoorFetcherForTests(async ({ parcelNodeId }) => {
    asked.push(parcelNodeId);
    const hit = bodies[parcelNodeId];
    if (!hit) return { kind: "not-configured" };
    return { kind: "ok", status: hit.status ?? 200, body: hit.body };
  });
  return asked;
}

let bakeReads = 0;
const BAKE_POINT = { longitude: -97.9, latitude: 30.05 };

beforeAll(() => {
  setParcelRecordFetcherForTests(null);
  setOneDoorPlacementReaderForTests(async () => {
    bakeReads += 1;
    return BAKE_POINT;
  });
});

afterEach(() => {
  setOneDoorFetcherForTests(null);
  resetOneDoorModeMemoryForTests();
  resetParcelRecordFetcherForTests();
  setParcelRecordFetcherForTests(null);
  bakeReads = 0;
});

const facetsUrl = (id: string) => `/api/brokerage/v1/place/node/${encodeURIComponent(id)}/facets`;
const brief = (parcelNodeId: string | string[], depth: "node" | "stub") =>
  request(app()).post("/api/property-explorer/v1/research/brief").send({ parcelNodeId, depth });

describe("Burnet `on`: placement from the reader's parcelGeometry", () => {
  it("facets: placement point is the reader's placementPoint, labelled, and the bake is never read", async () => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("on") } });
    const res = await request(app()).get(facetsUrl(BURNET_PARCEL));
    expect(res.status).toBe(200);
    expect(res.body.oneDoorMode).toBe("on");
    expect(res.body.placement).toEqual({
      queryPoint: { longitude: BURNET_POINT.lng, latitude: BURNET_POINT.lat },
      source: "reader-parcel-geometry",
    });
    expect(bakeReads).toBe(0);
  });

  it("node brief: a placed card with an outline, no edges, and no bake miss (so no map_wiring_failed)", async () => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("on") } });
    const res = await brief(BURNET_PARCEL, "node");
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.oneDoorMode).toBe("on");
    const draw = res.body.draw;
    expect(draw.frame.anchor).toEqual({ lat: BURNET_POINT.lat, lng: BURNET_POINT.lng });
    expect(draw.label).toBe("100 SYNTHETIC ST");
    expect(draw.ring).toHaveLength(4);
    expect(draw.ringOrder).toBe("ccw");
    // No boundary-edge atoms: no edges, no fabricated edge captions.
    expect(draw).not.toHaveProperty("edges");
    // The ring is in the card's local-feet frame about the anchor: a ~34 m x
    // 44 m rectangle centred on the anchor spans roughly +/-63 ft x +/-73 ft.
    const xs = (draw.ring as [number, number][]).map(([x]) => x);
    const ys = (draw.ring as [number, number][]).map(([, y]) => y);
    expect(Math.min(...xs)).toBeLessThan(-50);
    expect(Math.max(...xs)).toBeGreaterThan(50);
    expect(Math.min(...ys)).toBeLessThan(-60);
    expect(Math.max(...ys)).toBeGreaterThan(60);
    // Counter-clockwise (positive shoelace area) though the reader sent it clockwise.
    let area = 0;
    const ring = draw.ring as [number, number][];
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      area += x1 * y2 - x2 * y1;
    }
    expect(area).toBeGreaterThan(0);
    expect(bakeReads).toBe(0);
  });

  it("falls back to the bake point when the reader has no geometry value, and draws no ring", async () => {
    reader({
      [BURNET_PARCEL]: {
        body: burnetReaderBody("on", burnetFacts({ parcelGeometry: odState("not-loaded") })),
      },
    });
    const facets = await request(app()).get(facetsUrl(BURNET_PARCEL));
    expect(facets.body.placement).toEqual({ queryPoint: BAKE_POINT, source: "bake-latlng-index" });
    const res = await brief(BURNET_PARCEL, "node");
    expect(res.status).toBe(200);
    expect(res.body.draw.frame.anchor).toEqual({ lat: BAKE_POINT.latitude, lng: BAKE_POINT.longitude });
    expect(res.body.draw).not.toHaveProperty("ring");
  });

  it("a malformed reader geometry is not drawn: it falls back rather than inventing a shape", async () => {
    reader({
      [BURNET_PARCEL]: {
        body: burnetReaderBody(
          "on",
          burnetFacts({
            parcelGeometry: odValue({ geometry: { type: "Point", coordinates: [-98.29, 30.58] }, placementPoint: BURNET_POINT }),
          }),
        ),
      },
    });
    const res = await request(app()).get(facetsUrl(BURNET_PARCEL));
    expect(res.body.placement.source).toBe("bake-latlng-index");
  });
});

describe("Burnet `on`: stub depth from the reader", () => {
  it("single stub: rails and label from the reader; no baked_snapshot_not_found", async () => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("on") } });
    const res = await brief(BURNET_PARCEL, "stub");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      parcelNodeId: BURNET_PARCEL,
      label: "100 SYNTHETIC ST, MARBLE FALLS, TX",
      url: `https://smartsite.cloud/p/${BURNET_PARCEL}`,
      situs: "present",
      zoning: "present",
      landUse: "present",
      flood: "present",
      drainage: "unread",
      envelope: "present",
    });
  });

  it("array stub (the MCP multi-hit find_parcel / nearest map wiring): every Burnet id is a row", async () => {
    const second = "48053:990002";
    reader({
      [BURNET_PARCEL]: { body: burnetReaderBody("on") },
      [second]: {
        body: burnetReaderBody(
          "on",
          { situsAddress: odState("not-on-record"), zoningDistrict: odState("not-applicable"), flood: odState("failed") },
          second,
        ),
      },
    });
    const res = await brief([BURNET_PARCEL, second], "stub");
    expect(res.status).toBe(200);
    expect(res.body.notFound).toEqual([]);
    expect(res.body.parcels).toHaveLength(2);
    const row2 = res.body.parcels[1];
    expect(row2).toEqual(
      expect.objectContaining({
        parcelNodeId: second,
        label: second,
        situs: "absent-verified",
        zoning: "absent-verified",
        flood: "unknown",
        landUse: "unread",
      }),
    );
    // A `failed` reader fact is never cached.
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the reader's own 404 is parcel_not_found, not a bake miss", async () => {
    reader({
      [BURNET_PARCEL]: {
        status: 404,
        body: { errorClass: "parcel-not-found", contract: "one-door-v1", mode: "on" },
      },
    });
    const res = await brief(BURNET_PARCEL, "stub");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("parcel_not_found");
  });

  it("screens / saved properties share the assembler: it returns the reader stub", async () => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("on") } });
    const stub = await assembleSmartSiteStubBody(BURNET_PARCEL);
    expect(stub?.zoning).toBe("present");
    expect(stub?.label).toContain("100 SYNTHETIC ST");
  });

  it("nearest rows: stub rails and acreage from the reader, no bake read", async () => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("on") } });
    const row = await loadNearestParcelFactRow({ parcelNodeId: BURNET_PARCEL, distanceFt: 12.5 });
    expect(row).toEqual(
      expect.objectContaining({
        parcelNodeId: BURNET_PARCEL,
        distanceFt: 12.5,
        acreageAcres: 0.43,
        acreage: "present",
        zoning: "present",
        flood: "present",
      }),
    );
  });
});

describe("`off` / `shadow` stub depth is unchanged", () => {
  it.each(["off", "shadow"] as const)("%s: a parcel with no bake is today's miss, byte-identical", async (mode) => {
    setOneDoorFetcherForTests(async () => ({ kind: "not-configured" }));
    const before = await brief(OD_PARCEL, "stub");
    reader({ [OD_PARCEL]: { body: odReaderBody(mode) } });
    const after = await brief(OD_PARCEL, "stub");
    expect(after.status).toBe(before.status);
    expect(after.body).toEqual(before.body);
    expect(after.status).toBe(404);
  });

  it.each(["off", "shadow"] as const)("%s: array stub is today's notFound", async (mode) => {
    setOneDoorFetcherForTests(async () => ({ kind: "not-configured" }));
    const before = await brief([OD_PARCEL], "stub");
    reader({ [OD_PARCEL]: { body: odReaderBody(mode) } });
    const after = await brief([OD_PARCEL], "stub");
    expect(after.body).toEqual(before.body);
    expect(after.body.notFoundReasons[OD_PARCEL].reason).toBe("baked_snapshot_not_found");
  });

  it("on with no reader geometry (every live county today): placement still reads the bake", async () => {
    reader({ [OD_PARCEL]: { body: odReaderBody("on") } });
    const res = await request(app()).get(facetsUrl(OD_PARCEL));
    expect(res.body.placement).toEqual({ queryPoint: BAKE_POINT, source: "bake-latlng-index" });
    expect(bakeReads).toBe(1);
  });
});

describe("nearest scope: Burnet admitted by the reader, not a hand list", () => {
  const fakeDb = {
    query: vi.fn(async () => ({
      rows: [
        { county_fips: "48053", prop_id: "990001", distance_ft: 0 },
        { county_fips: "48053", prop_id: "990002", distance_ft: 40 },
      ],
    })),
  } as never;

  it.each(["shadow", "on"] as const)("Burnet `%s`: not refused out of scope", async (mode) => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody(mode) } });
    const result = await searchNearestParcels({ parcelNodeId: BURNET_PARCEL, db: fakeDb });
    expect("refused" in result).toBe(false);
    if (!("refused" in result)) {
      expect(result.neighbors.map((n) => n.parcelNodeId)).toEqual(["48053:990002"]);
    }
  });

  it("a county the reader has `off` (or cannot reach) is still refused", async () => {
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("off") } });
    const off = await searchNearestParcels({ parcelNodeId: BURNET_PARCEL, db: fakeDb });
    expect(off).toEqual(expect.objectContaining({ refused: true, code: "nearest_county_out_of_scope" }));
    setOneDoorFetcherForTests(async () => ({ kind: "timeout" }));
    const down = await searchNearestParcels({ parcelNodeId: BURNET_PARCEL, db: fakeDb });
    expect(down).toEqual(expect.objectContaining({ refused: true, code: "nearest_county_out_of_scope" }));
  });

  it("the bake-era six never ask the reader", async () => {
    const asked = reader({});
    for (const fips of NEAREST_PARCELS_SERVING_COUNTIES) {
      await searchNearestParcels({ parcelNodeId: `${fips}:1`, db: fakeDb });
    }
    expect(asked).toEqual([]);
  });

  it("the route serves Burnet neighbours instead of a 422", async () => {
    // The route resolves its own store; without one configured it answers
    // 503 store-not-configured, which is AFTER the scope check: never 422.
    reader({ [BURNET_PARCEL]: { body: burnetReaderBody("on") } });
    const res = await request(app())
      .post("/api/property-explorer/v1/research/nearest-parcels")
      .send({ parcelNodeId: BURNET_PARCEL });
    expect(res.status).not.toBe(422);
    expect(JSON.stringify(res.body)).not.toContain("nearest_county_out_of_scope");
  });
});

describe("reader geometry parsing", () => {
  const record = (geometryValue: unknown) =>
    parseOneDoorRecord(burnetReaderBody("on", { parcelGeometry: odValue(geometryValue) }), BURNET_PARCEL)!;

  it("reads the engine contract shape", () => {
    const g = oneDoorParcelGeometry(record(burnetGeometryValue()));
    expect(g?.placementPoint).toEqual({ longitude: BURNET_POINT.lng, latitude: BURNET_POINT.lat });
    expect(g?.partsOuterRings).toHaveLength(1);
    expect(g?.partCount).toBe(1);
  });

  it("MultiPolygon: draws the largest part's outer ring only", () => {
    const small = [
      [-98.2905, 30.5855],
      [-98.2904, 30.5855],
      [-98.2904, 30.5854],
      [-98.2905, 30.5855],
    ];
    const multi = { type: "MultiPolygon", coordinates: [[small], BURNET_POLYGON.coordinates] };
    const g = oneDoorParcelGeometry(record(burnetGeometryValue(multi)))!;
    expect(g.partsOuterRings).toHaveLength(2);
    const ring = oneDoorRingInDrawFrame(g, { lat: BURNET_POINT.lat, lng: BURNET_POINT.lng })!;
    expect(ring).toHaveLength(4);
  });

  it.each([
    ["no placement point", { geometry: BURNET_POLYGON }],
    ["0,0 sentinel point", { geometry: BURNET_POLYGON, placementPoint: { lng: 0, lat: 0 } }],
    ["projected-metre point", { geometry: BURNET_POLYGON, placementPoint: { lng: -10941000, lat: 3580000 } }],
    ["degenerate ring", { geometry: { type: "Polygon", coordinates: [[[-98.29, 30.58], [-98.29, 30.58], [-98.29, 30.58]]] }, placementPoint: BURNET_POINT }],
    ["not an object", "POLYGON((...))"],
  ])("%s -> no reader geometry (caller falls back)", (_label, value) => {
    expect(oneDoorParcelGeometry(record(value))).toBeNull();
  });

  it("a non-value geometry state is no reader geometry", () => {
    const r = parseOneDoorRecord(
      burnetReaderBody("on", { parcelGeometry: odState("not-loaded") }),
      BURNET_PARCEL,
    )!;
    expect(oneDoorParcelGeometry(r)).toBeNull();
  });
});

describe("cortex parcel county registry: Burnet by FIPS only", () => {
  it("Burnet is in the registry, store-backed, FIPS-only", () => {
    const burnet = TX_PARCEL_COUNTIES.find((c) => c.fips === "48053");
    expect(burnet).toEqual(expect.objectContaining({ name: "Burnet", source: "txgio-store", routing: "fips-only" }));
  });

  it("point routing for the live counties is unchanged (Burnet never wins a point)", () => {
    // A Lago Vista-area point inside Burnet's bbox and nearer Burnet's mass
    // centroid than Travis' or Williamson's: it keeps the route it had before
    // the Burnet entry (Williamson, by nearest centroid), never Burnet.
    const travisBorder = { latitude: 30.47, longitude: -97.98 };
    expect(resolveTxParcelCounty(travisBorder)?.fips).toBe("48491");
    // A point in Burnet itself routes nowhere, exactly as before this entry.
    expect(resolveTxParcelCounty({ latitude: BURNET_POINT.lat, longitude: BURNET_POINT.lng })).toBeNull();
    for (const set of [
      storeCountiesContainingPoint(BURNET_POINT.lat, BURNET_POINT.lng),
      countiesContainingPoint(BURNET_POINT.lat, BURNET_POINT.lng),
      allStoreCounties(),
    ]) {
      expect(set.map((c) => c.fips)).not.toContain("48053");
    }
  });
});
