/**
 * attachVerdictLayersToFacets — PE/MCP-vs-facets parity audit (2026-09-07,
 * finding D5): parcel_record's zoning determination (`parcelRecordZoningFact`)
 * must win UNCONDITIONALLY over the baked stamp whenever it has genuinely
 * earned one (present, or a verified absence), the exact rule
 * r1BriefCompose.ts's composeZoningBriefSectionFromParcelRecord already
 * applies for the research/brief path. Before this fix, this function only
 * ever filled a genuine STAMP ABSENCE from the city-limits verdict and had no
 * way to override an existing stamp at all -- so a live parcel_record zoning
 * determination could silently disagree with a stale baked stamp forever.
 */

import { describe, expect, it } from "vitest";
import { attachVerdictLayersToFacets, zoningSourceMirror } from "./structuralFactToFacetsWire";
import type { StructuralFactRead } from "./structuralFactResolve";
import type { ZoningFactRead } from "./zoningFactFromParcelRecord";
import type { LayerAbsenceWire } from "./verdictLayerServe";

const ABSENT_STRUCTURAL: StructuralFactRead = {
  status: "absent",
  verdict: "lookup-failed",
  authority: "none",
  scopeSearched: "none",
  asOf: "2026-09-07T00:00:00.000Z",
  basis: "test fixture -- structural fact not under test here",
  provenanceClass: "Observation",
  subjectKind: "extensional",
  chainAnchoring: "contemporaneous",
  serveLayer: "structuralFact",
  source: "structural-fact",
};

const CITY_LIMITS_VERDICT: LayerAbsenceWire = {
  status: "absent",
  verdict: "stamp-missing",
  authority: "Austin",
  scopeSearched: "tx_city_boundary",
  asOf: "2026-09-07T00:00:00.000Z",
  basis: "test fixture city-limits verdict",
  provenanceClass: "Derivation",
  subjectKind: "extensional",
  chainAnchoring: "contemporaneous",
  serveLayer: "zoning",
};

const PRESENT_LEDGER_FACT: ZoningFactRead = {
  state: "present",
  source: "zoning-fact-parcel-record",
  entityId: "48453:493738",
  district: "SF-3",
  jurisdictionKey: "austin-tx",
  provenance: "hauska-factory rail write, 2026-09-01",
  sourceAdapter: "parcel_record",
  sourceVintage: "2026-09-01",
  evaluatedAt: "2026-09-01T00:00:00.000Z",
};

const NOT_APPLICABLE_LEDGER_FACT: ZoningFactRead = {
  state: "absent",
  source: "zoning-fact-parcel-record",
  entityId: "48021:10001",
  absence: { kind: "not-applicable", reason: "unincorporated territory is unzoned" },
  verifiedAbsence: null,
  sourceTier: null,
  sourceAdapter: "parcel_record",
  sourceVintage: null,
};

const REFUSED_LEDGER_FACT: ZoningFactRead = {
  state: "refused",
  code: "parcel-record-malformed-cell",
  source: "zoning-fact-parcel-record",
  entityId: "48453:1",
  reason: "test fixture -- a genuinely broken record read",
};

const BAKED_STAMP = { district: "SF-2", jurisdictionKey: "austin-tx-legacy", provenance: null };

describe("attachVerdictLayersToFacets zoning precedence", () => {
  it("baseline (no parcelRecordZoningFact arg at all): an existing baked stamp still wins, unchanged behavior", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
    );
    expect(out.zoning).toEqual(BAKED_STAMP);
  });

  it("baseline: a genuinely absent baked stamp still falls back to the city-limits verdict when no ledger fact is passed", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: null, facetCoverage: { zoning: false } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
    );
    expect(out.zoning).toEqual(CITY_LIMITS_VERDICT);
  });

  it("D5 FIX: a present ledger fact overrides an EXISTING baked stamp -- the core bug", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      null,
      undefined,
      PRESENT_LEDGER_FACT,
    );
    expect(out.zoning).toEqual({
      district: "SF-3",
      jurisdictionKey: "austin-tx",
      provenance: "hauska-factory rail write, 2026-09-01",
    });
    expect((out.facetCoverage as Record<string, unknown>).zoning).toBe(true);
  });

  it("D5: a present ledger fact overrides even when the baked stamp is ALREADY populated and the city-limits verdict is also non-null (ledger wins over both)", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      PRESENT_LEDGER_FACT,
    );
    expect((out.zoning as { district: string }).district).toBe("SF-3");
  });

  it("D5: a not-applicable/absent-verified ledger fact overrides the baked stamp too (same rule as flood's own parcel_record precedence, and matches the brief path's 'data: fact' choice for its absent branch)", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      null,
      undefined,
      NOT_APPLICABLE_LEDGER_FACT,
    );
    expect(out.zoning).toEqual(NOT_APPLICABLE_LEDGER_FACT);
    expect((out.facetCoverage as Record<string, unknown>).zoning).toBe(false);
  });

  it("a REFUSED ledger fact is never surfaced -- falls through to the baked stamp exactly like 'not cut over'", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      REFUSED_LEDGER_FACT,
    );
    expect(out.zoning).toEqual(BAKED_STAMP);
  });

  it("a REFUSED ledger fact with no baked stamp falls through to the city-limits verdict, unchanged", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: null, facetCoverage: { zoning: false } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      REFUSED_LEDGER_FACT,
    );
    expect(out.zoning).toEqual(CITY_LIMITS_VERDICT);
  });

  it("a null ledger fact (not cut over for this parcel) behaves identically to omitting the argument", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      null,
    );
    expect(out.zoning).toEqual(BAKED_STAMP);
  });
});

