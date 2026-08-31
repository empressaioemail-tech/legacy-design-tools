import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME } from "../src/constants.js";
import {
  ANCHOR_BATCH_READ_CAP,
  ANCHOR_PRECISION,
  ANCHOR_SOURCE,
  ANCHOR_TIMEOUT_MS,
  PARCEL_FACETS_PATH_TEMPLATE,
  anchorFromFacetsBody,
  attachBatchAnchorsToResponseText,
  parcelFacetsPath,
  readParcelAnchorsForBatch,
} from "../src/parcel-anchor.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";

const mockCortexFetch = vi.fn();
const CORTEX_TEST_CONFIG = {
  baseUrl: "http://cortex.test",
  serviceApiKey: "test-key",
};
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => CORTEX_TEST_CONFIG,
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const defaultAuth: SmartsiteAuthContext = {
  userId: "user-test-1",
  email: "test@example.com",
  accessTier: "paid",
  subscriptionTier: "studio",
  devRole: false,
};
let mockAuth: SmartsiteAuthContext = { ...defaultAuth };

vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/request-context.js")>();
  return { ...actual, requireAuthContext: () => mockAuth };
});

async function withTestClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: "0.0.1" });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await fn(client);
  await client.close();
  await server.close();
}

/**
 * Read from deployed cortex 2026-08-30. These are the three parcels the M-1
 * card names, with the coordinates the live route actually served, so a
 * fixture cannot drift into asserting a value only this server produces.
 */
const REAL_ANCHORS = [
  { id: "48021:31254", longitude: -97.32528, latitude: 30.10592 },
  { id: "48021:49295", longitude: -97.33348, latitude: 30.11473 },
  { id: "48021:82112", longitude: -97.31907, latitude: 30.12288 },
] as const;

const GOOD_DRAW = {
  frame: { units: "ft", origin: "parcel-centroid" },
  ring: [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 90 },
    { x: 0, y: 90 },
  ],
  edges: [{ id: "front", label: "Front", from: 0, to: 1 }],
  overlays: [],
};

function briefBody(parcelNodeId: string): string {
  return JSON.stringify({
    runId: "r1-anchor-fixture",
    reportFamily: "R1",
    mode: "baked-facet-intel-v1",
    parcelNodeId,
    brief: { sections: [], disclosure: [] },
    draw: GOOD_DRAW,
    source: "baked-snapshot",
  });
}

function facetsBody(
  parcelNodeId: string,
  cityLimitsFact: unknown,
  omitFact = false,
): string {
  const body: Record<string, unknown> = {
    parcelNodeId,
    adapterKey: "node-facets:tier1",
    source: "baked-snapshot",
    snapshotAt: "2026-08-29T20:02:14.749Z",
    facets: { tier: 1, baked: true },
  };
  if (!omitFact) body.cityLimitsFact = cityLimitsFact;
  return JSON.stringify(body);
}

function withQueryPoint(parcelNodeId: string, queryPoint: unknown): string {
  return facetsBody(parcelNodeId, {
    status: "incorporated",
    etjStatus: "unresolved",
    source: "tx_city_boundary",
    cityName: "Bastrop",
    queryPoint,
  });
}

type Served = {
  brief: Response | (() => Response);
  /* M-4: a batch issues one facets call per parcel, so the facets side is given
   * the path. A single shared Response cannot serve N reads: its body is read
   * once, and handing every parcel the same body is how a fixture would agree
   * with itself while the code under test never distinguished the parcels. */
  facets?: Response | ((path: string) => Response | Promise<Response>);
};

/** Route the mock by path so brief and anchor get distinct responses. */
function serve(served: Served): void {
  mockCortexFetch.mockImplementation((_config: unknown, path: string) => {
    if (path.includes("/facets")) {
      if (!served.facets) {
        throw new Error(`unexpected facets call: ${path}`);
      }
      const value =
        typeof served.facets === "function" ? served.facets(path) : served.facets;
      return Promise.resolve(value);
    }
    const value =
      typeof served.brief === "function" ? served.brief() : served.brief;
    return Promise.resolve(value);
  });
}

