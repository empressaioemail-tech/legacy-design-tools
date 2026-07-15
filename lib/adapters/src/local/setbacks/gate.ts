/**
 * Setback extraction acceptance gate — executable checker.
 *
 * Spec: docs/setback-extraction-acceptance-gate.md
 *
 * Takes an extracted setback table (with the optional per-district
 * `provenance` block) plus the source code-section atoms for that
 * jurisdiction, and returns a pass/flag/block result per rule per value.
 *
 * The checker is intentionally dependency-free (no DB, no network) so it can
 * run in CI as a hard merge gate on a fan-out and be unit-tested against
 * fixtures. It never mutates its inputs and never auto-rejects a value on a
 * sanity-bound miss — out-of-band values FLAG for human review; only missing
 * or fabricated citations, missing districts, and missing verification state
 * BLOCK.
 */

import type { SetbackTable, SetbackDistrict } from "./index.js";

/** The seven numeric fields a district row carries. */
export const SETBACK_NUMERIC_FIELDS = [
  "front_ft",
  "rear_ft",
  "side_ft",
  "side_corner_ft",
  "max_height_ft",
  "max_lot_coverage_pct",
  "max_impervious_pct",
] as const;

export type SetbackNumericField = (typeof SETBACK_NUMERIC_FIELDS)[number];

/** Inclusive sanity bands (rule G3). Outside -> FLAG, never auto-reject. */
export const SANITY_BOUNDS: Record<SetbackNumericField, [number, number]> = {
  front_ft: [0, 100],
  rear_ft: [0, 100],
  side_ft: [0, 75],
  side_corner_ft: [0, 75],
  max_height_ft: [0, 300],
  max_lot_coverage_pct: [0, 100],
  max_impervious_pct: [0, 100],
};

/** Sentinel a value carries when the ordinance genuinely does not state it. */
export const NOT_SPECIFIED = "not_specified" as const;

export type VerificationState = "asserted" | "human-verified";

/** One value's provenance entry. */
export interface ValueProvenance {
  atom_did: string;
  section_number: string;
  quote: string;
  confidence: number;
  verification_state: VerificationState;
  /** Set true when the value is the NOT_SPECIFIED sentinel (honest gap). */
  not_specified?: boolean;
}

/** The optional per-district audit block the gate reads. */
export type DistrictProvenance = Partial<
  Record<SetbackNumericField, ValueProvenance>
>;

/** A district row carrying the strictly-typed optional provenance block. */
export type GatedSetbackDistrict = Omit<SetbackDistrict, "provenance"> & {
  provenance?: DistrictProvenance;
};

export type GatedSetbackTable = Omit<SetbackTable, "districts"> & {
  districts: GatedSetbackDistrict[];
};

/** A source code-section atom, as supplied to the checker. */
export interface SourceAtom {
  /** The atom DID / entityId, e.g. `san_marcos_tx/<edition>/<...>/4.1.2`. */
  entityId: string;
  sectionNumber: string | null;
  bodyText: string | null;
  sourceUrl?: string;
}

export type ResultLevel = "pass" | "flag" | "block";

export interface RuleResult {
  rule: "G1" | "G2" | "G3" | "G4" | "G5" | "G6";
  level: ResultLevel;
  district: string | null;
  field: SetbackNumericField | null;
  message: string;
}

export interface GateReport {
  jurisdictionKey: string;
  /** True when a `provenance` block is present on at least one district. */
  gated: boolean;
  results: RuleResult[];
  counts: { pass: number; flag: number; block: number };
  /** True iff there are zero BLOCK results. CI should fail on `!passed`. */
  passed: boolean;
}

