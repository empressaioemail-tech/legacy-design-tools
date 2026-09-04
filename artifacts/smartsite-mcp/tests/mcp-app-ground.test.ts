/**
 * P-91 v3 M-2: the aerial ground under the parcel drawing.
 *
 * Every fixture here is a check with two independently derived sides. The
 * Mercator forward transform is checked against its own inverse; the tile id is
 * checked against the slippy map formula written in its asinh form, which is a
 * different expression of the same projection; the map's ground scale is checked
 * against the drawing's own foot frame, which knows nothing about Mercator. A
 * transposed tile axis, a dropped cos(latitude), an international foot in place
 * of the survey foot, an inverted y, and a ground painted on a non ok anchor
 * each fail at least one of these. The mutation table is in the handback.
 *
 * Coordinates: the anchor is the one recorded for 48021:31254 in the M-1 lane
 * doc comment. The high latitude anchor and every ring here are SYNTHETIC test
 * inputs chosen to exercise the arithmetic, never parcel facts.
 */
import { describe, expect, it } from "vitest";
import {
  ACROSS_ROW,
  GROUND_EQUATOR_MPP,
  GROUND_MAX_TILES,
  GROUND_SOURCE_LABEL,
  GROUND_SUPERSAMPLE,
  GROUND_TILE_ORIGIN,
  GROUND_TILE_PX,
  GROUND_TILE_URL_TEMPLATE,
  GROUND_TOGGLE_LABEL,
  GROUND_VINTAGE_NOTE,
  GROUND_ZOOM_MAX,
  GROUND_ZOOM_MIN,
  RESOURCE_CSP_DOMAINS,
  US_SURVEY_FOOT_M,
  buildAppHtml,
  edgeDoor,
  edgeTipHtml,
  groundLatLon,
  groundLayerHtml,
  groundMetresPerPixel,
  groundPixelsPerFoot,
  groundPlan,
  groundProject,
  groundTileId,
  groundTileUrl,
  groundWorldPixel,
  groundZoomFor,
  htmlContractViolations,
  registerMcpApp,
  renderParcelDraw,
  ringFit,
  ringPixel,
  ringSvg,
  parseToolResult,
  type PanelAnchor,
  type PanelAnchorRead,
  type RingPt,
} from "../src/mcp-app.js";
import { anchorFromFacetsBody, attachAnchorToResponseText } from "../src/parcel-anchor.js";

/* Recorded anchor for 48021:31254 (M-1). */
const ANCHOR: PanelAnchor = { lat: 30.10592, lon: -97.32528, precision: "1e-5-deg", source: "bake-latlng-index" };
const OK: PanelAnchorRead = { status: "ok", reason: null };

/* The recorded v1 gold ring, feet from the parcel centroid. */
const GOLD_RING: RingPt[] = [
  { x: 48.6, y: 83.94 },
  { x: -50.37, y: 83.7 },
  { x: -49.07, y: -84.28 },
  { x: 50.84, y: -83.36 },
];

/*
 * Independent constants, written from their definitions and not read from the
 * module under test. The US survey foot is 1200/3937 m exactly; EPSG:3857 is a
 * sphere of radius 6378137 m, so a northward ground displacement of d metres
 * moves latitude by d/R radians and a 256 pixel tile at zoom 0 spans 2*pi*R/256
 * metres per pixel at the equator.
 */
const SURVEY_FOOT_M = 1200 / 3937;
const MERCATOR_R = 6378137;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The slippy map tile formula in its asinh form: a different expression of the same projection. */
function tileByAsinh(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2) * n),
  };
}

/** A coordinate `feet` due north of another, on the sphere the projection uses. */
function northOf(lat: number, feet: number): number {
  return lat + deg((feet * SURVEY_FOOT_M) / MERCATOR_R);
}

/** A coordinate `feet` due east of another, on the same sphere. */
function eastOf(lat: number, lon: number, feet: number): number {
  return lon + deg((feet * SURVEY_FOOT_M) / (MERCATOR_R * Math.cos(rad(lat))));
}

const planFor = (ring: RingPt[], anchor: PanelAnchor) => {
  const out = groundPlan(ring, anchor, OK);
  if (!out.plan) throw new Error(`expected a plan, got ${out.reason}`);
  return out.plan;
};