/** A node-depth array body: one row per id, each with the same shaped draw. */
function batchBriefBody(ids: ReadonlyArray<string>, notFound: ReadonlyArray<string> = []): string {
  return JSON.stringify({
    parcels: ids.map((id) => ({
      parcelNodeId: id,
      brief: { sections: [], disclosure: [] },
      draw: GOOD_DRAW,
    })),
    notFound: notFound,
  });
}

/** Every facets read answers with the coordinate recorded for THAT parcel. */
function serveBatch(ids: ReadonlyArray<string>, notFound: ReadonlyArray<string> = []): void {
  serve({
    brief: () => new Response(batchBriefBody(ids, notFound), { status: 200 }),
    facets: (path: string) => {
      for (const a of REAL_ANCHORS) {
        if (path.includes(encodeURIComponent(a.id))) {
          return new Response(
            withQueryPoint(a.id, { longitude: a.longitude, latitude: a.latitude }),
            { status: 200 },
          );
        }
      }
      return new Response(JSON.stringify({ error: "parcel_not_found" }), { status: 404 });
    },
  });
}

async function callGetSmartSite(
  args: Record<string, unknown>,
): Promise<{ isError: boolean; parsed: Record<string, unknown> }> {
  let out: { isError: boolean; parsed: Record<string, unknown> } | null = null;
  await withTestClient(async (client) => {
    const result = await client.callTool({ name: "get_smart_site", arguments: args });
    out = {
      isError: result.isError === true,
      parsed: JSON.parse((result.content?.[0] as { text: string }).text),
    };
  });
  return out!;
}

function facetsCallPaths(): string[] {
  return mockCortexFetch.mock.calls
    .map((call) => call[1] as string)
    .filter((path) => path.includes("/facets"));
}

beforeEach(() => {
  mockAuth = { ...defaultAuth };
  mockCortexFetch.mockReset();
});

describe("M-1 anchor: the three live parcels", () => {
  for (const parcel of REAL_ANCHORS) {
    it(`${parcel.id} puts the read coordinate on the wire beside draw`, async () => {
      serve({
        brief: new Response(briefBody(parcel.id), { status: 200 }),
        facets: new Response(
          withQueryPoint(parcel.id, {
            longitude: parcel.longitude,
            latitude: parcel.latitude,
          }),
          { status: 200 },
        ),
      });
      const { isError, parsed } = await callGetSmartSite({
        parcelNodeId: parcel.id,
      });
      expect(isError).toBe(false);
      expect(parsed.anchor).toEqual({
        lat: parcel.latitude,
        lon: parcel.longitude,
        precision: ANCHOR_PRECISION,
        source: ANCHOR_SOURCE,
      });
      expect(parsed.anchorRead).toEqual({ status: "ok" });
      // The anchor is a sibling of draw, and draw is untouched.
      expect(JSON.stringify(parsed.draw)).toBe(JSON.stringify(GOOD_DRAW));
    });
  }

  it("reads the exported facets path, percent-encoded, and carries the anchor timeout", async () => {
    const parcel = REAL_ANCHORS[0];
    serve({
      brief: new Response(briefBody(parcel.id), { status: 200 }),
      facets: new Response(
        withQueryPoint(parcel.id, {
          longitude: parcel.longitude,
          latitude: parcel.latitude,
        }),
        { status: 200 },
      ),
    });
    await callGetSmartSite({ parcelNodeId: parcel.id });
    const call = mockCortexFetch.mock.calls.find((c) =>
      (c[1] as string).includes("/facets"),
    );
    expect(call?.[1]).toBe(parcelFacetsPath(parcel.id));
    expect(call?.[1]).toBe(
      "/api/brokerage/v1/place/node/48021%3A31254/facets",
    );
    expect(PARCEL_FACETS_PATH_TEMPLATE).toBe(
      "/api/brokerage/v1/place/node/{parcelNodeId}/facets",
    );
    expect((call?.[2] as { timeoutMs?: number })?.timeoutMs).toBe(
      ANCHOR_TIMEOUT_MS,
    );
    // Matches PROBE_TIMEOUT_MS in hauska-client.ts.
    expect(ANCHOR_TIMEOUT_MS).toBe(2_000);
  });

  it("issues the anchor request before the brief has resolved", async () => {
    const parcel = REAL_ANCHORS[1];
    let releaseBrief: (() => void) | null = null;
    let anchorIssued = false;
    mockCortexFetch.mockImplementation((_config: unknown, path: string) => {
      if (path.includes("/facets")) {
        anchorIssued = true;
        return Promise.resolve(
          new Response(
            withQueryPoint(parcel.id, {
              longitude: parcel.longitude,
              latitude: parcel.latitude,
            }),
            { status: 200 },
          ),
        );
      }
      return new Promise<Response>((resolve) => {
        releaseBrief = () =>
          resolve(new Response(briefBody(parcel.id), { status: 200 }));
      });
    });

    await withTestClient(async (client) => {
      const pending = client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: parcel.id },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const issuedWhileBriefPending = anchorIssued;
      expect(releaseBrief, "brief never reached the mock").not.toBeNull();
      releaseBrief!();
      const result = await pending;
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(issuedWhileBriefPending, "anchor waited for the brief").toBe(true);
      expect(parsed.anchorRead).toEqual({ status: "ok" });
    });
  });
});

