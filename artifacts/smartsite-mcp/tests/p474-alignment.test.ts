import { describe, expect, it } from "vitest";
import { gwrapAspectAttr, groundPlan, groundWrapHtml, ringFit, ringFromDraw } from "../src/card/panel-lib.js";

/** Bastrop QA parcel 48021:32342 ring from artifact-html-gate record (alignment regression). */
const RING_32342 = [
  { x: 87.33, y: 106.73 },
  { x: -89.28, y: 102.33 },
  { x: -87.02, y: -103.61 },
  { x: 88.98, y: -105.45 },
];

describe("P-474 ground alignment", () => {
  it("gwrap aspect-ratio matches ringFit so tiles and ring share one box", () => {
    const fit = ringFit(RING_32342);
    expect(fit).not.toBeNull();
    const attr = gwrapAspectAttr(fit);
    expect(attr).toContain(`aspect-ratio:${fit!.w}/${fit!.h}`);
  });

  it("groundWrapHtml applies the same aspect attribute as ringFit", () => {
    const anchor = { lat: 30.11426, lon: -97.31228, precision: "1e-5-deg", source: "bake" };
    const outcome = groundPlan(RING_32342, anchor, { status: "ok" });
    expect(outcome.plan).not.toBeNull();
    const svg = '<svg class="ring"></svg>';
    const html = groundWrapHtml(svg, outcome.plan, true);
    expect(html).toContain(`aspect-ratio:${outcome.plan!.fit.w}/${outcome.plan!.fit.h}`);
  });

  it("parses draw rings the same way as node results (48021:27831-style coords)", () => {
    const draw = {
      ring: [
        [50.14, -71.87],
        [48.57, 5.31],
        [47.5, 73.31],
        [46.02, 142.98],
        [-7.59, 141.69],
      ],
    };
    const ring = ringFromDraw(draw);
    expect(ring.length).toBeGreaterThanOrEqual(3);
    expect(gwrapAspectAttr(ringFit(ring))).toMatch(/aspect-ratio:/);
  });
});
