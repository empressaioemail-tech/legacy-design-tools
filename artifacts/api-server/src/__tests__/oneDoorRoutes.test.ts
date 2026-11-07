/**
 * ONE DOOR (WP-L): the cortex facets route (CFR) and the R1 brief (CB) per
 * one-door mode, through the real routers.
 *
 * No database: `@workspace/db`'s `db` is a stub whose reads return no rows
 * (so the old path behaves as it does today for a parcel with no bake: the
 * honest `not_baked` / brief miss), and the PE entitlement module is stubbed
 * to a header-chosen plan. The reader is injected through the client's own
 * seam. Synthetic values only.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

vi.hoisted(() => {
  // @workspace/db refuses to load without a URL; no query is ever issued.
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

type Tier = "anonymous" | "solo" | "studio";
function tierOf(req: Request): Tier {
  const t = req.header("x-test-tier");
  return t === "solo" || t === "studio" ? t : "anonymous";
}

vi.mock("../lib/peEntitlement", async () => {
  const actual = await vi.importActual<typeof import("../lib/peEntitlement")>("../lib/peEntitlement");
  return {
    ...actual,
    resolvePeEntitlement: vi.fn(async (req: Request) => {
      const tier = tierOf(req);
      return {
        userId: tier === "anonymous" ? null : `user-od-${tier}`,
        subscriptionTier: tier === "anonymous" ? null : tier,
        accessTier: tier === "anonymous" ? "free" : "paid",
      };
    }),
    grantsOwnerCoGatedFields: vi.fn(
      async (_userId: string | null, subscriptionTier: string | null) =>
        subscriptionTier === "studio" || subscriptionTier === "team",
    ),
    requirePeAuthenticated: (_req: Request, _res: Response, next: NextFunction) => next(),
    requirePePaidOrPropertyUnlocked: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

const { brokerageNodeFacetsRouter, setOneDoorPlacementReaderForTests } = await import(
  "../routes/brokerageNodeFacets"
);
const { default: propertyExplorerRouter } = await import("../routes/propertyExplorer");
const { setOneDoorFetcherForTests,
  resetOneDoorModeMemoryForTests, ONE_DOOR_GATED_RAILS, ONE_DOOR_TRANSPORT_FAILED_WORDS } = await import(
  "../lib/oneDoor/oneDoorReaderClient"
);
const {
  flushOneDoorShadowDiffsForTests,
  setOneDoorShadowDiffPosterForTests,
} = await import("../lib/oneDoor/oneDoorShadowDiff");
const { setParcelRecordFetcherForTests, resetParcelRecordFetcherForTests } = await import(
  "../lib/parcelRecordReaderClient"
);
const { OD_PARCEL, OD_WORDS, odDefaultFacts, odReaderBody, odState } = await import("./oneDoorFixtures");

function app() {
  const a = express();
  a.use(express.json());
  // The identified-user signal the routes read (#814 resolves the proxy's end
  // user into exactly this shape before these handlers run).
  a.use((req: Request, _res: Response, next: NextFunction) => {
    const tier = tierOf(req);
    if (tier !== "anonymous") {
      (req as unknown as { session: unknown }).session = {
        tenantId: "default",
        requestor: { kind: "user", id: `user-od-${tier}` },
      };
      (req as unknown as { brokerageAuth: unknown }).brokerageAuth = { tier: "user" };
    }
    next();
  });
  a.use("/api/brokerage/v1/place", brokerageNodeFacetsRouter);
  a.use("/api", propertyExplorerRouter);
  return a;
}

type Seen = { entitlementsHeader: string | null };
function reader(body: unknown, status = 200): Seen[] {
  const seen: Seen[] = [];
  setOneDoorFetcherForTests(async (args) => {
    seen.push({ entitlementsHeader: args.entitlementsHeader });
    return { kind: "ok", status, body };
  });
  return seen;
}

const facetsUrl = `/api/brokerage/v1/place/node/${encodeURIComponent(OD_PARCEL)}/facets`;

beforeAll(() => {
  // The old path's own parcel_record client: no reader for it in these tests.
  setParcelRecordFetcherForTests(null);
  setOneDoorPlacementReaderForTests(async () => ({ longitude: -97.9, latitude: 30.05 }));
});

afterEach(() => {
  setOneDoorFetcherForTests(null);
  resetOneDoorModeMemoryForTests();
  setOneDoorShadowDiffPosterForTests(null);
});

describe("facets route (CFR) per one-door mode", () => {
  it("off: today's response, byte-identical to a deployment with no one-door reader at all", async () => {
    setOneDoorFetcherForTests(async () => ({ kind: "not-configured" }));
    const before = await request(app()).get(facetsUrl);
    reader(odReaderBody("off"));
    const off = await request(app()).get(facetsUrl);
    expect(off.status).toBe(before.status);
    expect(off.body).toEqual(before.body);
    expect(off.body.error).toBe("not_baked");
    expect(off.body).not.toHaveProperty("facts");
  });

  it("shadow: serves today's answer, posts the diff afterwards, and a hung sink never delays it", async () => {
    const posted: unknown[][] = [];
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    setOneDoorShadowDiffPosterForTests(async (rows) => {
      posted.push(rows);
      await hang;
      return { status: 202 };
    });
    setOneDoorFetcherForTests(async () => ({ kind: "not-configured" }));
    const today = await request(app()).get(facetsUrl);
    reader(odReaderBody("shadow"));
    const shadow = await request(app()).get(facetsUrl);
    expect(shadow.status).toBe(today.status);
    expect(shadow.body).toEqual(today.body);
    await new Promise((r) => setImmediate(r));
    const flushing = flushOneDoorShadowDiffsForTests();
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(1);
    const rows = posted[0] as Array<{ fact: string; surface: string; oldShown: { state: string } }>;
    expect(rows.every((r) => r.surface === "cortex-facets")).toBe(true);
    expect(rows.find((r) => r.fact === "situsAddress")?.oldShown.state).toBe("old:missing");
    release();
    await flushing;
  });

  it("on: every fact from the reader, verbatim; no baked label; placement only from the bake", async () => {
    reader(odReaderBody("on"));
    const res = await request(app()).get(facetsUrl);
    expect(res.status).toBe(200);
    expect(res.body.oneDoorMode).toBe("on");
    expect(res.body.source).toBe("parcel-record-reader");
    expect(JSON.stringify(res.body)).not.toContain("baked-snapshot");
    expect(res.body).not.toHaveProperty("facets");
    expect(res.body).not.toHaveProperty("landUseFact");
    expect(res.body.facts.zoningDistrict).toEqual(
      expect.objectContaining({ state: "not-applicable", words: OD_WORDS["not-applicable"] }),
    );
    expect(res.body.facts.landUseCode).toEqual(expect.objectContaining({ state: "value", value: "C1" }));
    expect(res.body.placement.queryPoint).toEqual({ longitude: -97.9, latitude: 30.05 });
  });

  it("on: reader `failed` -> words shown and the response is never cached", async () => {
    reader(odReaderBody("on"));
    const res = await request(app()).get(facetsUrl);
    expect(res.body.facts.etjStatus.words).toBe(OD_WORDS.failed);
    expect(res.headers["cache-control"]).toBe("no-store");
    reader(odReaderBody("on", { apn: odState("not-on-record") }));
    const clean = await request(app()).get(facetsUrl);
    expect(clean.headers["cache-control"]).toBeUndefined();
  });

  it("on, reader then unreachable: the county stays `on` and every fact is `failed`, uncached", async () => {
    reader(odReaderBody("on"));
    await request(app()).get(facetsUrl);
    setOneDoorFetcherForTests(async () => ({ kind: "timeout" }));
    const res = await request(app()).get(facetsUrl);
    expect(res.status).toBe(200);
    expect(res.body.oneDoorMode).toBe("on");
    expect(res.body.facts.situsAddress).toEqual(
      expect.objectContaining({ state: "failed", words: ONE_DOOR_TRANSPORT_FAILED_WORDS }),
    );
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("on: the reader's parcel-not-found is a 404 of its own", async () => {
    reader(
      { error: "not_found", errorClass: "parcel-not-found", parcelNodeId: OD_PARCEL, countyFips: "48209", contract: "one-door-v1", mode: "on", message: "x" },
      404,
    );
    const res = await request(app()).get(facetsUrl);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("parcel-not-found");
  });

  it.each([
    ["anonymous", null],
    ["solo", null],
    ["studio", [...ONE_DOOR_GATED_RAILS].sort().join(",")],
  ] as const)("X-Hauska-Entitlements from the END USER's plan: %s", async (tier, expected) => {
    const seen = reader(odReaderBody("on"));
    await request(app()).get(facetsUrl).set("x-test-tier", tier);
    expect(seen[0]!.entitlementsHeader).toBe(expected);
  });
});

describe("legacy /record reads carry the END USER's entitlements in every mode (#525)", () => {
  async function legacyHeaders(path: "facets" | "brief", tier: "anonymous" | "solo" | "studio") {
    const seen: Array<string | null> = [];
    const prevKey = process.env.HAUSKA_RETRIEVAL_API_KEY;
    process.env.HAUSKA_RETRIEVAL_API_KEY = "legacy-route-test-key"; // arms the env-backed cell reader
    setParcelRecordFetcherForTests(async (_placeKey, header) => {
      seen.push(header);
      return null; // the old path's own failure handling; only the header matters here
    });
    reader(odReaderBody("off"));
    try {
      if (path === "facets") await request(app()).get(facetsUrl).set("x-test-tier", tier);
      else
        await request(app())
          .post("/api/property-explorer/v1/research/brief")
          .set("x-test-tier", tier)
          .send({ parcelNodeId: OD_PARCEL, depth: "node" });
    } finally {
      if (prevKey === undefined) delete process.env.HAUSKA_RETRIEVAL_API_KEY;
      else process.env.HAUSKA_RETRIEVAL_API_KEY = prevKey;
    }
    return seen;
  }

  it.each(["facets", "brief"] as const)("%s: Studio sends the gated rail list on every legacy read", async (path) => {
    const seen = await legacyHeaders(path, "studio");
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h).toBe([...ONE_DOOR_GATED_RAILS].sort().join(","));
  });

  it.each(["facets", "brief"] as const)("%s: Solo sends no header (default deny)", async (path) => {
    const seen = await legacyHeaders(path, "solo");
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h).toBeNull();
  });

  it("facets: anonymous sends no header", async () => {
    const seen = await legacyHeaders("facets", "anonymous");
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h).toBeNull();
  });
});

describe("R1 brief (CB, what the MCP card renders) per one-door mode", () => {
  const brief = (tier: "solo" | "studio" = "studio") =>
    request(app())
      .post("/api/property-explorer/v1/research/brief")
      .set("x-test-tier", tier)
      .send({ parcelNodeId: OD_PARCEL, depth: "node" });

  it("on: sections carry the reader's state and words; no onRecord, no baked label", async () => {
    reader(odReaderBody("on", odDefaultFacts()));
    const res = await brief();
    expect(res.status).toBe(200);
    expect(res.body.oneDoorMode).toBe("on");
    expect(res.body).not.toHaveProperty("onRecord");
    expect(JSON.stringify(res.body)).not.toContain("baked-snapshot");
    const byId = Object.fromEntries(
      (res.body.brief.sections as Array<{ id: string }>).map((s) => [s.id, s]),
    ) as unknown as Record<string, { oneDoor: { state: string; words: string }; reason?: string; data: unknown }>;
    expect(byId.zoning!.oneDoor).toEqual(
      expect.objectContaining({ state: "not-applicable", words: OD_WORDS["not-applicable"] }),
    );
    expect(byId.zoning!.reason).toBe(OD_WORDS["not-applicable"]);
    expect(byId.flood!.data).toEqual(
      expect.objectContaining({
        floodZone: "X",
        inSpecialFloodHazardArea: false,
        rows: [{ zone: "X", subtype: null, isSfha: false }],
      }),
    );
    expect(byId["setbacks-envelope"]!.reason).toBe(OD_WORDS.held);
    expect(res.body.facts.owner.words).toBe(OD_WORDS["plan-gated"]);
  });

  it("on: entitlement header is the end user's (Solo none, Studio the gated list)", async () => {
    const solo = reader(odReaderBody("on"));
    await brief("solo");
    expect(solo[0]!.entitlementsHeader).toBeNull();
    const studio = reader(odReaderBody("on"));
    await brief("studio");
    expect(studio[0]!.entitlementsHeader).toBe([...ONE_DOOR_GATED_RAILS].sort().join(","));
  });

  it("on: a parcel with no bake still gets its brief (the C14 collapse is gone)", async () => {
    reader(odReaderBody("on"));
    const res = await brief();
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it("on: reader failed -> no-store", async () => {
    reader(odReaderBody("on", { flood: odState("failed") }));
    const res = await brief();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.brief.sections[0].reason).toBe(OD_WORDS.failed);
  });

  it("off: the brief is today's (a parcel with no bake is today's miss)", async () => {
    setOneDoorFetcherForTests(async () => ({ kind: "not-configured" }));
    const before = await brief();
    reader(odReaderBody("off"));
    const off = await brief();
    expect(off.status).toBe(before.status);
    expect(off.body).toEqual(before.body);
  });
});

afterEach(() => {
  resetParcelRecordFetcherForTests();
  setParcelRecordFetcherForTests(null);
});
