/**
 * P-91 v3 M-4: more than one parcel on one canvas.
 *
 * Two derivations everywhere it is possible. The composition is checked against
 * a SECOND expression of Web Mercator written here in degrees (PI*R/180 metres
 * per degree of latitude, that times cos(lat) for longitude), where the module
 * goes through tile pixels (2*PI*R/256 at zoom 0). Those two share a sphere and
 * nothing else, so agreement between them is a check and not a restatement.
 * The relative order of two parcels is checked a second way, against RECORDED
 * coordinates whose north-south and east-west relation needs no arithmetic at
 * all: one parcel is simply at a lower latitude than the other.
 *
 * Coordinates. 48021:34137 sits at 30.11021, -97.31631 approximately, from a
 * live read on 2026-08-30. 48021:31254, 48021:49295 and 48021:82112 carry the
 * coordinates the M-1 lane recorded from deployed cortex the same day.
 * The two same-block neighbour anchors (48021:34169 west, 48021:34161 east) are
 * SYNTHETIC: they are constructed one recorded lot width off 34137 using that
 * parcel's own recorded ring, so the fixture is internally consistent with the
 * geometry it is drawn from. They are test inputs, never parcel facts, and no
 * assertion here claims any number is true of Bastrop. What is asserted is that
 * a parcel placed N feet east lands N feet east.
 */
import { describe, expect, it } from "vitest";
import {
  GROUND_TILE_ORIGIN,
  MULTI_ANCHORS_NOT_READ,
  MULTI_ANCHORS_READ,
  MULTI_DRAWN_TITLE,
  MULTI_GROUND_EXTENT_REASON,
  MULTI_GROUND_MAX_EXTENT_FT,
  MULTI_LABEL_CHAR_W,
  MULTI_LABEL_H,
  MULTI_LABEL_MAX_PUSH,
  MULTI_LABEL_STEP,
  MULTI_MIN_DRAWN,
  MULTI_NO_ANCHOR,
  MULTI_NO_CANVAS,
  MULTI_NO_RING,
  MULTI_OFF_CANVAS_TITLE,
  MULTI_TOO_FEW_REASON,
  MULTI_UNDRAWN_TITLE,
  NOT_RETURNED,
  buildAppHtml,
  groundVbFromWorld,
  groundWorldPixel,
  htmlContractViolations,
  multiCanvasSvg,
  multiDrawableCount,
  multiNoCanvasWords,
  multiParcelPlan,
  offCanvasHtml,
  offCanvasParcels,
  parseToolResult,
  renderParcelDraw,
  renderParcelSet,
  resolveLabelPositions,
  ringPixel,
  type MultiPlan,
  type PanelParcel,
  type PlacedParcel,
  type RingFit,
} from "../src/mcp-app.js";
import { ANCHOR_BATCH_READ_CAP } from "../src/parcel-anchor.js";

/* The recorded ring for 48021:34137: about 98.97 ft wide, 168.22 ft deep. */
const GOLD_RING: Array<[number, number]> = [
  [48.6, 83.94],
  [-50.37, 83.7],
  [-49.07, -84.28],
  [50.84, -83.36],
];
/** 98.97, the recorded east-west span of that ring. One lot width. */
const LOT_W = 48.6 - -50.37;
const FRAME = {
  units: "ft",
  origin: "centroid",
  yAxis: "true-north",
  factor: "us-survey-foot",
  quality: "gis-approximate",
};

/*
 * The second expression of Web Mercator. R is the EPSG:3857 sphere radius, so
 * one degree of latitude is PI*R/180 metres of GROUND distance and one degree
 * of longitude is that times cos(lat). The module under test uses neither
 * constant; it goes through 2*PI*R/256 metres per tile pixel.
 */
const SPHERE_R = 6378137;
const DEG_M = (Math.PI * SPHERE_R) / 180;
const FT_M = 1200 / 3937;
function eastOf(lat: number, lon: number, ft: number): number {
  return lon + (ft * FT_M) / (DEG_M * Math.cos((lat * Math.PI) / 180));
}

/* Live read 2026-08-30, approximate to five places. */
const CENTRE = { id: "48021:34137", lat: 30.11021, lon: -97.31631 };
/* SYNTHETIC, one recorded lot width west and east of CENTRE. Not parcel facts. */
const WEST = { id: "48021:34169", lat: CENTRE.lat, lon: eastOf(CENTRE.lat, CENTRE.lon, -LOT_W) };
const EAST = { id: "48021:34161", lat: CENTRE.lat, lon: eastOf(CENTRE.lat, CENTRE.lon, LOT_W) };
/* Recorded by the M-1 lane from deployed cortex 2026-08-30. */
const REC_31254 = { id: "48021:31254", lat: 30.10592, lon: -97.32528 };
const REC_49295 = { id: "48021:49295", lat: 30.11473, lon: -97.33348 };
const REC_82112 = { id: "48021:82112", lat: 30.12288, lon: -97.31907 };

type Coord = { id: string; lat: number; lon: number };

function drawOf(label: string, ring: Array<[number, number]> = GOLD_RING): Record<string, unknown> {
  return { label: label, frame: FRAME, ring: ring, edges: [], overlays: [] };
}

const NO_RING_DRAW = { label: "no ring here", frame: FRAME, ring: [], edges: [], overlays: [] };

