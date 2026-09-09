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

/**
 * P-124 CTX-MIRROR: the zoningDistrict rail's OWN cell is kind=refused --
 * the Factory engine looked and deliberately declined, with a real, specific
 * reason. Distinct from REFUSED_LEDGER_FACT above (an adapter-level read
 * failure, code parcel-record-malformed-cell) and from ELGIN_UNACCOUNTED
 * below (code parcel-record-unaccounted, "not examined yet") -- this is the
 * one refusal code this dispatch's fix targets. Values match the dispatch's
 * own live-canary example (48055:103436).
 */
const ENGINE_REFUSED_LEDGER_FACT: ZoningFactRead = {
  state: "refused",
  code: "parcel-record-engine-refused",
  source: "zoning-fact-parcel-record",
  entityId: "48055:103436",
  reason: "no tx_zoning_district_staging base layer exists for Mustang Ridge yet",
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

  it("P-124 CTX-MIRROR: an ENGINE-REFUSED ledger fact (code parcel-record-engine-refused) is now surfaced honestly, not silently replaced by the baked stamp", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: BAKED_STAMP, facetCoverage: { zoning: true } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      ENGINE_REFUSED_LEDGER_FACT,
    );
    expect(out.zoning).toEqual(ENGINE_REFUSED_LEDGER_FACT);
    expect((out.facetCoverage as Record<string, unknown>).zoning).toBe(false);
  });

  it("P-124 CTX-MIRROR: an ENGINE-REFUSED ledger fact wins even with no baked stamp -- never the generic city-limits stamp-missing fallback", () => {
    const out = attachVerdictLayersToFacets(
      { zoning: null, facetCoverage: { zoning: false } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      ENGINE_REFUSED_LEDGER_FACT,
    );
    expect(out.zoning).toEqual(ENGINE_REFUSED_LEDGER_FACT);
    expect(out.zoning).not.toEqual(CITY_LIMITS_VERDICT);
  });

  it("other refusal codes are UNCHANGED by the CTX-MIRROR fix: unaccounted still falls through to the city-limits fallback, not to \"refused\"", () => {
    // Regression guard for the narrowed scope decided at CP1: only
    // code===\"parcel-record-engine-refused\" gets the honest projection.
    // ELGIN_UNACCOUNTED (defined below) must keep falling through exactly as
    // before this fix.
    const out = attachVerdictLayersToFacets(
      { zoning: null, facetCoverage: { zoning: false } },
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      { ...REFUSED_LEDGER_FACT, code: "parcel-record-unaccounted" },
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

/**
 * P-124 CTX-MIRROR (2026-09-09): the mirror projected `not-applicable` and a
 * present district's citation correctly but had no branch for `refused` --
 * a parcel_record cell of kind=refused fell through to the generic
 * city-limits stamp-missing fallback, which is not one of
 * value|absent-verified|not-applicable|refused and fails BP-CONTENT-01.
 *
 * classifyRequiredLeafVerbatim below is reproduced verbatim from
 * `P:/tmp/ctx-w2-gate/src/jobs/verify-walk.mjs`'s exported
 * `classifyRequiredLeaf` (lines 304-386 as read 2026-09-09, HEAD 7a53c65,
 * confirmed 0 commits behind origin/main -- the live grader, not a stale
 * copy). Reproduced rather than imported for the same reason CTX-LEAVES gave:
 * verify-walk.mjs lives in the sibling hauska-factory repo, out of this
 * dispatch's scope to depend on. Reproduced rather than paraphrased so this
 * test grades what the walk actually does, not what it is assumed to do.
 *
 * `zoning` and `provenance.zoningSource` are BOTH independently listed in
 * verify-walk.mjs's REQUIRED_TIER1_FACET_PATHS (confirmed by reading that
 * export directly), so both are graded below.
 */
function classifyRequiredLeafVerbatim(
  value: unknown,
  { requestClock, path = "leaf" }: { requestClock?: string; path?: string } = {},
): { state: string; ok: boolean; reason?: string } {
  const ABSENCE_STATE_TOKENS = ["absent-verified", "not-applicable", "refused"];
  const POPULATED_STATE_TOKENS = ["value", "present", "populated"];
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const declaredStateOf = (rec: Record<string, unknown>) => {
    const nested = rec.absence;
    const raw = rec.verdict ?? rec.state ?? null;
    if (raw == null) return null;
    const token = String(raw).trim();
    if (token === "absent" && nested && typeof nested === "object") {
      const kind = (nested as Record<string, unknown>).kind;
      return { token: kind == null ? "" : String(kind).trim(), via: "absence.kind" as const, outer: token };
    }
    const via: "verdict" | "state" = rec.verdict != null ? "verdict" : "state";
    return { token, via, outer: token };
  };

  if (value === null || value === undefined) {
    return { state: "null", ok: false, reason: `${path} is null; null is not value|absent-verified|not-applicable|refused` };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (value === "") return { state: "empty", ok: false, reason: `${path} is empty` };
    return { state: "value", ok: true };
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? { state: "value", ok: true }
      : { state: "empty", ok: false, reason: `${path} is an empty array` };
  }
  const rec = asRecord(value);
  if (!rec) return { state: "unknown", ok: false, reason: `${path} is not a four-state leaf` };

  const declared = declaredStateOf(rec);
  const verdict = declared?.token ?? null;
  const absence = verdict != null && ABSENCE_STATE_TOKENS.includes(verdict);
  const ev =
    declared?.via === "absence.kind" && rec.absence && typeof rec.absence === "object"
      ? {
          ...rec,
          basis: rec.basis ?? (rec.absence as Record<string, unknown>).basis ?? (rec.absence as Record<string, unknown>).reason,
          scope: rec.scope ?? rec.scopeSearched ?? (rec.absence as Record<string, unknown>).scope ?? (rec.absence as Record<string, unknown>).scopeSearched,
          asOf: rec.asOf ?? (rec.absence as Record<string, unknown>).asOf,
        }
      : rec;
  if (absence) {
    if (verdict === "absent-verified") {
      const scope = (ev as Record<string, unknown>).scope ?? (ev as Record<string, unknown>).scopeSearched;
      const evAsOf = (ev as Record<string, unknown>).asOf;
      const basis = (ev as Record<string, unknown>).basis;
      if (scope == null || String(scope).trim() === "") return { state: "absent-verified", ok: false, reason: `${path} absent-verified missing scope` };
      if (evAsOf == null || String(evAsOf).trim() === "") return { state: "absent-verified", ok: false, reason: `${path} absent-verified missing asOf` };
      if (basis == null || String(basis).trim() === "") return { state: "absent-verified", ok: false, reason: `${path} absent-verified missing basis` };
      if (requestClock != null && String(evAsOf) === String(requestClock)) {
        return { state: "absent-verified", ok: false, reason: `${path} asOf equals request clock; evaluation-time asOf required` };
      }
      return { state: "absent-verified", ok: true };
    }
    if (verdict === "not-applicable") {
      const basis = (ev as Record<string, unknown>).basis;
      if (basis == null || String(basis).trim() === "") return { state: "not-applicable", ok: false, reason: `${path} not-applicable missing basis` };
      return { state: "not-applicable", ok: true };
    }
    return { state: "refused", ok: true };
  }
  if (Object.keys(rec).length === 0) {
    return { state: "empty", ok: false, reason: `${path} is an empty object` };
  }
  if (declared !== null && !POPULATED_STATE_TOKENS.includes(verdict as string)) {
    return {
      state: "unrecognised-declared-state",
      ok: false,
      reason: `${path} declares ${declared.via}=${JSON.stringify(declared.outer)} which is not a recognised state`,
    };
  }
  return { state: "value", ok: true };
}

describe("P-124 CTX-MIRROR: refused rail state projects honestly on both required leaves", () => {
  it("verify by violating -- PASS case: the fixed shape grades {state:refused, ok:true} on both facets.zoning and provenance.zoningSource, and carries the rail's real reason", () => {
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: null, facetCoverage: { zoning: false } }),
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      ENGINE_REFUSED_LEDGER_FACT,
    );
    expect(classifyRequiredLeafVerbatim(out.zoning, { path: "zoning" })).toEqual({ state: "refused", ok: true });
    expect(classifyRequiredLeafVerbatim(mirrorOf(out), { path: "provenance.zoningSource" })).toEqual({
      state: "refused",
      ok: true,
    });
    expect((out.zoning as { reason: string }).reason).toBe(
      "no tx_zoning_district_staging base layer exists for Mustang Ridge yet",
    );
    expect(mirrorOf(out).reason).toBe(
      "no tx_zoning_district_staging base layer exists for Mustang Ridge yet",
    );
    expect(mirrorOf(out).mirrors).toBe("zoning");
  });

  it("verify by violating -- FAIL case: the pre-fix shape this defect actually produced (the city-limits stamp-missing fallback standing in for the rail's refusal) still fails the four-state contract", () => {
    // This is exactly what attachVerdictLayersToFacets wrote to out.zoning
    // (and zoningSourceMirror then copied verbatim onto provenance.zoningSource)
    // before this fix, for a parcel whose rail cell was kind=refused. Proves
    // the check above is capable of failing for the right reason, not just
    // capable of passing.
    const preFixShape = CITY_LIMITS_VERDICT;
    const graded = classifyRequiredLeafVerbatim(preFixShape, { path: "provenance.zoningSource" });
    expect(graded.ok).toBe(false);
    expect(graded.state).toBe("unrecognised-declared-state");
  });

  it("a fixture with the rail's own reason field stripped away is never produced by the real adapter -- but if it somehow were, the served shape's `reason` would read blank rather than silently substituting a fabricated one", () => {
    // zoningFactFromParcelRecord.ts's ZoningFactRefusal always carries a real,
    // non-empty `reason` for every one of its return paths (verified by
    // reading the source, not assumed) -- there is no code path that produces
    // {state:\"refused\", code:\"parcel-record-engine-refused\", reason: \"\"}
    // for real data. This fixture exists only to prove the mirror does not
    // invent a substitute reason when handed a malformed one.
    const malformed: ZoningFactRead = { ...ENGINE_REFUSED_LEDGER_FACT, reason: "" };
    const out = attachVerdictLayersToFacets(
      withProvenance({ zoning: null, facetCoverage: { zoning: false } }),
      ABSENT_STRUCTURAL,
      CITY_LIMITS_VERDICT,
      undefined,
      malformed,
    );
    expect((out.zoning as { reason: string }).reason).toBe("");
    expect(mirrorOf(out).reason).toBe("");
    // classifyRequiredLeaf's own \"refused\" branch does not check reason
    // content (confirmed by reading verify-walk.mjs directly) -- it still
    // grades ok:true. Documented here rather than silently assumed: this
    // program's own house rule (\"every absence carries its basis\") is
    // stricter than this specific grader instance is today.
    expect(classifyRequiredLeafVerbatim(out.zoning, { path: "zoning" })).toEqual({ state: "refused", ok: true });
  });
});
