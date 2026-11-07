/**
 * P-299 — height flag + the transcription-read state, on LDT's side.
 *
 * Dispatch: doc_repo `_dispatches/2026-09-17_p299-height-flag-and-state_dispatch.md`
 * Rulings:  doc_repo `_decisions/2026-09-17_setback_corpus_flag_state_and_default_line_rulings.md` (OT-1, OT-2)
 *
 * What this file proves, and why each block exists:
 *
 *  1. CONTRACT PARITY (the divergence block). LDT's `gate.ts` is a second
 *     implementation of the same acceptance contract as the shared package
 *     `@empressaio/setback-corpus` (pinned here at ^1.2.0, 1.4.0 in the corpus
 *     repo). A second implementation that drifts is worse than no second
 *     implementation, so the shared identifiers are asserted here literally and
 *     this repo's own `schema.json` enum is asserted to BE the checker's state
 *     list. Renaming or re-numbering on either side fails here rather than
 *     silently admitting a value the other side would block.
 *
 *  2. G2/G5 parity for the new state: a `transcription-read` row needs no corpus
 *     atom (same treatment as `primary-source-verified`) — and an `asserted` row
 *     with no atom still blocks, which is the falsifier that stops the new state
 *     from becoming a general amnesty.
 *
 *  3. G7/G8/G9 — the three new rules, each exercised in both directions.
 *
 *  4. Every table this repo ships, run through this repo's gate, with no
 *     G6/G7/G8/G9 block anywhere and the sentinel/flag invariant checked
 *     directly on the data. (The corpus-side half of the same run is
 *     `p299-height-flag-and-state.test.ts` in hauska-setback-corpus.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getSetbackTable,
  SETBACK_JURISDICTION_KEYS,
  type SetbackTable,
} from "../local/setbacks";
import {
  runSetbackGate,
  NOT_SPECIFIED,
  NOT_SPECIFIED_MAX_HEIGHT_FT,
  STATES_WITHOUT_ATOM_BACKING,
  TRANSCRIPTION_READ,
  TRANSCRIPTION_READ_MAX_CONFIDENCE,
  VERIFICATION_STATES,
  type GatedSetbackDistrict,
  type GatedSetbackTable,
  type SourceAtom,
  type VerificationState,
} from "../local/setbacks/gate";

/** The same atom the existing gate tests use, so fixtures stay comparable. */
const ATOMS: SourceAtom[] = [
  {
    entityId: "demo_tx/demo-udc-2025/4.1.2",
    sectionNumber: "4.1.2",
    bodyText:
      "SF-6 Single Family Residential. Minimum front yard: 25 feet. " +
      "Minimum rear yard: 10 feet. Minimum side yard: 5 feet. " +
      "Corner side yard: 15 feet. Maximum building height: 35 feet.",
    sourceUrl: "https://example.gov/udc#4.1.2",
  },
];

const OTHER_FIELDS = [
  "front_ft",
  "rear_ft",
  "side_ft",
  "side_corner_ft",
  "max_lot_coverage_pct",
  "max_impervious_pct",
] as const;

/**
 * A district whose seven values are clean, with `max_height_ft` set exactly as
 * the case under test needs. `state`/`confidence`/`notSpecified`/`withAtom`
 * apply to the height slot only — the other six fields stay clean and cited so
 * the results can only contain what the test is about.
 */
function districtWithHeight(args: {
  height: number;
  state: VerificationState;
  confidence: number;
  notSpecified?: boolean;
  withAtom?: boolean;
}): GatedSetbackDistrict {
  const base = {
    section_number: "4.1.2",
    quote: "Minimum front yard: 25 feet.",
    confidence: 0.9,
    verification_state: "human-verified" as VerificationState,
    atom_did: "demo_tx/demo-udc-2025/4.1.2",
  };
  return {
    district_name: "SF-6 Single Family",
    front_ft: 25,
    rear_ft: 10,
    side_ft: 5,
    side_corner_ft: 15,
    max_height_ft: args.height,
    max_lot_coverage_pct: 40,
    max_impervious_pct: 55,
    citation_url: "https://example.gov/udc#4.1.2",
    provenance: {
      ...Object.fromEntries(OTHER_FIELDS.map((f) => [f, { ...base }])),
      max_height_ft: {
        ...base,
        confidence: args.confidence,
        verification_state: args.state,
        ...(args.withAtom === false ? { atom_did: undefined } : {}),
        ...(args.notSpecified ? { not_specified: true } : {}),
      },
    },
  };
}

