import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("P2b-serve source contracts", () => {
  it("yearBuiltFromBake is gone; only cad_property can populate yearBuilt", () => {
    const src = readFileSync(join(here, "../parcelDrawFromReads.ts"), "utf8");
    expect(src).not.toMatch(/function yearBuiltFromBake/);
    expect(src).not.toMatch(/root\?\.yearBuilt|base\?\.yearBuilt/);
    expect(src).toMatch(/yearBuiltFromStructural/);
    expect(src).toMatch(/source: "cad_property"/);
  });

  it("manifestLayers refuses from envelopeBriefRefusal, not stripped geojson", () => {
    const src = readFileSync(
      join(here, "../../routes/propertyExplorer.ts"),
      "utf8",
    );
    const start = src.indexOf("function manifestLayers");
    const end = src.indexOf("\nfunction ownerScope");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/envelopeBriefRefusal: EnvelopeBriefRefusal/);
    expect(fn).not.toMatch(/envelopeGeojson/);
    expect(fn).toMatch(/Envelope geometry is not served on this path/);
    expect(fn).toMatch(/layers: \[\]/);
    expect(fn).toMatch(/degraded: true/);
  });

  it("fromReads carries sourceVintage on every absent overlay input", () => {
    const src = readFileSync(join(here, "../parcelDrawFromReads.ts"), "utf8");
    expect(src).toMatch(/function floodInput[\s\S]*sourceVintage: vintageFromRead/);
    expect(src).toMatch(/function pipelineInput[\s\S]*sourceVintage: vintageFromRead/);
    expect(src).toMatch(/function wellInput[\s\S]*sourceVintage: vintageFromRead/);
    expect(src).toMatch(
      /function specialDistrictInput[\s\S]*sourceVintage: vintageFromRead/,
    );
  });
});
