/**
 * A RECORD-LEVEL retirement declaration. Extracted out of
 * nodeFacetBakeTier1Conformant.ts (CTX-B1, operator ruling A3, 2026-09-10) so
 * a light consumer (serveGuards.ts) does not have to import that module's
 * heavy chain (joinIntegrityGate.ts -> @workspace/cad-ingest ->
 * vintage-crosswalk.ts, which asserts DATABASE_URL at module load time, not
 * call time) just to check whether a payload is an earned retirement. One
 * authoritative definition -- nodeFacetBakeTier1Conformant.ts re-exports both
 * names from here rather than redefining them.
 */

export interface Tier1RecordRetirement {
  status: "retired";
  verdict: "absent-verified";
  authority: string;
  scopeSearched: string;
  asOf: string;
  basis: string;
  /** The tax_year this prop_id's OWN claim last carried, when known. */
  lastSeenTaxYear: number | null;
}

const RECORD_RETIREMENT_STRING_FIELDS = [
  "authority",
  "scopeSearched",
  "asOf",
  "basis",
] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * True for a WELL-FORMED record retirement -- the same discipline
 * `isEarnedLeafAbsence` applies one level down. A half-built object must not
 * buy the tolerance a genuine retirement earns.
 */
export function isEarnedRecordRetirement(
  value: unknown,
): value is Tier1RecordRetirement {
  const rec = asRecord(value);
  if (!rec) return false;
  if (rec.status !== "retired") return false;
  if (rec.verdict !== "absent-verified") return false;
  for (const field of RECORD_RETIREMENT_STRING_FIELDS) {
    const v = rec[field];
    if (typeof v !== "string" || v.trim() === "") return false;
  }
  if (rec.lastSeenTaxYear !== null && typeof rec.lastSeenTaxYear !== "number") {
    return false;
  }
  return true;
}