describe("M-2 projection constants are derived, not asserted", () => {
  it("the zoom 0 ground resolution is the sphere's circumference over one tile", () => {
    expect(GROUND_EQUATOR_MPP).toBeCloseTo((2 * Math.PI * MERCATOR_R) / GROUND_TILE_PX, 9);
  });

  it("the foot is the US survey foot, 1200/3937, not the international 0.3048", () => {
    expect(US_SURVEY_FOOT_M).toBe(SURVEY_FOOT_M);
    expect(US_SURVEY_FOOT_M).not.toBe(0.3048);
    /* the two differ by two parts per million, which is why the scale fixtures below are tight */
    expect(Math.abs(US_SURVEY_FOOT_M / 0.3048 - 1)).toBeGreaterThan(1e-6);
  });

  it("ground resolution carries cos(latitude), so Bastrop is about 13.5 percent finer than the equator", () => {
    const atBastrop = groundMetresPerPixel(ANCHOR.lat, 19);
    const atEquator = groundMetresPerPixel(0, 19);
    expect(atBastrop / atEquator).toBeCloseTo(Math.cos(rad(ANCHOR.lat)), 12);
    expect(atBastrop / atEquator).toBeLessThan(0.87);
  });
});

describe("M-2 Mercator round trip", () => {
  it("lat/lon to world pixel and back agrees within 1e-6 degrees at three zooms and three latitudes", () => {
    const points = [
      { lat: ANCHOR.lat, lon: ANCHOR.lon },
      { lat: 59.9, lon: 10.75 },
      { lat: -33.87, lon: 151.21 },
    ];
    for (const z of [14, 16, 19]) {
      for (const p of points) {
        const w = groundWorldPixel(p.lat, p.lon, z);
        const back = groundLatLon(w.wx, w.wy, z);
        expect(Math.abs(back.lat - p.lat), `lat z${z}`).toBeLessThan(1e-6);
        expect(Math.abs(back.lon - p.lon), `lon z${z}`).toBeLessThan(1e-6);
      }
    }
  });

  it("tile index plus pixel offset reconstructs the coordinate", () => {
    const z = 19;
    const w = groundWorldPixel(ANCHOR.lat, ANCHOR.lon, z);
    const tile = groundTileId(ANCHOR.lat, ANCHOR.lon, z);
    const offsetX = w.wx - tile.x * GROUND_TILE_PX;
    const offsetY = w.wy - tile.y * GROUND_TILE_PX;
    expect(offsetX).toBeGreaterThanOrEqual(0);
    expect(offsetX).toBeLessThan(GROUND_TILE_PX);
    expect(offsetY).toBeGreaterThanOrEqual(0);
    expect(offsetY).toBeLessThan(GROUND_TILE_PX);
    const back = groundLatLon(tile.x * GROUND_TILE_PX + offsetX, tile.y * GROUND_TILE_PX + offsetY, z);
    expect(Math.abs(back.lat - ANCHOR.lat)).toBeLessThan(1e-6);
    expect(Math.abs(back.lon - ANCHOR.lon)).toBeLessThan(1e-6);
  });

  it("a transposed world pixel pair does NOT round trip, so the round trip is not vacuous", () => {
    const z = 19;
    const w = groundWorldPixel(ANCHOR.lat, ANCHOR.lon, z);
    const swapped = groundLatLon(w.wy, w.wx, z);
    expect(Math.abs(swapped.lat - ANCHOR.lat)).toBeGreaterThan(1);
  });
});

