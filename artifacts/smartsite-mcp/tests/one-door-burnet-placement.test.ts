/**
 * ONE DOOR Burnet 48053 `on` through the MCP (`_design/2026-10-15_burnet_publish_without_bake.md`
 * items 3-5): a county with no bake and no boundary-edge atoms is placed and
 * outlined from the reader's `parcelGeometry`, and `find_parcel` map wiring
 * (single hit at node depth, multi hit at stub depth) no longer fails.
 *
 * The cortex bodies are built by the SAME api-server composers the routes use
 * in `on` mode, from the Burnet reader fixture. Synthetic values only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeOneDoorBriefBody,
  composeOneDoorFacetsBody,
} from "../../api-server/src/lib/oneDoor/oneDoorSurfaces.ts";
import { parseOneDoorRecord } from "../../api-server/src/lib/oneDoor/oneDoorReaderClient.ts";
import { oneDoorParcelGeometry } from "../../api-server/src/lib/oneDoor/oneDoorParcelGeometry.ts";
import { composeOneDoorSmartSiteStub } from "../../api-server/src/lib/oneDoor/oneDoorStub.ts";
import { tryAssembleGeometryOnlyParcelDraw } from "../../api-server/src/lib/parcelDrawFromReads.ts";
import {
  BURNET_PARCEL,
  BURNET_POINT,
  burnetReaderBody,
} from "../../api-server/src/__tests__/oneDoorBurnetFixtures.ts";
import {
  ANCHOR_SOURCE,
  ANCHOR_SOURCE_READER,
  anchorFromFacetsBody,
} from "../src/parcel-anchor.js";
import { countyForNodeId } from "../src/card/panel-lib.js";

const mockCortexFetch = vi.fn();
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => ({ baseUrl: "http://cortex.test", serviceApiKey: "k" }),
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const { wireFindParcelForMap } = await import("../src/map-tool-wire.js");

const SECOND = "48053:990002";

function record(parcelNodeId = BURNET_PARCEL) {
  return parseOneDoorRecord(burnetReaderBody("on", undefined, parcelNodeId), parcelNodeId)!;
}

function facetsBody(parcelNodeId = BURNET_PARCEL) {
  const geometry = oneDoorParcelGeometry(record(parcelNodeId))!;
  return composeOneDoorFacetsBody({
    parcelNodeId,
    record: record(parcelNodeId),
    placement: { queryPoint: geometry.placementPoint, source: "reader-parcel-geometry" },
  });
}

function nodeBriefBody() {
  const rec = record();
  const geometry = oneDoorParcelGeometry(rec)!;
  const draw = tryAssembleGeometryOnlyParcelDraw({
    parcelNodeId: BURNET_PARCEL,
    label: "100 SYNTHETIC ST",
    queryPoint: geometry.placementPoint,
    boundary: null,
    readerGeometry: geometry,
  });
  return composeOneDoorBriefBody({
    runId: "pe-r1-burnet.test",
    parcelNodeId: BURNET_PARCEL,
    record: rec,
    draw: draw as unknown as Record<string, unknown>,
  });
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  mockCortexFetch.mockReset();
  // The suite runs with map wiring off (vitest.config.ts); these tests are about it.
  vi.stubEnv("SMARTSITE_MAP_WIRE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anchor from the reader's placement point", () => {
  it("is labelled as the reader's, not the bake's", () => {
    const out = anchorFromFacetsBody(JSON.stringify(facetsBody()));
    expect(out.anchorRead.status).toBe("ok");
    expect(out.anchor).toEqual(
      expect.objectContaining({ lat: BURNET_POINT.lat, lon: BURNET_POINT.lng, source: ANCHOR_SOURCE_READER }),
    );
  });

  it("a bake-sourced placement keeps the bake label", () => {
    const out = anchorFromFacetsBody(
      JSON.stringify({ placement: { queryPoint: { longitude: -97.9, latitude: 30.05 }, source: "bake-latlng-index" } }),
    );
    expect(out.anchor?.source).toBe(ANCHOR_SOURCE);
  });
});

describe("find_parcel map wiring for Burnet `on`", () => {
  it("single hit: node brief with a placed outline, anchored from the reader; no map_wiring_failed", async () => {
    mockCortexFetch.mockImplementation(async (_config: unknown, path: string) =>
      path.includes("/facets") ? respond(facetsBody()) : respond(nodeBriefBody()),
    );
    const text = await wireFindParcelForMap(
      { baseUrl: "http://cortex.test", serviceApiKey: "k" } as never,
      "user-1",
      JSON.stringify({ hits: [{ parcelNodeId: BURNET_PARCEL }] }),
      true,
    );
    expect(text).not.toContain("map_wiring_failed");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.mapWiring).toBeUndefined();
    const draw = body.draw as { ring: unknown[]; frame: { anchor: unknown } };
    expect(draw.ring).toHaveLength(4);
    expect(draw.frame.anchor).toEqual({ lat: BURNET_POINT.lat, lng: BURNET_POINT.lng });
    expect((body.anchor as { source: string }).source).toBe(ANCHOR_SOURCE_READER);
  });

  it("multi hit: stub depth answers from the reader; no map_wiring_failed", async () => {
    mockCortexFetch.mockImplementation(async (_config: unknown, path: string) =>
      path.includes("/facets")
        ? respond(facetsBody())
        : respond({
            parcels: [
              composeOneDoorSmartSiteStub(BURNET_PARCEL, record()),
              composeOneDoorSmartSiteStub(SECOND, record(SECOND)),
            ],
            notFound: [],
            notFoundReasons: {},
          }),
    );
    const text = await wireFindParcelForMap(
      { baseUrl: "http://cortex.test", serviceApiKey: "k" } as never,
      "user-1",
      JSON.stringify({ hits: [{ parcelNodeId: BURNET_PARCEL }, { parcelNodeId: SECOND }] }),
      false,
    );
    expect(text).not.toContain("map_wiring_failed");
    expect(JSON.parse(text).mapWiring).toBeUndefined();
  });
});

describe("county names", () => {
  it.each([
    ["48053:1", "Burnet"],
    ["48027:1", "Bell"],
    ["48331:1", "Milam"],
  ])("%s names %s instead of 'this county'", (id, name) => {
    expect(countyForNodeId(id)).toBe(name);
  });
});
