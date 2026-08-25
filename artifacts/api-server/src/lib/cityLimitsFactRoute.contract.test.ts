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
});