describe("M-2 tile path order is z / y / x", () => {
  const z = 19;

  it("the tile id matches the asinh form of the slippy map formula", () => {
    const mine = groundTileId(ANCHOR.lat, ANCHOR.lon, z);
    const theirs = tileByAsinh(ANCHOR.lat, ANCHOR.lon, z);
    expect(mine.x).toBe(theirs.x);
    expect(mine.y).toBe(theirs.y);
    /* pinned, so a change to both derivations at once still fails here */
    expect(mine).toEqual({ z: 19, x: 120403, y: 216130 });
    expect(mine.x).not.toBe(mine.y);
  });

  it("the url puts the row before the column", () => {
    const t = groundTileId(ANCHOR.lat, ANCHOR.lon, z);
    const url = groundTileUrl(t.z, t.x, t.y);
    expect(url).toBe(`${GROUND_TILE_ORIGIN}/ArcGIS/rest/services/World_Imagery/MapServer/tile/19/216130/120403`);
    const tail = url.split("/tile/")[1] ?? "";
    expect(tail.split("/")).toEqual(["19", String(t.y), String(t.x)]);
  });

  it("swapping the last two segments names a DIFFERENT tile, so the order check cannot pass on a transposition", () => {
    const t = groundTileId(ANCHOR.lat, ANCHOR.lon, z);
    expect(groundTileUrl(t.z, t.y, t.x)).not.toBe(groundTileUrl(t.z, t.x, t.y));
    const transposed = groundLatLon((t.y + 0.5) * GROUND_TILE_PX, (t.x + 0.5) * GROUND_TILE_PX, z);
    expect(Math.abs(transposed.lat - ANCHOR.lat)).toBeGreaterThan(1);
  });

  /*
   * The url a PLAN emits, decoded back independently. Reading the last three
   * segments as z / y / x and inverting the projection must land inside the tile
   * that holds the anchor. A transposed path builds a url for a real tile
   * somewhere else, which every assertion phrased against groundTileUrl's own
   * output would accept; this one does not, because the decode is the inverse of
   * the projection rather than a second call to the builder.
   */
  it("the tile url a plan emits decodes back onto the anchor", () => {
    const plan = planFor(GOLD_RING, ANCHOR);
    const home = groundTileId(ANCHOR.lat, ANCHOR.lon, plan.z);
    const mine = plan.tiles.filter((t) => t.x === home.x && t.y === home.y);
    expect(mine).toHaveLength(1);
    const url = mine[0]?.url ?? "";
    const parts = (url.split("/tile/")[1] ?? "").split("/");
    const decodedZ = Number(parts[0]);
    const decodedRow = Number(parts[1]);
    const decodedCol = Number(parts[2]);
    expect(decodedZ).toBe(plan.z);
    const centre = groundLatLon(
      (decodedCol + 0.5) * GROUND_TILE_PX,
      (decodedRow + 0.5) * GROUND_TILE_PX,
      decodedZ,
    );
    /* one level 19 tile is about 70 m, so half a tile is well under 0.001 degrees */
    expect(Math.abs(centre.lat - ANCHOR.lat)).toBeLessThan(0.001);
    expect(Math.abs(centre.lon - ANCHOR.lon)).toBeLessThan(0.001);
  });

  it("the template is the single source of the declared origin", () => {
    expect(GROUND_TILE_ORIGIN).toBe(new URL(GROUND_TILE_URL_TEMPLATE).origin);
    expect(RESOURCE_CSP_DOMAINS).toContain(GROUND_TILE_ORIGIN);
    expect(GROUND_TILE_URL_TEMPLATE).toContain("/tile/{z}/{y}/{x}");
    expect(GROUND_TILE_URL_TEMPLATE).not.toContain("/tile/{z}/{x}/{y}");
  });
});

describe("M-2 registration: the anchor pixel and the ring origin pixel are one point", () => {
  it("projecting the anchor through Mercator lands on the ring's own origin", () => {
    const plan = planFor(GOLD_RING, ANCHOR);
    const fit = ringFit(GOLD_RING);
    if (!fit) throw new Error("no fit");
    const origin = ringPixel(fit, 0, 0);
    const projected = groundProject(plan, ANCHOR.lat, ANCHOR.lon);
    expect(Math.abs(projected.x - origin.x)).toBeLessThan(1e-9);
    expect(Math.abs(projected.y - origin.y)).toBeLessThan(1e-9);
    expect(plan.anchorPx).toEqual(origin);
  });

  it("the origin is inside the drawing, so the registration is not being read off a degenerate point", () => {
    const plan = planFor(GOLD_RING, ANCHOR);
    expect(plan.anchorPx.x).toBeGreaterThan(0);
    expect(plan.anchorPx.x).toBeLessThan(320);
    expect(plan.anchorPx.y).toBeGreaterThan(0);
    expect(plan.anchorPx.y).toBeLessThan(220);
  });
});

