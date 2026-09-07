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
import { attachVerdictLayersToFacets } from "./structuralFactToFacetsWire";
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