/**
 * P-124 CTX-LEAVES (2026-09-08): `provenance.zoningSource` MIRRORS the zoning
 * rail this function decides, instead of being a bare null wherever no GIS
 * stamp joined (486,218 Williamson and 267,076 Travis rows on staging).
 *
 * The whole property under test is that the twin cannot say anything the rail
 * does not say. Every case below asserts the mirror against the rail that was
 * actually chosen, never against a hard-coded expectation of its own.
 */

const UNINCORPORATED_VERDICT: LayerAbsenceWire = {
  status: "absent",
  verdict: "not-applicable",
  authority: "none",
  scopeSearched: "tx_city_boundary; texas_county_roster_v1",
  asOf: "2026-09-07T00:00:00.000Z",
  basis: "outside every incorporated place; county unincorporated territory is unzoned",
  provenanceClass: "Derivation",
  subjectKind: "extensional",
  chainAnchoring: "contemporaneous",
  serveLayer: "zoning",
};

/**
 * The Elgin shape. Elgin is deliberately absent from hauska-factory's
 * DECLARED_COMPLETE (68.73% cell coverage), so parcel_record keeps its
 * unmatched parcels `unaccounted`, which this adapter serves as `refused`.
 * The parcel is inside city limits, so the city-limits rail says the STAMP is
 * missing and that zoning authority is NOT absent.
 */
const ELGIN_UNACCOUNTED: ZoningFactRead = {
  state: "refused",
  code: "parcel-record-unaccounted",
  source: "zoning-fact-parcel-record",
  entityId: "48021:115146",
  reason: "parcel_record marks zoningDistrict unaccounted for this parcel",
};

const ELGIN_IN_CITY_VERDICT: LayerAbsenceWire = {
  ...CITY_LIMITS_VERDICT,
  authority: "Elgin",
  basis: "inside the incorporated place Elgin and carries no zoning stamp, so the stamp is missing; zoning authority is not absent",
};

const BAKED_GIS_SOURCE = "https://gis.example.gov/arcgis/rest/services/Zoning/FeatureServer/0";

function withProvenance(facets: Record<string, unknown>, zoningSource: unknown = null) {
  return { ...facets, provenance: { parcelSource: "conformant-v1-cad-parcel-roll", zoningSource } };
}

const railVerdict = (cell: unknown): unknown => {
  const rec = cell as Record<string, unknown> | null;
  if (!rec) return null;
  return rec.verdict ?? (rec.absence as Record<string, unknown> | undefined)?.kind ?? null;
};

const mirrorOf = (out: Record<string, unknown>): Record<string, unknown> =>
  (out.provenance as Record<string, unknown>).zoningSource as Record<string, unknown>;