describe("M-1 anchor: no coordinate that was not read", () => {
  const parcel = REAL_ANCHORS[0];

  async function callWithFacets(
    facets: Response,
  ): Promise<Record<string, unknown>> {
    serve({
      brief: new Response(briefBody(parcel.id), { status: 200 }),
      facets,
    });
    const { isError, parsed } = await callGetSmartSite({
      parcelNodeId: parcel.id,
    });
    // A failed anchor read never fails the panel.
    expect(isError).toBe(false);
    expect(JSON.stringify(parsed.draw)).toBe(JSON.stringify(GOOD_DRAW));
    expect(parsed).not.toHaveProperty("anchor");
    return parsed;
  }

  it("cityLimitsFact absent is absent, not a guess", async () => {
    const parsed = await callWithFacets(
      new Response(facetsBody(parcel.id, undefined, true), { status: 200 }),
    );
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "city_limits_fact_absent",
    });
  });

  it("queryPoint null is absent", async () => {
    const parsed = await callWithFacets(
      new Response(withQueryPoint(parcel.id, null), { status: 200 }),
    );
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "query_point_absent",
    });
  });

  it("queryPoint 0,0 is the sentinel, never a location off West Africa", async () => {
    const parsed = await callWithFacets(
      new Response(
        withQueryPoint(parcel.id, { longitude: 0, latitude: 0 }),
        { status: 200 },
      ),
    );
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "query_point_zero_sentinel",
    });
  });

  it("longitude 0 with a real latitude is still the sentinel", async () => {
    const parsed = await callWithFacets(
      new Response(
        withQueryPoint(parcel.id, { longitude: 0, latitude: 30.10592 }),
        { status: 200 },
      ),
    );
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "query_point_zero_sentinel",
    });
  });

  it("latitude 0 with a real longitude is still the sentinel", async () => {
    const parsed = await callWithFacets(
      new Response(
        withQueryPoint(parcel.id, { longitude: -97.32528, latitude: 0 }),
        { status: 200 },
      ),
    );
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "query_point_zero_sentinel",
    });
  });

  it("a stringified pair is not numeric and is not coerced", async () => {
    const parsed = await callWithFacets(
      new Response(
        withQueryPoint(parcel.id, { longitude: "-97.32528", latitude: "30.10592" }),
        { status: 200 },
      ),
    );
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "query_point_not_numeric",
    });
  });

  it("a non-JSON upstream body is an error, not an absence", async () => {
    const parsed = await callWithFacets(
      new Response("<html>bad gateway</html>", { status: 200 }),
    );
    expect(parsed.anchorRead).toEqual({
      status: "error",
      reason: "anchor_body_not_json",
    });
  });

  it("a facets non-OK is an error carrying the HTTP status it saw", async () => {
    const parsed = await callWithFacets(
      new Response(JSON.stringify({ error: "parcel_not_found" }), { status: 404 }),
    );
    expect(parsed.anchorRead).toEqual({
      status: "error",
      reason: "anchor_upstream_non_ok",
      upstreamStatus: 404,
    });
  });

  it("a timeout is a declared error and the brief still returns", async () => {
    serve({
      brief: new Response(briefBody(parcel.id), { status: 200 }),
      facets: () =>
        Promise.reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          }),
        ),
    });
    const { isError, parsed } = await callGetSmartSite({
      parcelNodeId: parcel.id,
    });
    expect(isError).toBe(false);
    expect(parsed).not.toHaveProperty("anchor");
    expect(parsed.anchorRead).toEqual({
      status: "error",
      reason: "anchor_read_timeout",
    });
    expect(JSON.stringify(parsed.draw)).toBe(JSON.stringify(GOOD_DRAW));
  });

  it("a non-abort transport failure is a declared error", async () => {
    serve({
      brief: new Response(briefBody(parcel.id), { status: 200 }),
      facets: () => Promise.reject(new Error("ECONNRESET")),
    });
    const { parsed } = await callGetSmartSite({ parcelNodeId: parcel.id });
    expect(parsed).not.toHaveProperty("anchor");
    expect(parsed.anchorRead).toEqual({
      status: "error",
      reason: "anchor_fetch_failed",
    });
  });

  it("the anchor read never disturbs the brief body it does not own", async () => {
    // One Response object served to both calls, which is how the rest of
    // this suite mocks cortex. The optional read must not consume a body
    // the brief needs.
    const shared = new Response(briefBody(parcel.id), { status: 200 });
    mockCortexFetch.mockImplementation(() => Promise.resolve(shared));
    const { isError, parsed } = await callGetSmartSite({
      parcelNodeId: parcel.id,
    });
    expect(isError).toBe(false);
    expect(JSON.stringify(parsed.draw)).toBe(JSON.stringify(GOOD_DRAW));
    expect(parsed.runId).toBe("r1-anchor-fixture");
    expect(parsed).not.toHaveProperty("anchor");
  });

  it("a declared miss carries no anchor and no anchorRead", async () => {
    serve({
      brief: new Response(
        JSON.stringify({ error: "parcel_not_found", message: "no such node" }),
        { status: 404 },
      ),
      facets: new Response(
        withQueryPoint(parcel.id, {
          longitude: parcel.longitude,
          latitude: parcel.latitude,
        }),
        { status: 200 },
      ),
    });
    const { isError, parsed } = await callGetSmartSite({
      parcelNodeId: parcel.id,
    });
    expect(isError).toBe(false);
    expect(parsed).toEqual({
      parcels: [],
      notFound: [parcel.id],
      reason: "parcel_not_found",
      parcelExists: false,
    });
    expect(parsed).not.toHaveProperty("anchor");
    expect(parsed).not.toHaveProperty("anchorRead");
  });

  it("an anchor the brief body carried is dropped, never passed through unread", async () => {
    const smuggled = JSON.stringify({
      runId: "r1-smuggled",
      parcelNodeId: parcel.id,
      brief: { sections: [], disclosure: [] },
      draw: GOOD_DRAW,
      anchor: { lat: 1, lon: 2, precision: ANCHOR_PRECISION, source: ANCHOR_SOURCE },
      anchorRead: { status: "ok" },
    });
    serve({
      brief: new Response(smuggled, { status: 200 }),
      facets: new Response(withQueryPoint(parcel.id, null), { status: 200 }),
    });
    const { parsed } = await callGetSmartSite({ parcelNodeId: parcel.id });
    expect(parsed).not.toHaveProperty("anchor");
    expect(parsed.anchorRead).toEqual({
      status: "absent",
      reason: "query_point_absent",
    });
  });
});