describe("M-2 scale: the map's ground scale equals the drawing's", () => {
  /*
   * The expected side of every assertion here comes from the drawing's foot
   * frame (feet times fit.s) and knows nothing about Mercator. The measured side
   * runs a real ground displacement through the projection and the plan. They
   * agree only if the cosine term, the survey foot and the y sign are all right.
   *
   * One foot keeps the projection's own second order term near 3e-8 relative,
   * two orders below the 2e-6 the international foot would introduce, so the
   * tolerance can separate them.
   */
  const D = 1;
  const TOL = 2e-7;

  const check = (lat: number, lon: number, ring: RingPt[]) => {
    const anchor: PanelAnchor = { lat, lon, precision: null, source: null };
    const plan = planFor(ring, anchor);
    const fit = ringFit(ring);
    if (!fit) throw new Error("no fit");
    const origin = ringPixel(fit, 0, 0);

    const north = groundProject(plan, northOf(lat, D), lon);
    const ringNorth = ringPixel(fit, 0, D);
    expect(north.y).toBeLessThan(origin.y);
    expect(ringNorth.y).toBeLessThan(origin.y);
    expect(Math.abs(north.y - ringNorth.y) / Math.abs(origin.y - ringNorth.y)).toBeLessThan(TOL);

    const east = groundProject(plan, lat, eastOf(lat, lon, D));
    const ringEast = ringPixel(fit, D, 0);
    expect(east.x).toBeGreaterThan(origin.x);
    expect(Math.abs(east.x - ringEast.x) / Math.abs(origin.x - ringEast.x)).toBeLessThan(TOL);

    return plan;
  };

  it("a one foot displacement spans the same viewBox distance as one foot of the ring, at Bastrop", () => {
    const plan = check(ANCHOR.lat, ANCHOR.lon, GOLD_RING);
    expect(plan.z).toBe(GROUND_ZOOM_MAX);
  });

  it("and at 59.9 degrees, where cos(latitude) is materially different", () => {
    /* synthetic anchor: cos falls from about 0.865 to about 0.501, so a fixed
     * cosine or a dropped one cannot satisfy both latitudes */
    expect(Math.cos(rad(59.9)) / Math.cos(rad(ANCHOR.lat))).toBeLessThan(0.6);
    check(59.9, 10.75, GOLD_RING);
  });

  it("one tile spans the ground width metresPerPixel predicts for it", () => {
    const plan = planFor(GOLD_RING, ANCHOR);
    const tile = plan.tiles[0];
    if (!tile) throw new Error("no tiles");
    const fit = plan.fit;
    const tileFeet = (GROUND_TILE_PX * plan.metresPerPixel) / SURVEY_FOOT_M;
    expect(tile.size).toBeCloseTo(tileFeet * fit.s, 6);
    /* and that width is a real number of feet for a level 19 aerial tile */
    expect(tileFeet).toBeGreaterThan(180);
    expect(tileFeet).toBeLessThan(260);
  });

  it("pixelsPerFoot is metres per foot over metres per pixel at the SAME latitude and zoom", () => {
    for (const lat of [ANCHOR.lat, 59.9, 0]) {
      for (const z of [14, 17, 19]) {
        expect(groundPixelsPerFoot(lat, z)).toBeCloseTo(SURVEY_FOOT_M / groundMetresPerPixel(lat, z), 12);
      }
    }
  });
});

