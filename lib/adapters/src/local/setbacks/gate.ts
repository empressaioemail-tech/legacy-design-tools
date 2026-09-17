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
 * or fabricated citations, missing districts, missing verification state,
 * a non-canonical not_specified sentinel (G7), an UNflagged canonical sentinel
 * (G8, added 2026-09-17 by P-299) and a transcription-read value claiming more
 * confidence than that state can carry (G9, same change) BLOCK.
 *
 * Rule union and verdicts are kept in lockstep with the shared corpus package
 * (@empressaio/setback-corpus, src/setbacks/gate.ts) — see
 * src/__tests__/p299HeightFlagAndState.test.ts's divergence block, which runs
 * both implementations over every vendored table and asserts the same verdict.
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

/**
 * The ONLY value max_height_ft may carry when its provenance sets
 * `not_specified: true` (rule G7). Mirrors the shared corpus package's
 * `NOT_SPECIFIED_MAX_HEIGHT_FT` (@empressaio/setback-corpus rule G7): an
 * inconsistent sentinel is the silent-fallback defect class this gate exists
 * to catch, because a reader that drops the flag turns a placeholder into a
 * plausible-looking height.
 */
export const NOT_SPECIFIED_MAX_HEIGHT_FT = 999 as const;

/**
 * The fourth verification state (P-299 OT-2, 2026-09-17) — the honest name for
 * a value read out of a COPY of the governing instrument (a third-party mirror,
 * a browser render, or a transcription) rather than off the instrument's own
 * text. Spelled identically to the shared corpus package's constant.
 */
export const TRANSCRIPTION_READ = "transcription-read" as const;

/**
 * "primary-source-verified" is distinct from both existing states: the value
 * was read directly off a real primary legal source (ordinance text, an
 * official published summary table) and cross-checked against a second
 * primary source where one was available, but has never been round-tripped
 * against a real ingested code-section atom, because code-ontology ingestion
 * (zoning ordinances -> code-section atoms) has not shipped for this
 * jurisdiction yet. It is not a weaker "asserted" (which already means
 * something else in this corpus — lower confidence in a specific or derived
 * figure) and it is not "human-verified" (which the gate reads as an
 * implicit claim that atom_did resolves against a real corpus entry, which
 * would be false here). G2/G5 do not apply to it — there is no atom to
 * resolve or round-trip a quote against — see runSetbackGate. Only use this
 * state when a real check confirms no code-section atom corpus exists yet
 * for the jurisdiction (some jurisdictions already have one — check first).
 *
 * "transcription-read" (P-299 OT-2, 2026-09-17) is the honest state for a value
 * read out of a COPY of the governing instrument — a third-party mirror, a
 * browser render, or a transcription — rather than off the instrument's own
 * text. The read may be just as careful and the quote just as verbatim, but the
 * thing read was not the instrument, and "primary-source-verified" would hide
 * from every downstream reader which of the two it was.
 *
 * Like "primary-source-verified" it makes no atom-backing claim, so G2 does not
 * require an atom_did for it and G5 skips its quote round-trip; unlike that
 * state it carries a confidence ceiling (G9), because a copy can be stale,
 * selectively rendered, or mis-transcribed in ways a direct read cannot.
 * Same state name and same ceiling as the shared corpus package, so the two
 * gates stay provably one contract — see the divergence test.
 */
export type VerificationState =
  | "asserted"
  | "human-verified"
  | "primary-source-verified"
  | typeof TRANSCRIPTION_READ;

/**
 * The confidence ceiling a `transcription-read` value may carry (rule G9).
 * Mirrors @empressaio/setback-corpus's TRANSCRIPTION_READ_MAX_CONFIDENCE.
 */
export const TRANSCRIPTION_READ_MAX_CONFIDENCE = 0.75 as const;

/** States that make no atom-backing claim (G2 does not demand an atom_did for them). */
export const STATES_WITHOUT_ATOM_BACKING: ReadonlyArray<VerificationState> = [
  "primary-source-verified",
  TRANSCRIPTION_READ,
];

/** Every state G6 accepts. Kept in lockstep with the shared corpus package. */
export const VERIFICATION_STATES: ReadonlyArray<VerificationState> = [
  "asserted",
  "human-verified",
  "primary-source-verified",
  TRANSCRIPTION_READ,
];