describe("CTX-LEAVES: provenance.zoningSource mirrors the zoning rail", () => {
  it("a stamped parcel cites its own layer: the twin is a VALUE, unchanged from the bake", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance(
        { zoning: { ...BAKED_STAMP, provenance: { sourceUrl: BAKED_GIS_SOURCE } }, facetCoverage: {} },
        BAKED_GIS_SOURCE,
      ),
      ABSENT_STRUCTURAL,
      null,
    );
    expect((out.provenance as Record<string, unknown>).zoningSource).toBe(BAKED_GIS_SOURCE);
  });

  it("THE LIVE CONTRADICTION THIS CLOSES: when parcel_record overrides the baked stamp, the twin stops citing the old GIS layer", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: BAKED_STAMP, facetCoverage: { zoning: true } }, BAKED_GIS_SOURCE),
      ABSENT_STRUCTURAL,
      null,
      undefined,
      PRESENT_LEDGER_FACT,
    );
    // The district now comes from parcel_record, so the citation does too.
    expect((out.zoning as { district: string }).district).toBe("SF-3");
    expect((out.provenance as Record<string, unknown>).zoningSource).toBe(
      "hauska-factory rail write, 2026-09-01",
    );
    expect((out.provenance as Record<string, unknown>).zoningSource).not.toBe(BAKED_GIS_SOURCE);
  });

  it("an unincorporated parcel: the twin carries the rail's OWN not-applicable, verbatim", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: null, facetCoverage: { zoning: false } }),
      ABSENT_STRUCTURAL,
      UNINCORPORATED_VERDICT,
    );
    expect(out.zoning).toEqual(UNINCORPORATED_VERDICT);
    expect(mirrorOf(out)).toEqual({ ...UNINCORPORATED_VERDICT, mirrors: "zoning" });
    expect(mirrorOf(out).verdict).toBe(railVerdict(out.zoning));
  });

  it("ELGIN: an unaccounted rail plus an in-city containment gives stamp-missing on BOTH, and absent-verified on NEITHER", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: null, facetCoverage: { zoning: false } }),
      ABSENT_STRUCTURAL,
      ELGIN_IN_CITY_VERDICT,
      undefined,
      ELGIN_UNACCOUNTED,
    );
    expect(out.zoning).toEqual(ELGIN_IN_CITY_VERDICT);
    expect(mirrorOf(out).verdict).toBe("stamp-missing");
    expect(mirrorOf(out).verdict).toBe(railVerdict(out.zoning));
    // The standing ruling: Elgin's unmatched parcels are NOT verifiably
    // unzoned, so nothing on this payload may say they are.
    expect(JSON.stringify(out)).not.toContain("absent-verified");
    expect(mirrorOf(out).basis).toContain("zoning authority is not absent");
  });

  it("a parcel_record ABSENT determination is projected with its own verdict and its own reason as the basis", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: BAKED_STAMP, facetCoverage: { zoning: true } }, BAKED_GIS_SOURCE),
      ABSENT_STRUCTURAL,
      null,
      undefined,
      NOT_APPLICABLE_LEDGER_FACT,
    );
    expect(mirrorOf(out).verdict).toBe("not-applicable");
    expect(mirrorOf(out).verdict).toBe(railVerdict(out.zoning));
    expect(mirrorOf(out).basis).toBe("unincorporated territory is unzoned");
    expect(mirrorOf(out).scopeSearched).toContain("48021:10001");
    expect(mirrorOf(out).mirrors).toBe("zoning");
  });

  it("THE PROPERTY: across every rail this function can choose, the twin's verdict equals the rail's verdict", () => {
    const rails: Array<[LayerAbsenceWire | null, ZoningFactRead | undefined]> = [
      [CITY_LIMITS_VERDICT, undefined],
      [UNINCORPORATED_VERDICT, undefined],
      [ELGIN_IN_CITY_VERDICT, ELGIN_UNACCOUNTED],
      [null, NOT_APPLICABLE_LEDGER_FACT],
      [CITY_LIMITS_VERDICT, NOT_APPLICABLE_LEDGER_FACT],
    ];
    for (const [verdict, ledger] of rails) {
      const out = attachVerdictLayersToFacets(
        withProvenance({ zoning: null, facetCoverage: { zoning: false } }, BAKED_GIS_SOURCE),
        ABSENT_STRUCTURAL,
        verdict,
        undefined,
        ledger,
      );
      expect(mirrorOf(out).verdict).toBe(railVerdict(out.zoning));
      expect(mirrorOf(out).mirrors).toBe("zoning");
      // A mirror never invents a state the rail did not reach.
      expect(mirrorOf(out).verdict).not.toBe(undefined);
    }
  });

  it("NOTHING EARNED A STATE: the twin is left exactly as the bake wrote it rather than manufactured", () => {
    // A baked zoning object with a jurisdictionKey but no district earns no
    // city-limits verdict (parcelShapeLacksZoningAuthority is false for it) and
    // has no parcel_record fact. Honest outcome: the leaf keeps failing the
    // walk, and this function does not paper over it.
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: { jurisdictionKey: "austin-tx" }, facetCoverage: {} }, null),
      ABSENT_STRUCTURAL,
      null,
    );
    expect((out.provenance as Record<string, unknown>).zoningSource).toBeNull();
  });

  it("a district with no citation anywhere is REFUSED, never a fabricated source", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: { district: "R-1", jurisdictionKey: "elgin-tx" }, facetCoverage: {} }, null),
      ABSENT_STRUCTURAL,
      null,
    );
    expect(mirrorOf(out).verdict).toBe("refused");
    expect(mirrorOf(out).basis).toContain("no source citation");
  });

  it("zoningSourceMirror returns undefined for a cell it cannot read, so the caller leaves the baked value alone", () => {
    expect(zoningSourceMirror(null, "x", "2026-09-08T00:00:00.000Z")).toBeUndefined();
    expect(zoningSourceMirror("not an object", "x", "2026-09-08T00:00:00.000Z")).toBeUndefined();
    expect(zoningSourceMirror({ nothing: true }, "x", "2026-09-08T00:00:00.000Z")).toBeUndefined();
  });
});