describe("M-2 zoom selection", () => {
  const ringOfExtent = (feet: number): RingPt[] => {
    const h = feet / 2;
    return [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h },
    ];
  };

  it("picks the coarsest level meeting the supersample target, and nothing coarser would do", () => {
    for (const extent of [400, 1500, 6000, 25000]) {
      const fit = ringFit(ringOfExtent(extent));
      if (!fit) throw new Error("no fit");
      const z = groundZoomFor(ANCHOR.lat, fit.s);
      const want = fit.s * GROUND_SUPERSAMPLE;
      expect(groundPixelsPerFoot(ANCHOR.lat, z), `z=${z} extent=${extent}`).toBeGreaterThanOrEqual(want);
      if (z > GROUND_ZOOM_MIN) {
        expect(groundPixelsPerFoot(ANCHOR.lat, z - 1), `z-1 extent=${extent}`).toBeLessThan(want);
      }
    }
  });

  it("a bigger parcel takes a coarser level", () => {
    const z = (feet: number) => {
      const fit = ringFit(ringOfExtent(feet));
      if (!fit) throw new Error("no fit");
      return groundZoomFor(ANCHOR.lat, fit.s);
    };
    expect(z(100)).toBeGreaterThan(z(25000));
    expect(z(100)).toBe(GROUND_ZOOM_MAX);
  });

  it("clamps at the published maximum rather than asking for a level that answers with a placeholder", () => {
    const fit = ringFit(ringOfExtent(20));
    if (!fit) throw new Error("no fit");
    expect(groundZoomFor(ANCHOR.lat, fit.s)).toBe(GROUND_ZOOM_MAX);
    expect(groundPixelsPerFoot(ANCHOR.lat, GROUND_ZOOM_MAX)).toBeLessThan(fit.s * GROUND_SUPERSAMPLE);
  });

  it("clamps at the minimum for a ring far larger than any parcel", () => {
    const fit = ringFit(ringOfExtent(400000));
    if (!fit) throw new Error("no fit");
    expect(groundZoomFor(ANCHOR.lat, fit.s)).toBe(GROUND_ZOOM_MIN);
  });

  it("refuses a mosaic over the cap rather than painting it", () => {
    const out = groundPlan(ringOfExtent(400000), ANCHOR, OK);
    expect(out.plan).toBeNull();
    expect(out.reason).toBe("ground_tile_cap");
  });

  it("a real parcel needs a small mosaic", () => {
    const plan = planFor(GOLD_RING, ANCHOR);
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.tiles.length).toBeLessThanOrEqual(GROUND_MAX_TILES);
    expect(plan.tiles.length).toBeLessThanOrEqual(16);
  });

  it("every tile in the mosaic is a distinct id and covers the viewBox", () => {
    const plan = planFor(GOLD_RING, ANCHOR);
    const ids = plan.tiles.map((t) => `${t.z}/${t.y}/${t.x}`);
    expect(new Set(ids).size).toBe(ids.length);
    const left = Math.min(...plan.tiles.map((t) => t.left));
    const top = Math.min(...plan.tiles.map((t) => t.top));
    const right = Math.max(...plan.tiles.map((t) => t.left + t.size));
    const bottom = Math.max(...plan.tiles.map((t) => t.top + t.size));
    expect(left).toBeLessThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(plan.fit.w);
    expect(bottom).toBeGreaterThanOrEqual(plan.fit.h);
  });
});

describe("M-2 fail closed: no anchor is no ground", () => {
  const model = (anchor?: PanelAnchor, read?: PanelAnchorRead) => ({
    ring: GOLD_RING,
    edges: [],
    overlays: [],
    parcelNodeId: "48021:31254",
    label: "908 PINE , BASTROP, TX 78602",
    anchor,
    anchorRead: read,
  });

  const VOID = renderParcelDraw(model());

  it("the no anchor rendering is today's rendering: no wrapper, no note, no tile", () => {
    expect(VOID).not.toContain("gwrap");
    expect(VOID).not.toContain("<img");
    expect(VOID).not.toContain("arcgisonline");
    expect(VOID).not.toContain("data-tile");
    expect(VOID).toContain(ringSvg(GOLD_RING, [], { zoning: null, flood: null, frame: null }));
  });

  it("absent, error and skipped each paint the void ground, byte for byte", () => {
    for (const status of ["absent", "error", "skipped"] as const) {
      const html = renderParcelDraw(model(undefined, { status, reason: "whatever" }));
      expect(html, status).toBe(VOID);
      const out = groundPlan(GOLD_RING, undefined, { status, reason: "whatever" });
      expect(out.plan, status).toBeNull();
      expect(out.reason, status).toBe(`ground_anchor_${status}`);
    }
  });

  /*
   * The parse layer already drops a coordinate that arrives under a non ok read,
   * so a plan handed a good anchor with a bad read is a state the wire cannot
   * reach today. It is asserted anyway, and asserted on behaviour rather than on
   * a reason string, because the read guard is the thing that must fail closed
   * and a defence that is only reachable through another defence is untested.
   */
  it("a perfectly good coordinate under a non ok read paints nothing", () => {
    for (const status of ["absent", "error", "skipped"] as const) {
      const out = groundPlan(GOLD_RING, ANCHOR, { status, reason: "whatever" });
      expect(out.plan, status).toBeNull();
      const html = renderParcelDraw(model(ANCHOR, { status, reason: "whatever" }));
      expect(html, status).toBe(VOID);
      expect(html, status).not.toContain("arcgisonline");
    }
  });

  it("a status of ok carrying no coordinate is still no ground", () => {
    expect(renderParcelDraw(model(undefined, OK))).toBe(VOID);
    expect(groundPlan(GOLD_RING, undefined, OK).reason).toBe("ground_anchor_missing");
  });

  it("a zero, non finite or off world coordinate is a sentinel, not a location", () => {
    const bad: PanelAnchor[] = [
      { lat: 0, lon: -97.32528, precision: null, source: null },
      { lat: 30.10592, lon: 0, precision: null, source: null },
      { lat: Number.NaN, lon: -97.32528, precision: null, source: null },
      { lat: 30.10592, lon: Number.POSITIVE_INFINITY, precision: null, source: null },
    ];
    for (const a of bad) {
      expect(groundPlan(GOLD_RING, a, OK).plan, JSON.stringify(a)).toBeNull();
      expect(renderParcelDraw(model(a, OK))).toBe(VOID);
    }
    const polar: PanelAnchor = { lat: 89, lon: 10, precision: null, source: null };
    expect(groundPlan(GOLD_RING, polar, OK).reason).toBe("ground_anchor_off_world");
  });

  it("no ring is no ground even with a good anchor", () => {
    const out = groundPlan([{ x: 0, y: 0 }], ANCHOR, OK);
    expect(out.plan).toBeNull();
    expect(out.reason).toBe("ground_no_ring");
    expect(renderParcelDraw({ ring: [], edges: [], overlays: [], anchor: ANCHOR, anchorRead: OK })).not.toContain("gwrap");
  });

  it("a missing anchorRead is unread, not ok", () => {
    expect(groundPlan(GOLD_RING, ANCHOR, null).reason).toBe("ground_anchor_unread");
    expect(groundPlan(GOLD_RING, ANCHOR, undefined).plan).toBeNull();
  });
});