/** One row of a node-depth array body, as the M-4 wire carries it. */
function row(c: Coord, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parcelNodeId: c.id,
    brief: { sections: [] },
    draw: drawOf(c.id + " label"),
    anchor: { lat: c.lat, lon: c.lon, precision: "1e-5-deg", source: "bake-latlng-index" },
    anchorRead: { status: "ok" },
    ...over,
  };
}

function body(rows: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ parcels: rows, notFound: [], ...over });
}

function planOf(rows: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): MultiPlan {
  const model = parseToolResult(body(rows, over));
  expect(model.kind).toBe("parcels");
  const outcome = multiParcelPlan(model.parcels ?? []);
  expect(outcome.reason).toBeNull();
  expect(outcome.multi).not.toBeNull();
  return outcome.multi as MultiPlan;
}

function placedFor(m: MultiPlan, id: string): PlacedParcel {
  const hit = m.placed.find((p) => p.parcelNodeId === id);
  if (!hit) throw new Error(id + " is not on the canvas");
  return hit;
}

function reasonFor(m: MultiPlan, id: string): string {
  const hit = m.undrawn.find((u) => u.parcelNodeId === id);
  if (!hit) throw new Error(id + " is not named beside the canvas");
  return hit.reason;
}

/** viewBox units back to feet, through the set's own fit. */
function ftOf(m: MultiPlan, vb: number): number {
  return vb / m.fit.s;
}

describe("M-4 composition: two parcels land in correct relative position", () => {
  it("three same-block parcels sit one lot apart, west to east, on one line", () => {
    const m = planOf([row(WEST), row(CENTRE), row(EAST)]);
    expect(m.placed).toHaveLength(3);
    expect(m.undrawn).toHaveLength(0);
    const w = placedFor(m, WEST.id);
    const c = placedFor(m, CENTRE.id);
    const e = placedFor(m, EAST.id);
    expect(w.at.x).toBeLessThan(c.at.x);
    expect(c.at.x).toBeLessThan(e.at.x);
    /* the separation the degree formula put in, read back through tile pixels */
    expect(ftOf(m, c.at.x - w.at.x)).toBeCloseTo(LOT_W, 2);
    expect(ftOf(m, e.at.x - c.at.x)).toBeCloseTo(LOT_W, 2);
    /* same latitude, so one line: no drift out of the projection */
    expect(w.at.y).toBeCloseTo(c.at.y, 6);
    expect(e.at.y).toBeCloseTo(c.at.y, 6);
  });

  it("adjacent lots abut rather than overlap", () => {
    const m = planOf([row(WEST), row(CENTRE)]);
    const w = placedFor(m, WEST.id);
    const c = placedFor(m, CENTRE.id);
    const wRight = Math.max.apply(null, w.vb.map((p) => p.x));
    const cLeft = Math.min.apply(null, c.vb.map((p) => p.x));
    /* Anchors are LOT_W apart and the recorded ring spans LOT_W, so the rings
     * meet within the ring's own slack (its widest and narrowest rows differ by
     * about 2 ft). A dropped offset overlaps by a whole lot; a doubled one
     * leaves a lot of daylight. */
    expect(ftOf(m, cLeft - wRight)).toBeGreaterThan(-2.5);
    expect(ftOf(m, cLeft - wRight)).toBeLessThan(2.5);
  });

  it("recorded coordinates alone fix both axes: south is lower, west is left", () => {
    /* No arithmetic in this check. 31254 is at a lower latitude and a lower
     * longitude than 34137, so it lands below and to the left. Screen y grows
     * downward, so south is the LARGER y. */
    const m = planOf([row(CENTRE), row(REC_31254)]);
    const centre = placedFor(m, CENTRE.id);
    const south = placedFor(m, REC_31254.id);
    expect(REC_31254.lat).toBeLessThan(CENTRE.lat);
    expect(REC_31254.lon).toBeLessThan(CENTRE.lon);
    expect(south.at.y).toBeGreaterThan(centre.at.y);
    expect(south.at.x).toBeLessThan(centre.at.x);
  });

  it("a ring's own north vertex is above its own south vertex", () => {
    const m = planOf([row(WEST), row(CENTRE)]);
    const c = placedFor(m, CENTRE.id);
    /* GOLD_RING vertex 0 is the north-east corner, vertex 2 the south-west. */
    expect(c.vb[0]!.y).toBeLessThan(c.vb[2]!.y);
  });

  it("a recorded parcel to the NORTH lands above, a second time and on other ids", () => {
    /* 82112 is at a higher latitude than 34137. Redundant with the check above
     * on purpose: the north inversion had exactly one catcher in the mutation
     * table, and one catcher is one edit away from none. */
    const m = planOf([row(CENTRE), row(REC_82112)]);
    expect(REC_82112.lat).toBeGreaterThan(CENTRE.lat);
    expect(placedFor(m, REC_82112.id).at.y).toBeLessThan(placedFor(m, CENTRE.id).at.y);
  });

  it("a ring is drawn at ITS OWN latitude's Mercator scale, not the reference's", () => {
    /* HIGH_LAT is a synthetic, deliberately non-Texas coordinate. Its only job
     * is to make the per-parcel scale correction measurable: at these
     * separations it is one part in ten million and nothing could see it.
     *
     * On a Mercator canvas a fixed ground length occupies map distance
     * proportional to 1/cos(lat), so the same ring at latitude 60 must be drawn
     * cos(30.11)/cos(60) times wider than at 34137's latitude, or it will not
     * register with the imagery under it. The expected ratio is computed here
     * from cosines and nowhere near the module's tile-pixel path. */
    const HIGH_LAT = { id: "48021:34137", lat: 60, lon: CENTRE.lon };
    const m = planOf([row(CENTRE), { ...row(HIGH_LAT), parcelNodeId: "99999:60N" }]);
    const ref = placedFor(m, CENTRE.id);
    const high = placedFor(m, "99999:60N");
    const widthOf = (p: PlacedParcel) =>
      Math.max.apply(null, p.vb.map((q) => q.x)) - Math.min.apply(null, p.vb.map((q) => q.x));
    const expected =
      Math.cos((CENTRE.lat * Math.PI) / 180) / Math.cos((HIGH_LAT.lat * Math.PI) / 180);
    expect(widthOf(high) / widthOf(ref)).toBeCloseTo(expected, 6);
    expect(expected).toBeGreaterThan(1.7);
  });

  it("the ground registers with the rings: one fit, two callers, one answer", () => {
    const m = planOf([row(WEST), row(CENTRE), row(EAST)]);
    expect(m.ground).not.toBeNull();
    const g = m.ground!;
    /* The reference anchor placed by the RING path equals the same anchor
     * placed by the GROUND path. If those diverge the imagery slides under the
     * drawing, which looks fine and is a lie. */
    const viaRing = ringPixel(m.fit, 0, 0);
    expect(g.anchorPx.x).toBeCloseTo(viaRing.x, 9);
    expect(g.anchorPx.y).toBeCloseTo(viaRing.y, 9);
    /* And an outlying parcel's anchor, projected through the ground, lands where
     * the ring path placed it. */
    const e = placedFor(m, EAST.id);
    const w = groundWorldPixel(EAST.lat, EAST.lon, g.z);
    const viaGround = groundVbFromWorld(g, w.wx, w.wy);
    expect(viaGround.x).toBeCloseTo(e.at.x, 6);
    expect(viaGround.y).toBeCloseTo(e.at.y, 6);
  });

  it("the canvas paints one polygon, one hit area and one label per drawn parcel", () => {
    const m = planOf([row(WEST), row(CENTRE), row(EAST)]);
    const svg = multiCanvasSvg(m);
    expect((svg.match(/class="ring-fill"/g) ?? []).length).toBe(3);
    expect((svg.match(/class="phit"/g) ?? []).length).toBe(3);
    expect((svg.match(/class="plbl"/g) ?? []).length).toBe(3);
    expect(svg).toContain('data-parcels="3"');
    for (const c of [WEST, CENTRE, EAST]) {
      expect(svg).toContain('data-node="' + c.id + '"');
      expect(svg).toContain('data-parcel="' + c.id + '"');
    }
  });

  it("a click on a parcel drafts the ordinary Open turn and fetches nothing", () => {
    const m = planOf([row(WEST), row(CENTRE)]);
    const svg = multiCanvasSvg(m);
    expect(svg).toContain('onclick="window.__ss&&window.__ss.open(this)"');
    expect(svg).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
  });
});