function tableWith(d: GatedSetbackDistrict): GatedSetbackTable {
  return {
    jurisdictionKey: "test-tx",
    jurisdictionDisplayName: "Test, TX",
    districts: [d],
  };
}

function gated(t: SetbackTable): GatedSetbackTable {
  return t as GatedSetbackTable;
}

function heightSlot(d: SetbackTable["districts"][number]) {
  return d.provenance?.["max_height_ft"] as
    | { not_specified?: boolean; verification_state?: string; confidence?: number }
    | undefined;
}

/**
 * Block results that are about the missing atom supply rather than about the
 * change under test. This repo ships one atom fixture, not the code-ontology
 * corpus, so `asserted`/`human-verified` values whose atom_did resolves against
 * a real store cannot be round-tripped in a unit test; the corpus-side test
 * excludes the same class for the same reason.
 */
function isAtomSupplyBlock(r: { rule: string; message: string }): boolean {
  return (
    (r.rule === "G2" &&
      (r.message.startsWith("cited atom_did not found in corpus:") ||
        r.message.startsWith("atom_did required for verification_state"))) ||
    r.rule === "G5"
  );
}

describe("P-299 divergence — LDT's gate and the shared corpus contract are one contract", () => {
  it("the shared identifiers are the corpus package's own values", () => {
    // hauska-setback-corpus src/setbacks/gate.ts (1.4.0):
    //   export const TRANSCRIPTION_READ = "transcription-read"
    //   export const TRANSCRIPTION_READ_MAX_CONFIDENCE = 0.75
    //   export const NOT_SPECIFIED_MAX_HEIGHT_FT = 999
    //   export const NOT_SPECIFIED = "not_specified"
    // If the corpus ever moves any of these, this test is the tripwire on LDT's
    // side: the two repos must move together, because reading one repo's data
    // with the other repo's rules is exactly the silent divergence P-299 asks
    // this check to prevent.
    expect(TRANSCRIPTION_READ).toBe("transcription-read");
    expect(TRANSCRIPTION_READ_MAX_CONFIDENCE).toBe(0.75);
    expect(NOT_SPECIFIED_MAX_HEIGHT_FT).toBe(999);
    expect(NOT_SPECIFIED).toBe("not_specified");
  });

  it("the checker's state list and this repo's schema.json enum are the same four states", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../local/setbacks/schema.json", import.meta.url), "utf8"),
    ) as {
      $defs: {
        district: {
          properties: {
            provenance: {
              additionalProperties: {
                properties: { verification_state: { enum: string[] } };
              };
            };
          };
        };
      };
    };
    const enumFromSchema =
      schema.$defs.district.properties.provenance.additionalProperties.properties
        .verification_state.enum;
    expect([...enumFromSchema].sort()).toEqual(
      ["asserted", "human-verified", "primary-source-verified", TRANSCRIPTION_READ].sort(),
    );
    expect([...VERIFICATION_STATES].sort()).toEqual([...enumFromSchema].sort());
  });

  it("the states that skip G2/G5 atom work are exactly the non-atom-claiming states", () => {
    expect([...STATES_WITHOUT_ATOM_BACKING].sort()).toEqual(
      ["primary-source-verified", TRANSCRIPTION_READ].sort(),
    );
  });
});

