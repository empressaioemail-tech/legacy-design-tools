import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("cityLimitsFact inspect wire (file contract)", () => {
  it("facets GET loads cityLimitsFact through the PARCEL-B-SLATE1 serve cutover to the PIP reader, not an atom or ETJ buffer", () => {
    // F-01, PARCEL-B-SLATE1 (2026-09-02): the route calls
    // loadCityLimitsFactForServe (cityLimitsFactServeCutover.ts), which
    // checks the rail allowlist (today: legacy for every unslated pair) and
    // delegates to loadCityLimitsFact unchanged -- see
    // cityLimitsFactServeCutover.ts's own wiring, asserted below.
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    expect(routeSrc).toMatch(
      /from\s+["']\.\.\/lib\/cityLimitsFactServeCutover["']/,
    );
    expect(routeSrc).toMatch(/loadCityLimitsFactForServe/);
    expect(routeSrc).toMatch(/cityLimitsFact/);
    expect(routeSrc).not.toMatch(/cityLimitsFact\s*=\s*.*situsCity/);
    expect(routeSrc).not.toMatch(/offset\s*2\s*miles/i);
    expect(routeSrc).not.toMatch(/buffer(ed)?\s*(polygon|ring|miles)/i);
    expect(routeSrc).not.toMatch(/--apply/);

    const wrapperSrc = readFileSync(
      join(here, "cityLimitsFactServeCutover.ts"),
      "utf8",
    );
    expect(wrapperSrc).toMatch(/from\s+["']\.\/cityLimitsFactRead["']/);
    expect(wrapperSrc).toMatch(/loadCityLimitsFact/);
    expect(wrapperSrc).not.toMatch(/offset\s*2\s*miles/i);
    expect(wrapperSrc).not.toMatch(/buffer(ed)?\s*(polygon|ring|miles)/i);
  });

  it("card F: the zoning verdict is derived from cityLimitsFact by zoningVerdictFromCityLimits, loaded before it, and no serve module reads situsCity as evidence", () => {
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    expect(routeSrc).toMatch(/zoningVerdictFromCityLimits\(parcelNodeId, snapshot\.facets, cityLimitsFact\)/);
    // City limits are loaded BEFORE the verdict and the land-use enrichment.
    // Line-ending agnostic: the checkout may be CRLF (core.autocrlf) while CI is LF.
    const load = routeSrc.search(/await loadCityLimitsFactForServe\(/);
    const verdict = routeSrc.search(/zoningVerdictFromCityLimits\(parcelNodeId/);
    const enrich = routeSrc.search(/enrichLandUseFactWithZoningVerdict\(\r?\n/);
    expect(load).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(load);
    expect(enrich).toBeGreaterThan(verdict);
    expect(routeSrc).toMatch(/attachVerdictLayersToFacets\([\s\S]*?zoningVerdict,\s*\)/);
    for (const rel of ["verdictLayerServe.ts", "landUseFactVerdict.ts", "structuralFactToFacetsWire.ts", "cityLimitsFactRead.ts", "cityLimitsFactServeCutover.ts", "cityLimitsFactFromParcelRecord.ts"]) {
      const src = readFileSync(join(here, rel), "utf8");
      // The only mentions of situsCity in the serve modules are the comments saying it is never an input.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${rel} reads situsCity`).not.toMatch(/situsCity/);
      expect(code, `${rel} reads situsZip`).not.toMatch(/situsZip/);
    }
  });
});