describe("M-4 batch anchor: the cap is a cap", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `48021:${70000 + i}`);

  it("reads exactly the first ANCHOR_BATCH_READ_CAP ids, in request order", async () => {
    const seen: string[] = [];
    const outcome = await readParcelAnchorsForBatch(
      CORTEX_TEST_CONFIG,
      ids,
      (async (_c: unknown, path: string) => {
        seen.push(path);
        return new Response(
          withQueryPoint("x", { longitude: -97.3, latitude: 30.1 }),
          { status: 200 },
        );
      }) as never,
    );
    expect(seen).toEqual(ids.slice(0, ANCHOR_BATCH_READ_CAP).map((id) => parcelFacetsPath(id)));
    expect(outcome.reads.map((r) => r.parcelNodeId)).toEqual(ids.slice(0, ANCHOR_BATCH_READ_CAP));
    expect(outcome.declaration).toEqual({
      cap: ANCHOR_BATCH_READ_CAP,
      received: 20,
      attempted: ANCHOR_BATCH_READ_CAP,
      notAttempted: 20 - ANCHOR_BATCH_READ_CAP,
      reason: "anchor_read_batch_cap",
    });
  });

  it("one parcel's failure is that parcel's declared absence and never its neighbours'", async () => {
    const three = ids.slice(0, 3);
    const outcome = await readParcelAnchorsForBatch(
      CORTEX_TEST_CONFIG,
      three,
      (async (_c: unknown, path: string) => {
        if (path.includes(encodeURIComponent(three[1]!))) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return new Response(
          withQueryPoint("x", { longitude: -97.3, latitude: 30.1 }),
          { status: 200 },
        );
      }) as never,
    );
    expect(outcome.reads.map((r) => r.outcome.anchorRead.status)).toEqual(["ok", "error", "ok"]);
    expect(outcome.reads[1]?.outcome.anchorRead.reason).toBe("anchor_read_timeout");
    expect(outcome.reads[0]?.outcome.anchor).toBeDefined();
    expect(outcome.reads[2]?.outcome.anchor).toBeDefined();
  });

  it("every row past the cap carries its own declared skip, not silence", async () => {
    const outcome = await readParcelAnchorsForBatch(
      CORTEX_TEST_CONFIG,
      ids,
      (async () =>
        new Response(withQueryPoint("x", { longitude: -97.3, latitude: 30.1 }), {
          status: 200,
        })) as never,
    );
    const wire = attachBatchAnchorsToResponseText(
      JSON.stringify({ parcels: ids.map((id) => ({ parcelNodeId: id })), notFound: [] }),
      outcome,
    );
    const rows = JSON.parse(wire).parcels as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(20);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]).toHaveProperty("anchorRead");
      if (i < ANCHOR_BATCH_READ_CAP) {
        expect(rows[i]!.anchorRead).toEqual({ status: "ok" });
      } else {
        expect(rows[i]!.anchorRead).toEqual({
          status: "skipped",
          reason: "anchor_read_batch_cap",
          cap: ANCHOR_BATCH_READ_CAP,
          received: 20,
        });
        expect(rows[i]).not.toHaveProperty("anchor");
      }
    }
  });

  it("an upstream anchor or anchorRead on a row is dropped before ours is written", async () => {
    const outcome = await readParcelAnchorsForBatch(
      CORTEX_TEST_CONFIG,
      [ids[0]!],
      (async () =>
        new Response(withQueryPoint("x", { longitude: -97.3, latitude: 30.1 }), {
          status: 200,
        })) as never,
    );
    const wire = attachBatchAnchorsToResponseText(
      JSON.stringify({
        anchor: { lat: 1, lon: 1 },
        anchorRead: { status: "ok" },
        parcels: [{ parcelNodeId: ids[0], anchor: { lat: 9, lon: 9 }, anchorRead: { status: "ok" } }],
      }),
      outcome,
    );
    const parsed = JSON.parse(wire);
    expect(parsed).not.toHaveProperty("anchor");
    expect(parsed).not.toHaveProperty("anchorRead");
    expect(parsed.parcels[0].anchor).toEqual({
      lat: 30.1,
      lon: -97.3,
      precision: ANCHOR_PRECISION,
      source: ANCHOR_SOURCE,
    });
  });
});