describe("P-299 — G2/G5 treat transcription-read like primary-source-verified", () => {
  it("a transcription-read height with NO atom_did is not blocked (the state makes no atom claim)", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({
          height: 999,
          state: TRANSCRIPTION_READ,
          confidence: 0.7,
          notSpecified: true,
          withAtom: false,
        }),
      ),
      atoms: ATOMS,
    });
    expect(report.results.filter((r) => r.rule === "G2" && r.level === "block")).toEqual([]);
    expect(report.results.filter((r) => r.rule === "G5")).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("FALSIFIER 4 (LDT half): an `asserted` value with no atom_did STILL blocks — the new state is not a general amnesty", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 35, state: "asserted", confidence: 0.7, withAtom: false }),
      ),
      atoms: ATOMS,
    });
    const g2 = report.results.filter((r) => r.rule === "G2" && r.level === "block");
    expect(g2.some((r) => r.message.includes("atom_did required"))).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("G6 accepts the new state (a table carrying it is not blocked as 'invalid verification_state')", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 35, state: TRANSCRIPTION_READ, confidence: 0.7, withAtom: false }),
      ),
      atoms: ATOMS,
    });
    expect(
      report.results.filter((r) => r.rule === "G6" && r.message.includes("invalid verification_state")),
    ).toEqual([]);
  });

  it("G9: a transcription-read value above the 0.75 ceiling blocks; at the ceiling it passes", () => {
    const over = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 35, state: TRANSCRIPTION_READ, confidence: 0.9, withAtom: false }),
      ),
      atoms: ATOMS,
    });
    const g9 = over.results.filter((r) => r.rule === "G9");
    expect(g9).toHaveLength(1);
    expect(g9[0]!.level).toBe("block");
    expect(over.passed).toBe(false);

    const at = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 35, state: TRANSCRIPTION_READ, confidence: 0.75, withAtom: false }),
      ),
      atoms: ATOMS,
    });
    expect(at.results.filter((r) => r.rule === "G9")).toEqual([]);
    expect(at.passed).toBe(true);
  });

  it("G9 does not touch the other states: a 0.9 primary-source-verified value is fine", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({
          height: 35,
          state: "primary-source-verified",
          confidence: 0.9,
          withAtom: false,
        }),
      ),
      atoms: ATOMS,
    });
    expect(report.results.filter((r) => r.rule === "G9")).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe("P-299 — G7/G8: the height sentinel and its flag must agree", () => {
  it("G7: flagged with a non-canonical sentinel (100) blocks", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 100, state: "asserted", confidence: 0.6, notSpecified: true }),
      ),
      atoms: ATOMS,
    });
    const g7 = report.results.filter((r) => r.rule === "G7");
    expect(g7).toHaveLength(1);
    expect(g7[0]!.level).toBe("block");
    expect(report.passed).toBe(false);
  });

  it("G8: the canonical sentinel WITHOUT the flag blocks — the direction that leaked into LDT's envelope draw", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 999, state: "asserted", confidence: 0.6, notSpecified: false }),
      ),
      atoms: ATOMS,
    });
    const g8 = report.results.filter((r) => r.rule === "G8");
    expect(g8).toHaveLength(1);
    expect(g8[0]!.level).toBe("block");
    expect(report.passed).toBe(false);
  });

  it("flagged + canonical sentinel passes both rules (the honest shape)", () => {
    const report = runSetbackGate({
      table: tableWith(
        districtWithHeight({ height: 999, state: "asserted", confidence: 0.6, notSpecified: true }),
      ),
      atoms: ATOMS,
    });
    expect(report.results.filter((r) => r.rule === "G7" || r.rule === "G8")).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("G7/G8 are scoped to max_height_ft: the same shapes on front_ft trip neither rule", () => {
    const flagged = districtWithHeight({
      height: 999,
      state: "asserted",
      confidence: 0.6,
      notSpecified: true,
    });
    flagged.front_ft = 999;
    flagged.provenance!.front_ft!.not_specified = true;
    expect(runSetbackGate({ table: tableWith(flagged), atoms: ATOMS }).results.filter(
      (r) => r.rule === "G7" || r.rule === "G8",
    )).toEqual([]);

    const unflagged = districtWithHeight({
      height: 999,
      state: "asserted",
      confidence: 0.6,
      notSpecified: true,
    });
    unflagged.rear_ft = 999;
    expect(runSetbackGate({ table: tableWith(unflagged), atoms: ATOMS }).results.filter(
      (r) => r.rule === "G8",
    )).toEqual([]);
  });
});

