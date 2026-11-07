/**
 * R1 RULING (2026-09-04, OPS-19b) — zoning and envelope retired from
 * `countyCoverageScoreCli.ts`, `countyRailScoreCli.ts` (lane SS-W15) is the
 * sole writer. Both instruments used to upsert the same
 * `(county_fips, facet)` primary key with different denominators (county-wide
 * here, incorporated-parcels-only there), so the ledger cell read whichever
 * one ran last: Bastrop's zoning cell alternated between 15.22% and 79.60%
 * depending on which CLI fired most recently. SS-W15's own PR (#440) named
 * this fix and correctly declined to execute a retirement in a different
 * lane's file without a ruling; this is that ruling.
 *
 * NAMED, EXPLICIT RETIREMENT, NOT A SILENT REMOVAL (DEV_PROCESS 2.4's own
 * CTRL-1 shape, same pattern `lib/db/src/__tests__/manifestDisplayState.test.ts`
 * uses for its own consolidation). A test that fails when zoning/envelope
 * reappear here is the control; a careful one-time deletion is not.
 *
 * Source-text based, not a runtime call: `scoreCounty` / `measureCoverage`
 * are not exported (they require a live `pg.Pool`, and this CLI's own boot-
 * graph rule keeps DB-touching code out of the unit-test-reachable surface —
 * see the file's own `checkBootGraphNoCliImports.mjs` note). Reading the
 * actual source text is the only offline way to prove a write path is gone,
 * matching `manifestDisplayState.test.ts`'s own `repoFile` pattern exactly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const CLI_FILE = "artifacts/api-server/src/countyCoverageScoreCli.ts";

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

describe("countyCoverageScoreCli.ts: zoning/envelope retirement (R1, 2026-09-04)", () => {
  it("never writes a zoning or envelope facet again", () => {
    const src = repoFile(CLI_FILE);
    expect(src, "reintroduced a zoning facet write").not.toContain('facet: "zoning"');
    expect(src, "reintroduced an envelope facet write").not.toContain('facet: "envelope"');
  });

  it("never carries a private zoning/envelope source-basis helper again", () => {
    const src = repoFile(CLI_FILE);
    expect(src, "reintroduced zoningStampSourceBasis").not.toContain(
      "zoningStampSourceBasis",
    );
    expect(src, "reintroduced envelopeSourceBasis").not.toContain(
      "envelopeSourceBasis",
    );
  });

  it("never reads the retired zoning/envelope measurability inputs again", () => {
    // These names are specific to the retired write path (the CountyPresence
    // fields it alone needed) -- not a ban on the word "zoning" everywhere in
    // the file, which still appears legitimately in this test's own retirement
    // note and in historical incident comments (Travis 48453).
    const src = repoFile(CLI_FILE);
    expect(src, "reintroduced hasZoning").not.toContain("hasZoning");
    expect(src, "reintroduced wiredZoningLayers").not.toContain("wiredZoningLayers");
    expect(src, "reintroduced zoningStampedPct").not.toContain("zoningStampedPct");
    expect(src, "reintroduced envelopeDerivablePct").not.toContain(
      "envelopeDerivablePct",
    );
  });

  it("the retirement is named IN the file, not just in a commit message", () => {
    const src = repoFile(CLI_FILE);
    expect(src, "no pointer to the R1 ruling").toContain("R1 ruling");
    expect(src, "no pointer to the sole writer").toContain("countyRailScoreCli.ts");
  });

  it("land-use is still written -- this is a retirement of two facets, not the whole instrument", () => {
    const src = repoFile(CLI_FILE);
    expect(src).toContain("LANDUSE_JOIN_FACET_KEY");
  });

  it("the file-reading control can FAIL — proven, not assumed (DEV_PROCESS 2.2/2.3)", () => {
    const src = repoFile(CLI_FILE);
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("scoreCounty");
    expect(() => expect(src).not.toContain("scoreCounty")).toThrow();
    expect(() => repoFile("artifacts/api-server/src/this-file-does-not-exist.ts")).toThrow();
  });
});