export interface GateInput {
  table: GatedSetbackTable;
  atoms: SourceAtom[];
  /**
   * The full set of zoning district names the jurisdiction's zoning atom
   * names (rule G4). Case-insensitive comparison against table rows. Supply
   * `undefined` to skip G4 (e.g. when the zoning-district set is not yet
   * extracted) — the checker records a single informational result noting the
   * skip rather than silently passing coverage.
   */
  expectedDistricts?: string[];
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Run the acceptance gate. Pure: does not mutate inputs.
 */
export function runSetbackGate(input: GateInput): GateReport {
  const { table, atoms, expectedDistricts } = input;
  const results: RuleResult[] = [];

  // Index atoms by DID and by section number for fast citation resolution.
  const atomByDid = new Map<string, SourceAtom>();
  for (const a of atoms) atomByDid.set(a.entityId, a);

  const gated = table.districts.some(
    (d) => d.provenance && Object.keys(d.provenance).length > 0,
  );

  for (const district of table.districts) {
    const prov = district.provenance ?? {};
    for (const field of SETBACK_NUMERIC_FIELDS) {
      const value = (district as unknown as Record<string, unknown>)[field];
      const p = prov[field];

      // G1 — citation presence.
      if (!p) {
        results.push({
          rule: "G1",
          level: "block",
          district: district.district_name,
          field,
          message: `no provenance/citation for ${field}`,
        });
        continue; // nothing else to check for an uncited value
      }

      // G6 — verification state + confidence present and valid.
      if (
        p.verification_state !== "asserted" &&
        p.verification_state !== "human-verified"
      ) {
        results.push({
          rule: "G6",
          level: "block",
          district: district.district_name,
          field,
          message: `missing/invalid verification_state (${String(p.verification_state)})`,
        });
      }
      if (!isNumber(p.confidence) || p.confidence < 0 || p.confidence > 1) {
        results.push({
          rule: "G6",
          level: "block",
          district: district.district_name,
          field,
          message: `confidence out of [0,1] (${String(p.confidence)})`,
        });
      }

      // G2 — citation resolves to a real atom at the cited section.
      const atom = atomByDid.get(p.atom_did);
      if (!atom) {
        results.push({
          rule: "G2",
          level: "block",
          district: district.district_name,
          field,
          message: `cited atom_did not found in corpus: ${p.atom_did}`,
        });
      } else if (
        p.section_number &&
        atom.sectionNumber &&
        norm(atom.sectionNumber) !== norm(p.section_number)
      ) {
        results.push({
          rule: "G2",
          level: "block",
          district: district.district_name,
          field,
          message: `cited section ${p.section_number} != atom section ${atom.sectionNumber}`,
        });
      }

      const isNotSpecified =
        p.not_specified === true || value === NOT_SPECIFIED;

      // G3 — numeric sanity bounds (FLAG). Skipped for not_specified.
      if (!isNotSpecified) {
        if (!isNumber(value)) {
          results.push({
            rule: "G3",
            level: "block",
            district: district.district_name,
            field,
            message: `value is not a finite number (${String(value)})`,
          });
        } else {
          const [lo, hi] = SANITY_BOUNDS[field];
          if (value < lo || value > hi) {
            results.push({
              rule: "G3",
              level: "flag",
              district: district.district_name,
              field,
              message: `value ${value} outside sanity band [${lo}, ${hi}] — human review`,
            });
          }
        }
      }

      // G5 — round-trip quote. Block on human-verified mismatch, flag on
      // asserted mismatch. Skipped for not_specified (quote is of the silent
      // section, presence already required via G1).
      if (!isNotSpecified) {
        const body = atom?.bodyText ?? "";
        const quoteOk =
          typeof p.quote === "string" &&
          p.quote.length > 0 &&
          body.toLowerCase().includes(p.quote.toLowerCase());
        if (!quoteOk) {
          const verified = p.verification_state === "human-verified";
          results.push({
            rule: "G5",
            level: verified ? "block" : "flag",
            district: district.district_name,
            field,
            message: verified
              ? `human-verified value's quote not found in cited atom body`
              : `asserted value's quote not found in cited atom body — human review`,
          });
        }
      }
    }
  }

  // G4 — district coverage.
  if (expectedDistricts === undefined) {
    results.push({
      rule: "G4",
      level: "flag",
      district: null,
      field: null,
      message:
        "expectedDistricts not supplied — district coverage NOT checked (extract the zoning-district set to enable G4)",
    });
  } else {
    const have = new Set(table.districts.map((d) => norm(d.district_name)));
    for (const want of expectedDistricts) {
      if (!have.has(norm(want))) {
        results.push({
          rule: "G4",
          level: "block",
          district: want,
          field: null,
          message: `zoning district "${want}" named by the ordinance has no row`,
        });
      }
    }
  }

  const counts = { pass: 0, flag: 0, block: 0 };
  for (const r of results) counts[r.level]++;
  // "pass" count is informational: number of clean rule evaluations is not
  // tracked per-value here; we report block/flag which are the actionable
  // buckets. `passed` is the CI gate.
  const passed = counts.block === 0;

  return {
    jurisdictionKey: table.jurisdictionKey,
    gated,
    results,
    counts,
    passed,
  };
}

/** Human-readable one-line-per-result formatter for CLI / logs. */
export function formatGateReport(report: GateReport): string {
  const lines: string[] = [];
  lines.push(
    `Setback gate: ${report.jurisdictionKey} — ${
      report.passed ? "PASS (no blocks)" : "BLOCKED"
    } | blocks=${report.counts.block} flags=${report.counts.flag} | gated=${report.gated}`,
  );
  for (const r of report.results) {
    const loc = [r.district, r.field].filter(Boolean).join("/");
    lines.push(`  [${r.level.toUpperCase()}] ${r.rule} ${loc}: ${r.message}`);
  }
  return lines.join("\n");
}
