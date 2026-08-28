import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("cityLimitsFact inspect wire (file contract)", () => {
  it("facets GET loads cityLimitsFact from the PIP reader, not an atom or ETJ buffer", () => {
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    expect(routeSrc).toMatch(/from\s+["']\.\.\/lib\/cityLimitsFactRead["']/);
    expect(routeSrc).toMatch(/loadCityLimitsFact/);
    expect(routeSrc).toMatch(/cityLimitsFact/);
    expect(routeSrc).not.toMatch(/cityLimitsFact\s*=\s*.*situsCity/);
    expect(routeSrc).not.toMatch(/offset\s*2\s*miles/i);
    expect(routeSrc).not.toMatch(/buffer(ed)?\s*(polygon|ring|miles)/i);
    expect(routeSrc).not.toMatch(/--apply/);
  });

  it("card F: the zoning verdict is derived from cityLimitsFact by zoningVerdictFromCityLimits, loaded before it, and no serve module reads situsCity as evidence", () => {
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    expect(routeSrc).toMatch(/zoningVerdictFromCityLimits\(parcelNodeId, snapshot\.facets, cityLimitsFact\)/);
    // City limits are loaded BEFORE the verdict and the land-use enrichment.
    // Line-ending agnostic: the checkout may be CRLF (core.autocrlf) while CI is LF.
    const load = routeSrc.search(/await loadCityLimitsFact\(/);
    const verdict = routeSrc.search(/zoningVerdictFromCityLimits\(parcelNodeId/);
    const enrich = routeSrc.search(/enrichLandUseFactWithZoningVerdict\(\r?\n/);
    expect(load).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(load);
    expect(enrich).toBeGreaterThan(verdict);
    expect(routeSrc).toMatch(/attachVerdictLayersToFacets\([\s\S]*?zoningVerdict,\s*\)/);
    for (const rel of ["verdictLayerServe.ts", "landUseFactVerdict.ts", "structuralFactToFacetsWire.ts", "cityLimitsFactRead.ts"]) {
      const src = readFileSync(join(here, rel), "utf8");
      // The only mentions of situsCity in the serve modules are the comments saying it is never an input.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${rel} reads situsCity`).not.toMatch(/situsCity/);
      expect(code, `${rel} reads situsZip`).not.toMatch(/situsZip/);
    }
  });
});