describe("P-299 — the gate over every table this repo ships", () => {
  const tables = SETBACK_JURISDICTION_KEYS.map((k) => [k, getSetbackTable(k)!] as const);

  it("covers every shipped jurisdiction key, and most tables are gated", () => {
    expect(tables.length).toBeGreaterThanOrEqual(39);
    const gatedCount = tables.filter(([, t]) =>
      t.districts.some((d) => d.provenance && Object.keys(d.provenance).length > 0),
    ).length;
    expect(gatedCount).toBeGreaterThanOrEqual(30);
  });

  it("no table blocks on G6/G7/G8/G9 — every shipped height sentinel is canonical and flagged, no transcription-read value overclaims, no state is unknown to the checker", () => {
    const offenders: string[] = [];
    for (const [key, table] of tables) {
      const report = runSetbackGate({ table: gated(table), atoms: ATOMS });
      for (const r of report.results) {
        if (r.level !== "block") continue;
        if (r.rule !== "G6" && r.rule !== "G7" && r.rule !== "G8" && r.rule !== "G9") continue;
        offenders.push(`${key} :: ${r.rule} ${r.district}/${String(r.field)} — ${r.message}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no shipped table blocks on anything P-299 touches, and nothing outside the two known-legacy classes (G1 on un-gated legacy rows, atom-supply G2/G5)", () => {
    const offenders: string[] = [];
    let legacyG1 = 0;
    for (const [key, table] of tables) {
      const report = runSetbackGate({ table: gated(table), atoms: ATOMS });
      for (const r of report.results) {
        if (r.level !== "block") continue;
        // Known, documented class 1: the four legacy hand-curated tables (and
        // the legacy rows inside partly-gated ones) carry no provenance block,
        // so every field trips G1. index.ts documents them as un-gated; this
        // test does not pretend otherwise, it counts them.
        if (r.rule === "G1") {
          legacyG1++;
          continue;
        }
        // Known, documented class 2: the atom corpus is not shipped here.
        if (isAtomSupplyBlock(r)) continue;
        offenders.push(`${key} :: ${r.rule} ${r.district}/${String(r.field)} — ${r.message}`);
      }
    }
    expect(legacyG1).toBeGreaterThan(0); // the legacy tables really are in this run
    expect(offenders).toEqual([]);
  });

  it("every max_height_ft exactly 999 in a shipped table carries the flag (G8 holds on the data, not just on fixtures)", () => {
    const bad: string[] = [];
    for (const [key, table] of tables) {
      for (const d of table.districts) {
        if (d.max_height_ft !== 999) continue;
        if (heightSlot(d)?.not_specified !== true) bad.push(`${key} :: ${d.district_name}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every flagged max_height_ft carries the canonical sentinel (G7 holds on the data)", () => {
    const bad: string[] = [];
    for (const [key, table] of tables) {
      for (const d of table.districts) {
        if (heightSlot(d)?.not_specified === true && d.max_height_ft !== 999) {
          bad.push(`${key} :: ${d.district_name} = ${d.max_height_ft}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * The same guard the corpus package carries: these vendored files' `P-299 OT-1`
   * notes state the flag-clearing basis PER ROW, because the rows do not share
   * one (6 quotes state the figure the instrument tabulates; 34 quotes name the
   * column without restating the number, and those rest on the OPS-21-R1
   * instrument's REAL_VALUE_FLAGGED classification). Vending a copy of that note
   * means vending the claim, so the claim is checked here too — including on the
   * day a value is edited and its quote is not.
   */
  it("the vendored OT-1 notes state their basis per row, and the split they state is the one the quotes support", () => {
    const listAfter = (note: string, marker: string): string[] => {
      const open = note.indexOf(marker);
      if (open < 0) return [];
      const start = note.indexOf("(", open + marker.length);
      if (start < 0) return [];
      let depth = 0;
      for (let i = start; i < note.length; i++) {
        if (note[i] === "(") depth++;
        else if (note[i] === ")" && --depth === 0) {
          return note
            .slice(start + 1, i)
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
      throw new Error(`unterminated list after ${marker}`);
    };
    const says = (quote: string, value: number) =>
      new RegExp(`(^|[^0-9.])${String(value).replace(".", "\\.")}([^0-9]|$)`).test(quote);
    const nameOf = (item: string) => item.replace(/\s*\(keeps [^)]*\)$/, "");
    const valueOf = (item: string) => Number(/\(keeps ([0-9.]+)\)/.exec(item)?.[1]);

    const offenders: string[] = [];
    let quoteBasis = 0;
    let instrumentBasis = 0;
    for (const [key, table] of tables) {
      const note = table.note ?? "";
      if (!/P-299 OT-1/.test(note)) continue;
      for (const [list, marker, isQuoted] of [
        [listAfter(note, "the row's own quote states the feet figure"), "quote", true],
        [listAfter(note, "the discriminator the ruling names"), "instrument", false],
      ] as const) {
        for (const item of list) {
          const d = table.districts.find((x) => x.district_name === nameOf(item));
          if (!d) {
            offenders.push(`${key}: note names a district this table does not have: ${item}`);
            continue;
          }
          if (isQuoted) quoteBasis++;
          else instrumentBasis++;
          const statesIt = says(heightSlot(d)?.quote ?? "", valueOf(item));
          if (isQuoted && !statesIt) {
            offenders.push(`${key}/${nameOf(item)}: note says the QUOTE states ${valueOf(item)}, it does not`);
          }
          if (!isQuoted && statesIt) {
            offenders.push(
              `${key}/${nameOf(item)}: note says the quote does NOT state ${valueOf(item)}, it does — this row belongs in the quoted list`,
            );
          }
          if (heightSlot(d)?.not_specified === true) {
            offenders.push(`${key}/${nameOf(item)}: note says the flag was cleared, the row is still flagged`);
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
    expect(quoteBasis).toBeGreaterThan(0);
    expect(instrumentBasis).toBeGreaterThan(0);
  });

  it("every value's verification_state is one of the four states the checker knows (no fifth state, no stale spelling)", () => {
    const bad: string[] = [];
    const known = new Set<string>(VERIFICATION_STATES);
    for (const [key, table] of tables) {
      for (const d of table.districts) {
        for (const [field, slot] of Object.entries(d.provenance ?? {})) {
          const state = (slot as { verification_state?: string }).verification_state;
          if (state && !known.has(state)) bad.push(`${key} :: ${d.district_name}.${field} = ${state}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the 12 tables whose note records a copy channel carry transcription-read values (the OT-2 relabel landed, and stayed)", () => {
    // Named explicitly rather than inferred from note text: this is the list
    // OT-2 relabelled (P-299), and a table that silently reverts to
    // primary-source-verified has to fail something.
    const relabelled = [
      "austin-tx",
      "bellmead-tx",
      "beverly-hills-tx",
      "jarrell-tx",
      "jonestown-tx",
      "kyle-tx",
      "luling-tx",
      "robinson-tx",
      "round-rock-tx",
      "seguin-tx",
      "waco-tx",
      "woodway-tx",
    ];
    const missing: string[] = [];
    for (const key of relabelled) {
      const table = getSetbackTable(key);
      expect(table, `table ${key} missing`).not.toBeNull();
      const slots = (table as SetbackTable).districts.flatMap((d) =>
        Object.values(d.provenance ?? {}),
      ) as { verification_state?: string; confidence?: number }[];
      const relabelledSlots = slots.filter((s) => s.verification_state === TRANSCRIPTION_READ);
      if (relabelledSlots.length === 0) missing.push(`${key}: no transcription-read slot`);
      const overCeiling = relabelledSlots.filter(
        (s) => typeof s.confidence === "number" && s.confidence > TRANSCRIPTION_READ_MAX_CONFIDENCE,
      );
      if (overCeiling.length) {
        missing.push(`${key}: ${overCeiling.length} slot(s) above the G9 ceiling`);
      }
    }
    expect(missing).toEqual([]);
  });
});