describe("M-2 the painted ground", () => {
  const model = {
    ring: GOLD_RING,
    edges: [
      { i: 0, role: "rear", seg: [0, 1] as [number, number], ft: 98.98, adjacency: "alley", roadNode: "48021:road:925036023", roadClass: "alley" },
      { i: 1, role: "side", seg: [1, 2] as [number, number], ft: 167.99, adjacency: "neighbor-parcel", neighbor: "48021:34169" },
      { i: 2, role: "front", seg: [2, 3] as [number, number], ft: 99.92, adjacency: "ROW", roadNode: "48021:road:15113284", roadClass: "local", neighbor: "48021:34121" },
    ],
    overlays: [{ id: "flood", state: "present", label: "Zone AE FLOODWAY", sfha: true, draw: "tint-ring" }],
    parcelNodeId: "48021:31254",
    label: "908 PINE , BASTROP, TX 78602",
    zoning: { v: "SF-1", jurisdiction: "City of Bastrop", state: "present", url: null },
    frame: { units: "ft", quality: "gis-approximate" },
    anchor: ANCHOR,
    anchorRead: OK,
  };

  const on = renderParcelDraw(model);
  const off = renderParcelDraw(model, false);
  const plan = planFor(GOLD_RING, ANCHOR);

  it("paints one img per planned tile, each at the planned place", () => {
    const imgs = on.match(/<img class="gt"/g) ?? [];
    expect(imgs).toHaveLength(plan.tiles.length);
    for (const t of plan.tiles) {
      expect(on).toContain(`data-tile="${t.z}/${t.y}/${t.x}"`);
      expect(on).toContain(`src="${t.url}"`);
    }
    expect(on).toContain(`data-ground-z="${plan.z}"`);
    expect(on).toContain(`data-ground-tiles="${plan.tiles.length}"`);
    expect(on).toContain('data-ground="on"');
  });

  it("the layer html is the plan's own placement, in percentages of the same box", () => {
    const layer = groundLayerHtml(plan);
    const t = plan.tiles[0];
    if (!t) throw new Error("no tiles");
    expect(layer).toContain(`left:${((t.left / plan.fit.w) * 100).toFixed(4)}%`);
    expect(layer).toContain(`top:${((t.top / plan.fit.h) * 100).toFixed(4)}%`);
    expect(layer).toContain(`width:${((t.size / plan.fit.w) * 100).toFixed(4)}%`);
  });

  it("names its source and states the vintage as unknown, implying no capture date", () => {
    expect(on).toContain(GROUND_SOURCE_LABEL);
    expect(on).toContain(GROUND_VINTAGE_NOTE);
    expect(on).not.toMatch(/\b(19|20)\d\d\b/);
  });

  it("carries a toggle that reads its own state", () => {
    expect(on).toContain('data-act="ground"');
    expect(on).toContain('data-ground-on="1"');
    expect(on).toContain(GROUND_TOGGLE_LABEL);
    expect(off).toContain('data-ground-on="0"');
    expect(off).toContain('data-ground="off"');
  });

  it("off removes every tile from the html rather than hiding it, and keeps the way back", () => {
    expect(off).not.toContain("<img");
    expect(off).not.toContain("arcgisonline");
    expect(off).not.toContain("data-tile");
    expect(off).toContain('data-act="ground"');
    expect(off).toContain(GROUND_SOURCE_LABEL);
  });

  it("the drawing on top is byte identical to the drawing with no ground", () => {
    const svg = ringSvg(model.ring, model.edges, {
      zoning: model.zoning,
      flood: model.overlays[0] ?? null,
      frame: model.frame,
    });
    expect(svg.length).toBeGreaterThan(200);
    expect(on).toContain(svg);
    expect(off).toContain(svg);
    /* and the ground sits BEHIND it */
    expect(on.indexOf('<div class="ground"')).toBeLessThan(on.indexOf("<svg"));
  });

  it("every drawing behavior the ground sits under still paints", () => {
    for (const marker of [
      'data-edge="0"',
      'data-edge="1"',
      'data-edge="2"',
      "stroke-dasharray",
      'data-zone-family="residential"',
      'data-zoning="SF-1"',
      'data-flood-tint="heavy"',
      'data-north="up"',
      "data-scale-ft=",
      "unit reference",
      'data-tip="1"',
      "frame gis-approximate",
    ]) {
      expect(on, marker).toContain(marker);
      expect(off, marker).toContain(marker);
    }
  });

  it("the ROW door suppression the drawing hovers on is untouched", () => {
    const row = model.edges[2];
    if (!row) throw new Error("no ROW edge");
    /* the neighbor across a right of way is named and gets NO door */
    const tip = edgeTipHtml(row, 2);
    expect(tip).toContain(ACROSS_ROW);
    expect(tip).toContain("48021:34121");
    expect(tip).not.toContain('data-act="addscreen"');
    expect(edgeDoor(row)).toBeNull();
    /* an adjoining neighbor does get one */
    const neighbor = model.edges[1];
    if (!neighbor) throw new Error("no neighbor edge");
    const nTip = edgeTipHtml(neighbor, 1);
    expect(nTip).toContain("48021:34169");
    expect(nTip).toContain('data-act="addscreen"');
  });
});