describe("M-1 anchor: scope", () => {
  /*
   * M-4 changed this deliberately. M-1 skipped every array because nobody had
   * bounded the fan; M-4 bounds it at ANCHOR_BATCH_READ_CAP and reads it, so a
   * node array now carries one anchor per parcel and no top-level anchorRead.
   * The stub path is unchanged: a stub row has no draw for an anchor to hold.
   */
  it("an array at node depth reads one anchor per parcel, in request order", async () => {
    const ids = REAL_ANCHORS.map((p) => p.id);
    serveBatch(ids);
    const { isError, parsed } = await callGetSmartSite({
      parcelNodeId: ids,
      depth: "node",
    });
    expect(isError).toBe(false);
    expect(parsed).not.toHaveProperty("anchor");
    expect(parsed).not.toHaveProperty("anchorRead");
    expect(facetsCallPaths()).toEqual(ids.map((id) => parcelFacetsPath(id)));
    const rows = parsed.parcels as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.anchor)).toEqual(
      REAL_ANCHORS.map((a) => ({
        lat: a.latitude,
        lon: a.longitude,
        precision: ANCHOR_PRECISION,
        source: ANCHOR_SOURCE,
      })),
    );
    expect(rows.map((r) => r.anchorRead)).toEqual([
      { status: "ok" },
      { status: "ok" },
      { status: "ok" },
    ]);
  });

  it("under the cap, the batch declares that nothing truncated and carries no reason", async () => {
    const ids = REAL_ANCHORS.map((p) => p.id);
    serveBatch(ids);
    const { parsed } = await callGetSmartSite({ parcelNodeId: ids, depth: "node" });
    expect(parsed.anchorBatch).toEqual({
      cap: ANCHOR_BATCH_READ_CAP,
      received: 3,
      attempted: 3,
      notAttempted: 0,
    });
  });

  it("a one-element array at node depth reads its one anchor", async () => {
    const id = REAL_ANCHORS[0].id;
    serveBatch([id]);
    const { parsed } = await callGetSmartSite({
      parcelNodeId: [id],
      depth: "node",
    });
    expect(facetsCallPaths()).toEqual([parcelFacetsPath(id)]);
    const rows = parsed.parcels as Array<Record<string, unknown>>;
    expect(rows[0]?.anchorRead).toEqual({ status: "ok" });
  });

  it("an array at stub depth still reads no facets and declares the stub reason", async () => {
    serve({
      brief: new Response(
        JSON.stringify({ parcels: [], notFound: [] }),
        { status: 200 },
      ),
    });
    const { parsed } = await callGetSmartSite({
      parcelNodeId: REAL_ANCHORS.map((p) => p.id),
      depth: "stub",
    });
    expect(parsed.anchorRead).toEqual({
      status: "skipped",
      reason: "anchor_read_stub_depth",
    });
    expect(parsed).not.toHaveProperty("anchorBatch");
    expect(facetsCallPaths()).toEqual([]);
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
  });

  it("a single id at stub depth is skipped and reads no facets", async () => {
    serve({
      brief: new Response(
        JSON.stringify({ parcels: [], notFound: [] }),
        { status: 200 },
      ),
    });
    const { parsed } = await callGetSmartSite({
      parcelNodeId: REAL_ANCHORS[0].id,
      depth: "stub",
    });
    expect(parsed.anchorRead).toEqual({
      status: "skipped",
      reason: "anchor_read_stub_depth",
    });
    expect(facetsCallPaths()).toEqual([]);
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
  });

  it("an explicit depth node on one id does read the anchor", async () => {
    const parcel = REAL_ANCHORS[2];
    serve({
      brief: new Response(briefBody(parcel.id), { status: 200 }),
      facets: new Response(
        withQueryPoint(parcel.id, {
          longitude: parcel.longitude,
          latitude: parcel.latitude,
        }),
        { status: 200 },
      ),
    });
    const { parsed } = await callGetSmartSite({
      parcelNodeId: parcel.id,
      depth: "node",
    });
    expect(parsed.anchorRead).toEqual({ status: "ok" });
    expect(facetsCallPaths()).toEqual([parcelFacetsPath(parcel.id)]);
  });

  it("the batch cap itself is unchanged: 26 node ids still refuse before cortex", async () => {
    serve({ brief: new Response("{}", { status: 200 }) });
    const ids = Array.from({ length: 26 }, (_, i) => `48021:${20000 + i}`);
    const { isError, parsed } = await callGetSmartSite({
      parcelNodeId: ids,
      depth: "node",
    });
    expect(isError).toBe(true);
    expect(parsed).toEqual({
      status: "refused",
      reason: "parcel_batch_cap",
      cap: 25,
      received: 26,
      depth: "node",
    });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });
});