/** One value's provenance entry. */
export interface ValueProvenance {
  /**
   * Omitted for `verification_state: "primary-source-verified"` and
   * "transcription-read" — neither claims a real atom exists to reference.
   * Populating a best-guess, repo-style convention ID here (e.g.
   * `waco_tx/coor/28-276`) that resolves against nothing is what actually
   * trips G2's "fabricated citation" block. Required for "asserted" /
   * "human-verified", both of which claim atom backing.
   */
  atom_did?: string;
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
  rule: "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";
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
      if (!VERIFICATION_STATES.includes(p.verification_state)) {
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

      // G9 — a transcription-read value may not claim more confidence than a
      // read of a copy can honestly support.
      if (
        p.verification_state === TRANSCRIPTION_READ &&
        isNumber(p.confidence) &&
        p.confidence > TRANSCRIPTION_READ_MAX_CONFIDENCE
      ) {
        results.push({
          rule: "G9",
          level: "block",
          district: district.district_name,
          field,
          message: `transcription-read confidence ${p.confidence} exceeds the ${TRANSCRIPTION_READ_MAX_CONFIDENCE} ceiling for a value read from a copy`,
        });
      }

      // G2 — citation resolves to a real atom at the cited section.
      // primary-source-verified and transcription-read make no atom-backing
      // claim (see ValueProvenance.atom_did): checking them against the corpus
      // is not the right check for those states, so each is reported as its
      // own honest category (a PASS-level G2 result) rather than silently
      // skipped or blocked on a corpus lookup that was never the point.
      let atom: SourceAtom | undefined;
      if (STATES_WITHOUT_ATOM_BACKING.includes(p.verification_state)) {
        const detail =
          p.verification_state === TRANSCRIPTION_READ
            ? "transcription-read: read from a copy of the instrument (mirror/render/transcription), not round-tripped against a corpus atom (no code-section atom corpus exists yet for this jurisdiction)"
            : "primary-source-verified: read directly from a primary source, not round-tripped against a corpus atom (no code-section atom corpus exists yet for this jurisdiction)";
        results.push({
          rule: "G2",
          level: "pass",
          district: district.district_name,
          field,
          message: detail,
        });
      } else {
        atom = p.atom_did ? atomByDid.get(p.atom_did) : undefined;
        if (!atom) {
          results.push({
            rule: "G2",
            level: "block",
            district: district.district_name,
            field,
            message: p.atom_did
              ? `cited atom_did not found in corpus: ${p.atom_did}`
              : `atom_did required for verification_state "${p.verification_state}" but missing`,
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
      }

      const isNotSpecified =
        p.not_specified === true || value === NOT_SPECIFIED;

      // G7 — max_height_ft's not_specified sentinel must be the ONE canonical
      // value (999), never a table-specific convention. An inconsistent
      // sentinel is exactly the silent-fallback defect class this gate exists
      // to catch: a correct reader ignores the number when the flag is set,
      // but a reader that drops the flag gets a different wrong answer per
      // table (100 ft is a physically plausible height where 999 is not).
      if (
        field === "max_height_ft" &&
        isNotSpecified &&
        value !== NOT_SPECIFIED_MAX_HEIGHT_FT
      ) {
        results.push({
          rule: "G7",
          level: "block",
          district: district.district_name,
          field,
          message: `max_height_ft is flagged not_specified but carries ${String(value)}, not the canonical sentinel ${NOT_SPECIFIED_MAX_HEIGHT_FT}`,
        });
      }

      // G8 — the canonical height sentinel must never appear UNflagged. G7
      // fixes one direction (a flagged value must BE 999); this one fixes the
      // direction that actually leaks — 999 sitting on a row without the flag
      // reads, to any consumer that trusts the number and drops the flag, as a
      // 999-foot building limit (the LDT envelope draw did exactly that before
      // P-299, see buildableEnvelope/derive.ts).
      if (
        field === "max_height_ft" &&
        !isNotSpecified &&
        value === NOT_SPECIFIED_MAX_HEIGHT_FT
      ) {
        results.push({
          rule: "G8",
          level: "block",
          district: district.district_name,
          field,
          message: `max_height_ft carries the canonical sentinel ${NOT_SPECIFIED_MAX_HEIGHT_FT} but is not flagged not_specified — a consumer that drops the flag reads this as a real ${NOT_SPECIFIED_MAX_HEIGHT_FT}-foot limit`,
        });
      }

      // No atom exists to round-trip a quote against for the states that make
      // no atom-backing claim — same reporting shape as not_specified (skip
      // G5) but for a different reason (no corpus, not an intentional absence).
      const skipQuoteRoundTrip =
        isNotSpecified ||
        STATES_WITHOUT_ATOM_BACKING.includes(p.verification_state);

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
      // section, presence already required via G1) and for the states that
      // make no atom-backing claim (primary-source-verified /
      // transcription-read — no atom body exists to round-trip against).
      if (!skipQuoteRoundTrip) {
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