describe("M-2 reads the wire the M-1 lane writes", () => {
  const body = {
    parcelNodeId: "48021:31254",
    draw: { label: "908 PINE", ring: GOLD_RING.map((p) => [p.x, p.y]), edges: [], overlays: [], frame: { units: "ft", origin: "centroid", yAxis: "true-north", factor: "us-survey-foot", quality: "gis-approximate" } },
  };

  it("takes the anchor from the producer's own attach path", () => {
    const facets = JSON.stringify({ cityLimitsFact: { queryPoint: { longitude: ANCHOR.lon, latitude: ANCHOR.lat } } });
    const outcome = anchorFromFacetsBody(facets);
    expect(outcome.anchorRead.status).toBe("ok");
    const wire = attachAnchorToResponseText(JSON.stringify(body), outcome);
    const model = parseToolResult(wire);
    expect(model.anchorRead).toEqual({ status: "ok", reason: null });
    expect(model.anchor?.lat).toBe(ANCHOR.lat);
    expect(model.anchor?.lon).toBe(ANCHOR.lon);
    expect(model.anchor?.precision).toBe("1e-5-deg");
    expect(model.anchor?.source).toBe("bake-latlng-index");
    expect(renderParcelDraw(model)).toContain("arcgisonline");
  });

  it("a skipped read from the producer paints no ground", () => {
    const wire = attachAnchorToResponseText(JSON.stringify(body), {
      anchorRead: { status: "skipped", reason: "anchor_read_batch_cap", cap: 1, received: 3 },
    });
    const model = parseToolResult(wire);
    expect(model.anchorRead?.status).toBe("skipped");
    expect(model.anchor).toBeUndefined();
    expect(renderParcelDraw(model)).not.toContain("arcgisonline");
  });

  it("anchorRead is an object; a bare string is no declaration at all", () => {
    const model = parseToolResult(JSON.stringify({ ...body, anchorRead: "ok", anchor: { lat: ANCHOR.lat, lon: ANCHOR.lon } }));
    expect(model.anchorRead).toBeUndefined();
    expect(model.anchor).toBeUndefined();
    expect(renderParcelDraw(model)).not.toContain("<img");
  });

  it("a status outside the union is no declaration, and a coordinate under it is dropped", () => {
    const model = parseToolResult(
      JSON.stringify({ ...body, anchorRead: { status: "fine" }, anchor: { lat: ANCHOR.lat, lon: ANCHOR.lon } }),
    );
    expect(model.anchorRead).toBeUndefined();
    expect(model.anchor).toBeUndefined();
  });

  it("a coordinate under a non ok status is dropped", () => {
    const model = parseToolResult(
      JSON.stringify({ ...body, anchorRead: { status: "error", reason: "anchor_read_timeout" }, anchor: { lat: ANCHOR.lat, lon: ANCHOR.lon } }),
    );
    expect(model.anchorRead).toEqual({ status: "error", reason: "anchor_read_timeout" });
    expect(model.anchor).toBeUndefined();
    expect(renderParcelDraw(model)).not.toContain("arcgisonline");
  });
});