describe("anchorFromFacetsBody unit fixtures", () => {
  it("returns no anchor key on every non-ok path", () => {
    const bodies: Array<[string, string, string]> = [
      ["{", "error", "anchor_body_not_json"],
      ["[]", "error", "anchor_body_not_json"],
      ["null", "error", "anchor_body_not_json"],
      ['{"cityLimitsFact":null}', "absent", "city_limits_fact_absent"],
      ['{"cityLimitsFact":{}}', "absent", "query_point_absent"],
      ['{"cityLimitsFact":{"queryPoint":null}}', "absent", "query_point_absent"],
      [
        '{"cityLimitsFact":{"queryPoint":{"longitude":-97.3}}}',
        "absent",
        "query_point_not_numeric",
      ],
      [
        '{"cityLimitsFact":{"queryPoint":{"longitude":null,"latitude":30.1}}}',
        "absent",
        "query_point_not_numeric",
      ],
      [
        '{"cityLimitsFact":{"queryPoint":{"longitude":0,"latitude":0}}}',
        "absent",
        "query_point_zero_sentinel",
      ],
    ];
    for (const [body, status, reason] of bodies) {
      const outcome = anchorFromFacetsBody(body);
      expect(outcome.anchor, body).toBeUndefined();
      expect(outcome.anchorRead, body).toEqual({ status, reason });
    }
  });

  it("nesting: cityLimitsFact is read at the top level only", () => {
    // Live shape 2026-08-30 puts cityLimitsFact at the top level. A copy
    // buried under `facets` is not the served shape and is not read.
    const buried = JSON.stringify({
      facets: {
        cityLimitsFact: { queryPoint: { longitude: -97.32528, latitude: 30.10592 } },
      },
    });
    expect(anchorFromFacetsBody(buried).anchor).toBeUndefined();
    expect(anchorFromFacetsBody(buried).anchorRead.status).toBe("absent");
  });

  it("a read pair produces exactly the four declared fields", () => {
    const outcome = anchorFromFacetsBody(
      '{"cityLimitsFact":{"queryPoint":{"longitude":-97.31907,"latitude":30.12288}}}',
    );
    expect(outcome.anchor).toEqual({
      lat: 30.12288,
      lon: -97.31907,
      precision: "1e-5-deg",
      source: "bake-latlng-index",
    });
    expect(Object.keys(outcome.anchor!)).toEqual([
      "lat",
      "lon",
      "precision",
      "source",
    ]);
  });
});