describe("M-4 item 4 (P-91 v3 operator walk): colliding labels are pushed apart, never merged or dropped", () => {
  /* A flat, unit-scale fit: viewBox units equal the numbers below one-to-one,
   * so a distance in this fixture is a distance in the SVG, no ringFit math
   * needed to reason about it. */
  const fit: RingFit = { w: 320, h: 220, pad: 28, s: 1, ox: 0, oy: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };

  function placedAt(id: string, x: number, y: number): PlacedParcel {
    return { parcelNodeId: id, label: id + " label", vb: [], at: { x, y } };
  }

  it("48021:34169 and 48021:34137 (the operator's own pair) close enough to garble are pushed apart on y, never on x", () => {
    // The reported symptom: two labels rendered as "48021:34169021:34137",
    // which is what these two 11-character labels look like concatenated
    // with no gap -- exactly what a shared baseline this close produces.
    const a = placedAt("48021:34169", 100, 100);
    const b = placedAt("48021:34137", 110, 100);
    const out = resolveLabelPositions([a, b], fit);
    expect(out[0]).toEqual({ x: 100, y: 100 });
    expect(out[1]!.x).toBe(110);
    expect(out[1]!.y).toBeGreaterThan(100);
    expect(out[1]!.y - 100).toBeGreaterThanOrEqual(MULTI_LABEL_STEP);
  });

  it("labels far enough apart are left exactly where they were: no needless movement", () => {
    const a = placedAt("48021:34169", 40, 100);
    const b = placedAt("48021:34137", 280, 100);
    const out = resolveLabelPositions([a, b], fit);
    expect(out[0]).toEqual({ x: 40, y: 100 });
    expect(out[1]).toEqual({ x: 280, y: 100 });
  });

  it("a chain of three mutually-colliding labels stacks into three distinct, non-overlapping rows", () => {
    const rows = [placedAt("48021:1", 100, 100), placedAt("48021:2", 105, 100), placedAt("48021:3", 95, 100)];
    const out = resolveLabelPositions(rows, fit);
    const ys = out.map((p) => p.y);
    expect(new Set(ys).size).toBe(3);
    expect(ys[0]).toBe(100);
    expect(ys[1]!).toBeGreaterThan(ys[0]!);
    expect(ys[2]!).toBeGreaterThan(ys[1]!);
  });

  it("every input parcel still gets a label: none is ever dropped to resolve a collision", () => {
    const rows: PlacedParcel[] = [];
    for (let i = 0; i < 15; i++) rows.push(placedAt("48021:" + i, 160, 100));
    const out = resolveLabelPositions(rows, fit);
    expect(out).toHaveLength(rows.length);
  });

  it("falsifier: a crowd stays inside the viewBox even when the push bound is hit -- no label pushed off the bottom", () => {
    const rows: PlacedParcel[] = [];
    for (let i = 0; i < 15; i++) rows.push(placedAt("48021:" + i, 160, 100));
    const out = resolveLabelPositions(rows, fit);
    for (const p of out) {
      expect(p.y).toBeLessThanOrEqual(fit.h - fit.pad);
    }
    // With the bound this tight, some pair in a crowd this size is expected
    // to still collide once the clamp stops the push -- that is the accepted
    // trade (crowded beats off-canvas), not silently declared solved.
  });

  it("resolveLabelPositions never touches placed[i].at: the true anchor used for the ring and the click target is unchanged", () => {
    const a = placedAt("48021:34169", 100, 100);
    const b = placedAt("48021:34137", 110, 100);
    resolveLabelPositions([a, b], fit);
    expect(a.at).toEqual({ x: 100, y: 100 });
    expect(b.at).toEqual({ x: 110, y: 100 });
  });

  it("multiCanvasSvg draws a leader line and flags data-label-moved only for a label that actually moved", () => {
    const m: MultiPlan = {
      fit,
      extentXFt: 10,
      extentYFt: 10,
      placed: [placedAt("48021:34169", 100, 100), placedAt("48021:34137", 110, 100)],
      undrawn: [],
      ground: null,
      groundReason: "multi_ground_extent",
    };
    const svg = multiCanvasSvg(m);
    expect(svg).toContain('data-label-moved="0"');
    expect(svg).toContain('data-label-moved="1"');
    expect((svg.match(/class="pll"/g) ?? []).length).toBe(1);
    const ys = [...svg.matchAll(/class="plbl"[^>]*\sy="([\d.]+)"/g)].map((mm) => mm[1]);
    expect(ys).toHaveLength(2);
    expect(new Set(ys).size).toBe(2);
    // both full ids still print in full: the fix is a push, never a truncation
    expect(svg).toContain(">48021:34169<");
    expect(svg).toContain(">48021:34137<");
  });

  it("MULTI_LABEL_STEP clears a label box's own height, so one push always resolves a two-way collision", () => {
    expect(MULTI_LABEL_STEP).toBeGreaterThan(MULTI_LABEL_H);
    expect(MULTI_LABEL_CHAR_W).toBeGreaterThan(0);
    expect(MULTI_LABEL_MAX_PUSH).toBeGreaterThan(0);
  });
});

