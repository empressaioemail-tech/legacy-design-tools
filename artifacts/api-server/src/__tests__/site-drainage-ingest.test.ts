/**
 * Site-drainage ingest worker tests — Phase 2D.2/2D.3.
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

vi.mock("geotiff", () => ({
  fromArrayBuffer: vi.fn(async () => ({
    getImage: async () => ({
      getWidth: () => 10,
      getHeight: () => 10,
      readRasters: async () => [
        new Float32Array(
          Array.from({ length: 100 }, (_, i) => 100 + (i % 10) * 0.3),
        ),
      ],
    }),
  })),
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("site-drainage-ingest.test: ctx.schema not set");
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
const { ingestSiteTopography } = await import("../lib/siteTopographyIngest");
const { ingestSiteDrainage } = await import("../lib/siteDrainageIngest");
const { makeSiteDrainageAtom } = await import("../atoms/site-drainage.atom");

const ENGAGEMENT_ID = "aaaaaaaa-0000-0000-0000-000000000010";
const BRIEFING_ID = "bbbbbbbb-0000-0000-0000-000000000010";
const BRIEFING_SOURCE_ID = "cccccccc-0000-0000-0000-000000000010";

const ROUND_ROCK_PARCEL = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-97.6795, 30.5088],
      [-97.6783, 30.5088],
      [-97.6783, 30.5096],
      [-97.6795, 30.5096],
      [-97.6795, 30.5088],
    ],
  ],
};

function makeInMemStorage() {
  const blobs = new Map<string, Buffer>();
  let counter = 0;
  const shim = {
    blobs,
    async uploadObjectEntityFromBuffer(bytes: Buffer | Uint8Array) {
      counter++;
      const path = `/objects/test-dem-${counter}.tif`;
      blobs.set(path, Buffer.from(bytes));
      return path;
    },
    async getObjectEntityBytes(path: string) {
      const hit = blobs.get(path);
      if (!hit) throw new Error(`missing ${path}`);
      return hit;
    },
  };
  return shim;
}

function makeMinimalTiffResponse(): Response {
  const body = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  return new Response(body as unknown as never, {
    status: 200,
    headers: { "content-type": "image/tiff" },
  });
}

describe("site-drainage ingest worker", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    resetAtomRegistryForTests();
    getHistoryService();
  });

  afterAll(async () => {
    if (ctx.schema) await dropTestSchema(ctx.schema);
  });

  beforeEach(async () => {
    await ctx.schema!.db.delete(atomEvents);
    await ctx.schema!.db.delete(materializableElements);
    await ctx.schema!.db.delete(briefingSources);
    await ctx.schema!.db.delete(parcelBriefings);
    await ctx.schema!.db.delete(engagements);

    await ctx.schema!.db.insert(engagements).values({
      id: ENGAGEMENT_ID,
      name: "Heathwood test",
      nameLower: "heathwood-test",
      jurisdiction: "Round Rock, TX",
      latitude: "30.509000",
      longitude: "-97.679000",
    });
    await ctx.schema!.db.insert(parcelBriefings).values({
      id: BRIEFING_ID,
      engagementId: ENGAGEMENT_ID,
    });
    await ctx.schema!.db.insert(briefingSources).values({
      id: BRIEFING_SOURCE_ID,
      briefingId: BRIEFING_ID,
      layerKind: "regrid-parcel",
      sourceKind: "national-aggregator",
      provider: "Regrid",
      snapshotDate: new Date(),
      payload: {
        kind: "parcel",
        parcel: {
          type: "Feature",
          geometry: ROUND_ROCK_PARCEL,
          properties: { headline: "1904 Heathwood Cir" },
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path — topo then drainage at 4 inches", async () => {
    const storage = makeInMemStorage();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());

    const topo = await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
    });
    expect(topo.status).toBe("ok");

    const drainage = await ingestSiteDrainage({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      manualDepthInches: 4,
      storage: storage as never,
    });
    expect(drainage.status).toBe("ok");
    if (drainage.status !== "ok") return;
    expect(drainage.rainfallDepthInches).toBe(4);
    expect(drainage.flowLineCount).toBeGreaterThan(0);

    const rows = await ctx.schema!.db
      .select()
      .from(materializableElements)
      .where(
        and(
          eq(materializableElements.engagementId, ENGAGEMENT_ID),
          eq(materializableElements.sourceKind, "site-drainage"),
          isNull(materializableElements.supersededAt),
        ),
      );
    expect(rows).toHaveLength(1);
    const ps = rows[0]!.propertySet as Record<string, unknown>;
    expect(ps.drainageZonesGeoJson).toBeTruthy();
    expect(ps.flowLinesGeoJson).toBeTruthy();
  });

  it("returns no-topography when topo missing", async () => {
    const result = await ingestSiteDrainage({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      manualDepthInches: 4,
    });
    expect(result.status).toBe("no-topography");
  });

  it("atom contextSummary surfaces metrics post-ingest", async () => {
    const storage = makeInMemStorage();
    const fetchImpl = vi.fn(async () => makeMinimalTiffResponse());
    await ingestSiteTopography({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
    });
    await ingestSiteDrainage({
      engagementId: ENGAGEMENT_ID,
      history: getHistoryService(),
      manualDepthInches: 4,
      storage: storage as never,
    });
    const atom = makeSiteDrainageAtom({ history: getHistoryService() });
    const summary = await atom.contextSummary(ENGAGEMENT_ID, {
      audience: "internal",
    });
    expect(summary.typed).toMatchObject({ found: true });
  });
});