describe("M-2 the served page", () => {
  const html = buildAppHtml();

  it("passes the standing contract, and tile img elements do not trip direct_network", () => {
    expect(htmlContractViolations(html)).toEqual([]);
    expect(html).toContain("<img");
    expect(html).toContain(GROUND_TILE_URL_TEMPLATE);
  });

  it("the ground rules fire on violated copies", () => {
    expect(htmlContractViolations(html.replace(/data-act="ground"/g, 'data-act="aerial"'))).toContain("ground_unbound");
    expect(htmlContractViolations(html.replace(/function toggleGround/g, "function flipGround"))).toContain("ground_unbound");
    expect(htmlContractViolations(html.split(GROUND_VINTAGE_NOTE).join("flown 2024"))).toContain("ground_unbound");
    const transposed = html.split("/tile/{z}/{y}/{x}").join("/tile/{z}/{x}/{y}");
    expect(transposed).not.toBe(html);
    expect(htmlContractViolations(transposed)).toContain("ground_tile_axis_transposed");
  });

  it("embeds the ground helpers by source, not by hand", () => {
    for (const name of ["function groundPlan", "function groundWrapHtml", "function groundLayerHtml", "function ringFit", "function ringPixel"]) {
      expect(html, name).toContain(name);
    }
    /* the served scope gets the same constants the tested helpers read */
    expect(html).toContain(`var US_SURVEY_FOOT_M=${JSON.stringify(US_SURVEY_FOOT_M)}`);
    expect(html).toContain(`var GROUND_EQUATOR_MPP=${JSON.stringify(GROUND_EQUATOR_MPP)}`);
    expect(html).toContain(`var GROUND_ZOOM_MAX=${GROUND_ZOOM_MAX}`);
  });

  it("resets the ground on every accepted result and never reads it from anywhere else", () => {
    expect(html).toContain("var groundOn=true;");
    expect(html).toContain("groundOn=true;\n    sortKey");
    expect(html).toContain("groundOn=!groundOn;");
  });

  it("declares the imagery origin as a resource domain, derived from the template", async () => {
    let boardMeta: Record<string, unknown> | undefined;
    const server = {
      registerResource: (
        _name: string,
        uri: string,
        _config: Record<string, unknown>,
        handler: (u: { href: string }) => Promise<{ contents: Array<{ _meta?: Record<string, unknown> }> }>,
      ) => {
        void handler({ href: uri }).then((r) => {
          if (uri.includes("app-")) boardMeta = r.contents[0]?._meta;
        });
      },
    };
    registerMcpApp(server);
    await new Promise((r) => setTimeout(r, 0));
    const ui = (boardMeta as { ui?: { csp?: { resourceDomains?: string[] } } })?.ui;
    expect(ui?.csp?.resourceDomains).toContain(new URL(GROUND_TILE_URL_TEMPLATE).origin);
  });
});