describe("M-4 honesty: a parcel that cannot be drawn is named, never omitted", () => {
  it("an anchor with no ring is named with the ring reason", () => {
    const m = planOf([row(WEST), row(EAST), row(CENTRE, { draw: NO_RING_DRAW })]);
    expect(m.placed.map((p) => p.parcelNodeId)).toEqual([WEST.id, EAST.id]);
    expect(reasonFor(m, CENTRE.id)).toBe(MULTI_NO_RING);
  });

  it("a ring with no anchor is named with the read the wire declared", () => {
    const noAnchor = row(CENTRE, {
      anchor: undefined,
      anchorRead: { status: "error", reason: "anchor_read_timeout" },
    });
    const m = planOf([row(WEST), row(EAST), noAnchor]);
    expect(m.placed).toHaveLength(2);
    expect(reasonFor(m, CENTRE.id)).toBe(MULTI_NO_ANCHOR + " (error: anchor_read_timeout)");
  });

  it("a row with neither is named for BOTH absences, because one hides the other", () => {
    const neither = row(CENTRE, {
      draw: NO_RING_DRAW,
      anchor: undefined,
      anchorRead: { status: "absent", reason: "city_limits_fact_absent" },
    });
    const m = planOf([row(WEST), row(EAST), neither]);
    const why = reasonFor(m, CENTRE.id);
    expect(why).toContain(MULTI_NO_RING);
    expect(why).toContain(MULTI_NO_ANCHOR);
    expect(why).toContain("city_limits_fact_absent");
  });

  it("a row with no anchorRead says so, rather than reading as a measured absence", () => {
    const undeclared = row(CENTRE, { anchor: undefined, anchorRead: undefined });
    const m = planOf([row(WEST), row(EAST), undeclared]);
    expect(reasonFor(m, CENTRE.id)).toContain("no anchor read on the wire");
  });

  it("a mixed batch names every failure separately and still draws the ones that read", () => {
    const m = planOf([
      row(WEST),
      row(CENTRE),
      row(EAST, { anchor: undefined, anchorRead: { status: "error", reason: "anchor_upstream_non_ok" } }),
      row(REC_31254, { anchor: undefined, anchorRead: { status: "absent", reason: "query_point_zero_sentinel" } }),
      row(REC_49295, { anchor: undefined, anchorRead: { status: "skipped", reason: "anchor_read_batch_cap" } }),
    ]);
    expect(m.placed.map((p) => p.parcelNodeId)).toEqual([WEST.id, CENTRE.id]);
    expect(m.undrawn.map((u) => u.parcelNodeId)).toEqual([EAST.id, REC_31254.id, REC_49295.id]);
    expect(reasonFor(m, EAST.id)).toContain("anchor_upstream_non_ok");
    expect(reasonFor(m, REC_31254.id)).toContain("query_point_zero_sentinel");
    expect(reasonFor(m, REC_49295.id)).toContain("anchor_read_batch_cap");
  });

  it("an id the lookup did not return is named, not dropped with the array", () => {
    const m = planOf([row(WEST), row(CENTRE)], { notFound: ["48021:999999"] });
    expect(reasonFor(m, "48021:999999")).toContain(NOT_RETURNED);
  });

  it("the two lists PARTITION the result: every parcel is drawn or named, exactly once", () => {
    const rows = [
      row(WEST),
      row(CENTRE),
      row(EAST, { anchor: undefined, anchorRead: { status: "error", reason: "anchor_fetch_failed" } }),
      row(REC_31254, { draw: NO_RING_DRAW }),
    ];
    const m = planOf(rows, { notFound: ["48021:404404"] });
    const seen = m.placed
      .map((p) => p.parcelNodeId)
      .concat(m.undrawn.map((u) => u.parcelNodeId));
    expect(seen.slice().sort()).toEqual(
      [WEST.id, CENTRE.id, EAST.id, REC_31254.id, "48021:404404"].slice().sort(),
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("the rendered set names every undrawn parcel in the html, with its reason", () => {
    const rows = [
      row(WEST),
      row(CENTRE),
      row(EAST, { anchor: undefined, anchorRead: { status: "error", reason: "anchor_read_timeout" } }),
    ];
    const model = parseToolResult(body(rows, { notFound: ["48021:404404"] }));
    const html = renderParcelSet(model);
    expect(html).toContain(MULTI_UNDRAWN_TITLE);
    expect(html).toContain('data-undrawn="' + EAST.id + '"');
    expect(html).toContain('data-undrawn="48021:404404"');
    expect(html).toContain("anchor_read_timeout");
    expect(html).toContain(MULTI_DRAWN_TITLE);
    expect(html).toContain('data-drawn="' + WEST.id + '"');
    expect(html).toContain('data-drawn="' + CENTRE.id + '"');
  });
});

describe("M-4 fewer than two drawable: no canvas at all", () => {
  it("one drawable parcel makes no plan, and names the reason", () => {
    const only: PanelParcel = {
      parcelNodeId: CENTRE.id,
      label: "c",
      ring: GOLD_RING.map((p) => ({ x: p[0], y: p[1] })),
      edges: [],
      zoning: null,
      frame: null,
      anchor: { lat: CENTRE.lat, lon: CENTRE.lon, precision: null, source: null },
      anchorRead: { status: "ok", reason: null },
      returned: true,
    };
    const outcome = multiParcelPlan([only]);
    expect(outcome.multi).toBeNull();
    expect(outcome.reason).toBe(MULTI_TOO_FEW_REASON);
    expect(MULTI_MIN_DRAWN).toBe(2);
  });

  it("a batch with one anchored parcel falls back to today's single parcel panel, and now NAMES the other row", () => {
    const rows = [
      row(CENTRE),
      row(EAST, { anchor: undefined, anchorRead: { status: "error", reason: "anchor_read_timeout" } }),
    ];
    const model = parseToolResult(body(rows));
    expect(model.kind).toBe("parcel");
    expect(model.parcelNodeId).toBe(CENTRE.id);
    expect(renderParcelSet(model)).toBe("");
    /* M-5: the drawing itself is still byte identical to the same first parcel
     * with the second row absent. What changed is that the off canvas block is
     * appended after it, so the panel is today's panel PLUS the naming, not a
     * different panel. Two derivations of the same claim: the prefix, and the
     * exact suffix. */
    const alone = parseToolResult(body([row(CENTRE)]));
    const one = renderParcelDraw(alone);
    const two = renderParcelDraw(model);
    expect(two.startsWith(one)).toBe(true);
    expect(two.slice(one.length)).toBe(offCanvasHtml(model));
    expect(two).not.toBe(one);
    expect(two).toContain('data-undrawn="' + EAST.id + '"');
    expect(two).toContain("anchor_read_timeout");
    /* and a genuine single parcel result still says nothing, because nothing
     * was omitted from it */
    expect(offCanvasHtml(alone)).toBe("");
    expect(one).not.toContain(MULTI_OFF_CANVAS_TITLE);
  });

  it("a single id result is untouched: one parcel, with its own ground", () => {
    const single = JSON.stringify({
      parcelNodeId: CENTRE.id,
      draw: drawOf("908 PINE"),
      anchor: { lat: CENTRE.lat, lon: CENTRE.lon, precision: "1e-5-deg", source: "bake-latlng-index" },
      anchorRead: { status: "ok" },
    });
    const model = parseToolResult(single);
    expect(model.kind).toBe("parcel");
    expect(model.anchor?.lat).toBe(CENTRE.lat);
    expect(renderParcelDraw(model)).toContain(GROUND_TILE_ORIGIN);
    expect(renderParcelSet(model)).toBe("");
  });

  it("multiDrawableCount is the one predicate the parser and the plan both ask", () => {
    const model = parseToolResult(body([row(WEST), row(CENTRE), row(EAST)]));
    expect(multiDrawableCount(model.parcels ?? [])).toBe(3);
    expect(multiParcelPlan(model.parcels ?? []).multi?.placed).toHaveLength(3);
  });

  it("M-5: the fallback is still today's panel, but the whole set travels with it", () => {
    /* This fixture recorded the M-4 gap: below MULTI_MIN_DRAWN the parser fell
     * through to the single parcel branch, that branch painted parcels[0] alone,
     * and model.parcels was dropped, so the other rows were named nowhere. M-5
     * closes it by carrying the set on the model. The routing is unchanged. */
    const half = parseToolResult(
      body([row(WEST), row(CENTRE, { anchor: undefined, anchorRead: { status: "absent", reason: "x" } })]),
    );
    expect(half.kind).toBe("parcel");
    expect(half.parcels).toHaveLength(2);
    expect(half.parcelNodeId).toBe(WEST.id);
    expect(renderParcelDraw(half)).toContain(CENTRE.id);
  });
});

describe("M-4 truncation: a cap that fires is declared on the wire and on the page", () => {
  const AT_CAP = {
    cap: ANCHOR_BATCH_READ_CAP,
    received: ANCHOR_BATCH_READ_CAP,
    attempted: ANCHOR_BATCH_READ_CAP,
    notAttempted: 0,
  };
  const OVER_CAP = {
    cap: ANCHOR_BATCH_READ_CAP,
    received: 20,
    attempted: ANCHOR_BATCH_READ_CAP,
    notAttempted: 20 - ANCHOR_BATCH_READ_CAP,
    reason: "anchor_read_batch_cap",
  };

  it("at the cap there is nothing to declare, so nothing is declared", () => {
    const model = parseToolResult(body([row(WEST), row(CENTRE)], { anchorBatch: AT_CAP }));
    expect(model.anchorBatch).toEqual({
      cap: ANCHOR_BATCH_READ_CAP,
      received: ANCHOR_BATCH_READ_CAP,
      attempted: ANCHOR_BATCH_READ_CAP,
      notAttempted: 0,
      reason: null,
    });
    expect(renderParcelSet(model)).not.toContain(MULTI_ANCHORS_READ);
  });

  it("over the cap the page names how many were read, how many were not, and why", () => {
    const model = parseToolResult(body([row(WEST), row(CENTRE)], { anchorBatch: OVER_CAP }));
    const html = renderParcelSet(model);
    expect(html).toContain(MULTI_ANCHORS_READ);
    expect(html).toContain(MULTI_ANCHORS_NOT_READ);
    expect(html).toContain('data-anchor-not-read="' + (20 - ANCHOR_BATCH_READ_CAP) + '"');
    expect(html).toContain('data-anchor-attempted="' + ANCHOR_BATCH_READ_CAP + '"');
    expect(html).toContain('data-anchor-cap="' + ANCHOR_BATCH_READ_CAP + '"');
    expect(html).toContain("anchor_read_batch_cap");
  });

  it("the parcels past the cap are ALSO named one by one, not only counted", () => {
    const rows = [row(WEST), row(CENTRE)];
    for (const c of [EAST, REC_31254, REC_49295]) {
      rows.push(row(c, { anchor: undefined, anchorRead: { status: "skipped", reason: "anchor_read_batch_cap" } }));
    }
    const model = parseToolResult(body(rows, { anchorBatch: OVER_CAP }));
    const html = renderParcelSet(model);
    for (const c of [EAST, REC_31254, REC_49295]) {
      expect(html).toContain('data-undrawn="' + c.id + '"');
    }
  });

  it("a malformed anchorBatch is no declaration, never a made up one", () => {
    const model = parseToolResult(body([row(WEST), row(CENTRE)], { anchorBatch: { cap: "twelve" } }));
    expect(model.anchorBatch).toBeUndefined();
    expect(renderParcelSet(model)).not.toContain(MULTI_ANCHORS_READ);
  });
});

describe("M-4 extent: a set too wide for the imagery gets rings and says so", () => {
  it("two recorded parcels about 6,200 ft apart draw with no ground and state the threshold", () => {
    const m = planOf([row(REC_31254), row(REC_82112)]);
    expect(Math.max(m.extentXFt, m.extentYFt)).toBeGreaterThan(MULTI_GROUND_MAX_EXTENT_FT);
    expect(m.ground).toBeNull();
    expect(m.groundReason).toBe(MULTI_GROUND_EXTENT_REASON);
    expect(m.placed).toHaveLength(2);
    const html = renderParcelSet(parseToolResult(body([row(REC_31254), row(REC_82112)])));
    expect(html).toContain(String(MULTI_GROUND_MAX_EXTENT_FT));
    expect(html).toContain('data-ground-refused="' + MULTI_GROUND_EXTENT_REASON + '"');
    /* rings yes, imagery no */
    expect(html).toContain('class="ring-fill"');
    expect(html).not.toContain(GROUND_TILE_ORIGIN);
    expect(html).not.toContain("<img");
  });

  it("a set inside the threshold keeps its imagery", () => {
    const m = planOf([row(CENTRE), row(REC_31254)]);
    expect(Math.max(m.extentXFt, m.extentYFt)).toBeLessThan(MULTI_GROUND_MAX_EXTENT_FT);
    expect(m.groundReason).toBeNull();
    expect(m.ground).not.toBeNull();
    expect(renderParcelSet(parseToolResult(body([row(CENTRE), row(REC_31254)])))).toContain(GROUND_TILE_ORIGIN);
  });

  it("the extent threshold binds before the tile cap, so the refusal is stated in feet", () => {
    /* At the widest extent the ground is still painted at, the mosaic is well
     * inside GROUND_MAX_TILES. If that stopped being true the tile cap would
     * fire first and the user would meet a reason they cannot act on. */
    const m = planOf([row(CENTRE), row(REC_31254)]);
    expect(m.ground!.tiles.length).toBeLessThan(36);
  });

  it("the ground toggle is off the page entirely when there is no ground", () => {
    const html = renderParcelSet(parseToolResult(body([row(REC_31254), row(REC_82112)])));
    expect(html).not.toContain('data-act="ground"');
  });
});

/*
 * M-5 item 1. The M-4 naming was conditional on the canvas existing. These
 * fixtures hold the wider rule: a result carrying more than one parcel names
 * every parcel this panel did not draw, with a reason, canvas or no canvas.
 *
 * Seven ids, all SYNTHETIC test inputs. The three cases the card names are one
 * drawable, zero drawable and two drawable, and a fourth is added below because
 * the first three all happen to have the drawable parcel first in the array,
 * which is the arrangement under which a narrower rule would still pass.
 */
const SEVEN = ["48021:70001", "48021:70002", "48021:70003", "48021:70004", "48021:70005", "48021:70006", "48021:70007"];

/** A drawable row: recorded ring, an anchor, an ok read. */
function drawableRow(id: string, lonOffsetFt: number): Record<string, unknown> {
  return {
    parcelNodeId: id,
    brief: { sections: [] },
    draw: drawOf(id + " label"),
    anchor: {
      lat: CENTRE.lat,
      lon: eastOf(CENTRE.lat, CENTRE.lon, lonOffsetFt),
      precision: "1e-5-deg",
      source: "bake-latlng-index",
    },
    anchorRead: { status: "ok" },
  };
}
/** Undrawable, and the reason differs by kind so the list cannot be a constant. */
function noRingRow(id: string): Record<string, unknown> {
  return {
    parcelNodeId: id,
    brief: { sections: [] },
    draw: { label: id + " label", frame: FRAME, ring: [], edges: [], overlays: [] },
    anchor: { lat: CENTRE.lat, lon: CENTRE.lon, precision: "1e-5-deg", source: "bake-latlng-index" },
    anchorRead: { status: "ok" },
  };
}
function noAnchorRow(id: string): Record<string, unknown> {
  return {
    parcelNodeId: id,
    brief: { sections: [] },
    draw: drawOf(id + " label"),
    anchorRead: { status: "absent", reason: "no_latlng_for_parcel" },
  };
}

function namedOffCanvas(html: string): string[] {
  return [...html.matchAll(/data-undrawn="([^"]+)"/g)].map((m) => m[1] ?? "");
}
/** The reason cell painted beside one id. Throws rather than returning "" on a miss. */
function reasonPainted(html: string, id: string): string {
  const at = html.indexOf('data-undrawn="' + id + '"');
  if (at < 0) throw new Error(id + " is named nowhere on this page");
  const cell = html.slice(at, html.indexOf("</div>", at));
  const m = /<span class="reason">([^<]*)<\/span>/.exec(cell);
  if (!m) throw new Error(id + " is named with no reason");
  return m[1] ?? "";
}

describe("M-5 item 1: what was not drawn is named, canvas or no canvas", () => {
  it("seven parcels, ONE drawable: the other six are each named by id with a reason", () => {
    const rows: Array<Record<string, unknown>> = [drawableRow(SEVEN[0]!, 0)];
    for (let i = 1; i < 4; i++) rows.push(noRingRow(SEVEN[i]!));
    for (let i = 4; i < 7; i++) rows.push(noAnchorRow(SEVEN[i]!));
    const model = parseToolResult(body(rows));
    /* routing is UNCHANGED: below two drawable parcels this is still the single
     * parcel panel, not a canvas */
    expect(model.kind).toBe("parcel");
    expect(model.parcelNodeId).toBe(SEVEN[0]);
    expect(multiDrawableCount(model.parcels ?? [])).toBe(1);
    const html = renderParcelDraw(model);
    expect(html).not.toContain('data-parcels="');
    expect(namedOffCanvas(html).sort()).toEqual(SEVEN.slice(1).sort());
    for (let i = 1; i < 4; i++) expect(reasonPainted(html, SEVEN[i]!)).toContain(MULTI_NO_RING);
    for (let i = 4; i < 7; i++) {
      expect(reasonPainted(html, SEVEN[i]!)).toContain(MULTI_NO_ANCHOR);
      expect(reasonPainted(html, SEVEN[i]!)).toContain("no_latlng_for_parcel");
    }
    expect(html).toContain(MULTI_OFF_CANVAS_TITLE);
    expect(html).toContain(multiNoCanvasWords(1, 7));
    expect(html).toContain('data-no-canvas="1"');
    expect(html).toContain('data-parcels-in-result="7"');
  });

  it("seven parcels, ZERO drawable: all SEVEN are named, including the one the panel painted", () => {
    /* The painted parcel is undrawable too, so excluding it would be the same
     * omission one row further in. */
    const rows = SEVEN.map((id, i) => (i < 4 ? noRingRow(id) : noAnchorRow(id)));
    const model = parseToolResult(body(rows));
    expect(model.kind).toBe("parcel");
    expect(model.parcelNodeId).toBe(SEVEN[0]);
    expect(multiDrawableCount(model.parcels ?? [])).toBe(0);
    const html = renderParcelDraw(model);
    expect(namedOffCanvas(html).sort()).toEqual([...SEVEN].sort());
    for (const id of SEVEN) expect(reasonPainted(html, id).length).toBeGreaterThan(0);
    expect(html).toContain(multiNoCanvasWords(0, 7));
  });

  it("seven parcels, TWO drawable: there IS a canvas, and the five are still each named with a reason", () => {
    const rows: Array<Record<string, unknown>> = [drawableRow(SEVEN[0]!, 0), drawableRow(SEVEN[1]!, LOT_W)];
    for (let i = 2; i < 5; i++) rows.push(noRingRow(SEVEN[i]!));
    for (let i = 5; i < 7; i++) rows.push(noAnchorRow(SEVEN[i]!));
    const model = parseToolResult(body(rows));
    expect(model.kind).toBe("parcels");
    const html = renderParcelSet(model);
    expect(html).toContain('data-parcels="2"');
    expect(namedOffCanvas(html).sort()).toEqual(SEVEN.slice(2).sort());
    for (const id of SEVEN.slice(2)) expect(reasonPainted(html, id).length).toBeGreaterThan(0);
    expect(html).toContain(MULTI_UNDRAWN_TITLE);
    /* the canvas list, not the no-canvas one: there is a canvas */
    expect(html).not.toContain(MULTI_OFF_CANVAS_TITLE);
    expect(html).not.toContain('data-no-canvas="');
  });

  it("the DRAWABLE parcel that is not the one painted is named too", () => {
    /* The case a narrower rule ("name the undrawable ones") misses entirely.
     * parcels[0] cannot be drawn, so the panel paints an empty card for it, and
     * the one parcel with a ring and an anchor is somewhere further down. Naming
     * only undrawable rows would leave that one unmentioned. */
    const rows: Array<Record<string, unknown>> = [noRingRow(SEVEN[0]!), noRingRow(SEVEN[1]!), drawableRow(SEVEN[2]!, 0)];
    const model = parseToolResult(body(rows));
    expect(model.kind).toBe("parcel");
    expect(model.parcelNodeId).toBe(SEVEN[0]);
    expect(multiDrawableCount(model.parcels ?? [])).toBe(1);
    const html = renderParcelDraw(model);
    expect(namedOffCanvas(html).sort()).toEqual(SEVEN.slice(0, 3).sort());
    expect(reasonPainted(html, SEVEN[2]!)).toBe(MULTI_NO_CANVAS);
    expect(offCanvasParcels(model.parcels ?? [], SEVEN[0]!)).toHaveLength(3);
  });

  it("a notFound id is named off canvas too, and the truncation note travels with the list", () => {
    const rows: Array<Record<string, unknown>> = [drawableRow(SEVEN[0]!, 0), noRingRow(SEVEN[1]!)];
    const model = parseToolResult(
      body(rows, {
        notFound: ["48021:404404"],
        anchorBatch: { cap: 12, received: 20, attempted: 12, notAttempted: 8, reason: "anchor_read_batch_cap" },
      }),
    );
    expect(model.kind).toBe("parcel");
    const html = renderParcelDraw(model);
    expect(html).toContain('data-undrawn="48021:404404"');
    expect(reasonPainted(html, "48021:404404")).toContain(NOT_RETURNED);
    expect(html).toContain('data-anchor-not-read="8"');
    expect(html).toContain("anchor_read_batch_cap");
  });

  it("a genuine single parcel result is untouched: nothing was omitted, so nothing is declared", () => {
    const model = parseToolResult(body([drawableRow(SEVEN[0]!, 0)]));
    expect(model.kind).toBe("parcel");
    expect(model.parcels).toBeUndefined();
    const html = renderParcelDraw(model);
    expect(html).not.toContain("data-undrawn=");
    expect(html).not.toContain("data-no-canvas=");
    expect(offCanvasHtml(model)).toBe("");
  });

  it("offCanvasParcels asks undrawnReason, so the drawable predicate has ONE definition", () => {
    const parcels = (parseToolResult(body([drawableRow(SEVEN[0]!, 0), noRingRow(SEVEN[1]!)])).parcels ?? []);
    const off = offCanvasParcels(parcels, SEVEN[0]!);
    expect(off).toHaveLength(1);
    expect(off[0]!.reason).toBe(MULTI_NO_RING);
    /* the same row, asked the same question by the plan */
    expect(multiParcelPlan(parcels).reason).toBe(MULTI_TOO_FEW_REASON);
    expect(multiDrawableCount(parcels)).toBe(1);
  });
});

describe("M-4 served page", () => {
  const html = buildAppHtml();

  it("carries no contract violation", () => {
    expect(htmlContractViolations(html)).toEqual([]);
  });

  it("embeds the canvas, both lists and the truncation note by source", () => {
    for (const fn of [
      "function multiParcelPlan",
      "function multiCanvasSvg",
      "function multiUndrawnHtml",
      "function multiDrawnHtml",
      "function anchorBatchNoteHtml",
      "function renderParcelSet",
      "function parcelsFromBatch",
    ]) {
      expect(html).toContain(fn);
    }
    expect(html).toContain(MULTI_UNDRAWN_TITLE);
    expect(html).toContain(MULTI_DRAWN_TITLE);
    expect(html).toContain("var MULTI_GROUND_MAX_EXTENT_FT=" + MULTI_GROUND_MAX_EXTENT_FT);
  });

  it("multi_canvas_unbound fires when the undrawn list is taken out of the page", () => {
    const stripped = html.split(MULTI_UNDRAWN_TITLE).join("Other parcels");
    expect(htmlContractViolations(stripped)).toContain("multi_canvas_unbound");
  });

  it("the tool catalog is untouched: still no fourteenth tool", () => {
    expect(html).not.toContain("get_parcel_set");
    expect(html).not.toContain("draw_parcels");
  });
});
