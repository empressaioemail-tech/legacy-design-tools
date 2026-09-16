/**
 * P-297 / P-269 — the one cell-serve rule, pinned four ways.
 *
 * 1. THE FIXTURE IS THE CONTRACT. `__fixtures__/cell-serve-rule.json` holds one
 *    row per parcel_record cell state with the decision that state must
 *    produce. The moment this rule and the fixture disagree, this suite fails —
 *    that is falsifier 5 ("editing the shared fixture without the function, or
 *    the reverse, fails a test"), and it is also how the hauska-engine lane is
 *    held to the same table. The row-name list is pinned too, so deleting a
 *    row to make a disagreement go away fails rather than passes.
 *
 * 2. THE SLATE, NOT THE VERDICT, IS THE SWITCH (falsifier 4). The rule module
 *    cannot import the verdict reader; no production module may import
 *    `resolveAllowlist` / `resolveAllowlistState` / `resolveVerdictStore` at
 *    all any more, and every `*ServeCutover.ts` module must ask its serve
 *    question of `cellServeRule.ts`. Both are checked by reading the source
 *    files — a test that would fail if the county verdict were wired back into
 *    the serve path.
 *
 * 3. THE TWO ENTRY POINTS CANNOT DRIFT. `isSlatedForCellServe` is
 *    `resolveCellServeDecision`'s first branch, extracted so a wrapper
 *    deciding six rails at once (cadRoll) does not have to read six cells to
 *    learn the slate answer. The equivalence is asserted for every pair in the
 *    live slate and for representative unslated pairs.
 *
 * 4. THE ADAPTERS AGREE. The rule says "refusal, code X"; the rail adapters
 *    are what actually serve the customer. `wellFactFromParcelRecord` (the
 *    simplest of the 18) is run over the fixture's own cell states and must
 *    produce the SAME refusal code the rule named, on the SAME wire code
 *    vocabulary `cadRollFactFromParcelRecord.ts` uses. If an adapter ever
 *    starts answering a different question than the rule, this fails.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import {
  CELL_SERVE_NOT_SLATED_REASON,
  CELL_SERVE_RULE_ID,
  isSlatedForCellServe,
  loadCellServeDecision,
  resolveCellServeDecision,
  type CellServeDecision,
} from "./cellServeRule";
import {
  interpretParcelRecordCell,
  memoryParcelRecordStore,
  resetParcelRecordQueryableForTests,
  setParcelRecordQueryableForTests,
  type ParcelRecordCellRead,
} from "./parcelRecordCellRead";
import { PARCEL_RECORD_SLATE } from "./parcelRecordAllowlist";
import { PARCEL_RECORD_REFUSAL_CODES } from "./cadRollFactFromParcelRecord";
import { wellFactFromParcelRecord } from "./wellFactFromParcelRecord";

afterEach(() => {
  resetParcelRecordQueryableForTests();
});

const FIXTURE_URL = new URL("./__fixtures__/cell-serve-rule.json", import.meta.url);
const FIXTURE_DIR = new URL("./__fixtures__/", import.meta.url);

type FixtureRow = {
  name: string;
  slated: boolean;
  cellState: unknown;
  companionRows: ReadonlyArray<{
    rowIndex: number;
    payload: unknown;
    source: string;
    vintage: string;
  }>;
  expect: {
    serve: "cell" | "current-path";
    form: "value" | "absence" | "refusal" | null;
    absenceVerdict: "absent-verified" | "not-applicable" | null;
    refusalCode: string | null;
  };
};

function loadFixture(): {
  _ruleId: string;
  rows: FixtureRow[];
} {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as { _ruleId: string; rows: FixtureRow[] };
}

function cellForRow(row: FixtureRow): ParcelRecordCellRead | null {
  if (row.cellState === null) return null;
  return interpretParcelRecordCell(
    "48021:34137",
    "wells",
    row.cellState,
    row.companionRows.map((c) => ({
      row_index: c.rowIndex,
      payload: c.payload,
      source: c.source,
      vintage: c.vintage,
    })),
  );
}

/**
 * The pinned row set. Adding a row is fine and expected (the engine lane may
 * add one to document a state it discovered); REMOVING or renaming one fails
 * here, because a quietly removed row is exactly how a fixture stops being a
 * contract.
 */
const PINNED_ROW_NAMES = [
  "unslated-value-cell-keeps-the-current-path",
  "unslated-no-cell-keeps-the-current-path",
  "slated-value-cell-is-served-as-its-value",
  "slated-verified-zero-is-served-as-zero-not-as-an-absence",
  "slated-value-cell-with-companion-rows-is-still-a-value",
  "slated-absent-verified-is-served-as-the-stated-absence",
  "slated-not-applicable-is-a-stated-absence-not-a-refusal",
  "slated-refused-cell-is-a-declared-refusal-carrying-the-engines-own-reason",
  "slated-unaccounted-cell-is-a-declared-refusal-never-a-legacy-value",
  "slated-malformed-cell-is-a-declared-refusal-not-a-guess",
  "slated-no-cell-at-all-is-a-declared-refusal-naming-the-missing-row",
];

describe("the shared fixture (__fixtures__/cell-serve-rule.json)", () => {
  it("names itself with this module's own rule id and carries every fixture file in the shared dir", () => {
    const fixture = loadFixture();
    expect(fixture._ruleId).toBe(CELL_SERVE_RULE_ID);
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(files).toContain("cell-serve-rule.json");
  });

  it("still carries exactly the pinned rows -- an added row is fine, a removed or renamed one is not", () => {
    const { rows } = loadFixture();
    const names = rows.map((r) => r.name);
    for (const pinned of PINNED_ROW_NAMES) {
      expect(names, `fixture row "${pinned}" is missing`).toContain(pinned);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("FALSIFIER 5: every row's expectation is what the rule returns, and the four fields match exactly", () => {
    const { rows } = loadFixture();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const decision = resolveCellServeDecision(row.slated, cellForRow(row));
      expect(
        {
          serve: decision.serve,
          form: decision.form,
          absenceVerdict: decision.absenceVerdict,
          refusalCode: decision.refusalCode,
        },
        `fixture row "${row.name}" disagrees with the rule`,
      ).toEqual(row.expect);
    }
  });

  it("FALSIFIER 2: the unaccounted row is served a declared refusal carrying the cell's own reason -- never a value, never an absence", () => {
    const { rows } = loadFixture();
    const row = rows.find((r) => r.name === "slated-unaccounted-cell-is-a-declared-refusal-never-a-legacy-value");
    if (!row) throw new Error("unreachable: pinned row missing");
    const decision = resolveCellServeDecision(row.slated, cellForRow(row));
    expect(decision.form).toBe("refusal");
    expect(decision.refusalCode).toBe("unaccounted");
    // The reason the CUSTOMER sees is the cell reader's own sentence, verbatim.
    expect(decision.reason ?? "").toContain("has not yet examined this rail");
    expect(decision.absenceVerdict).toBeNull();
  });

  it("an unslated pair's decision carries the not-slated marker, and its reason is never a customer-facing refusal", () => {
    const { rows } = loadFixture();
    const row = rows.find((r) => r.name === "unslated-value-cell-keeps-the-current-path");
    if (!row) throw new Error("unreachable: pinned row missing");
    const decision = resolveCellServeDecision(row.slated, cellForRow(row));
    expect(decision.serve).toBe("current-path");
    expect(decision.refusalCode).toBeNull();
    expect(decision.reason).toBe(CELL_SERVE_NOT_SLATED_REASON);
  });

  it("a refusal cell's own reason is passed through verbatim (the engine's words, not a generic fallback)", () => {
    const { rows } = loadFixture();
    const row = rows.find(
      (r) => r.name === "slated-refused-cell-is-a-declared-refusal-carrying-the-engines-own-reason",
    );
    if (!row) throw new Error("unreachable: pinned row missing");
    const decision = resolveCellServeDecision(row.slated, cellForRow(row));
    const cellState = row.cellState as { reason?: string };
    expect(decision.reason).toBe(cellState.reason);
  });
});

describe("the two entry points are one rule", () => {
  it("isSlatedForCellServe agrees with resolveCellServeDecision for every pair in the live slate", () => {
    expect(PARCEL_RECORD_SLATE.size).toBeGreaterThan(0);
    for (const key of PARCEL_RECORD_SLATE) {
      const [countyFips, railKey] = key.split(":");
      expect(isSlatedForCellServe(countyFips, railKey)).toBe(true);
      expect(resolveCellServeDecision(true, null).serve).toBe("cell");
    }
  });

  it("an unslated pair is current-path from both entry points, whatever cell the store would hold", () => {
    const { rows } = loadFixture();
    const unslated = rows.filter((r) => !r.slated);
    expect(unslated.length).toBeGreaterThan(0);
    for (const row of unslated) {
      expect(isSlatedForCellServe("00000", "not-a-rail")).toBe(false);
      expect(resolveCellServeDecision(row.slated, cellForRow(row)).serve).toBe("current-path");
    }
  });

  it("an empty or whitespace county is never slated (no state may be served off a blank key)", () => {
    expect(isSlatedForCellServe("", "wells")).toBe(false);
    expect(isSlatedForCellServe("   ", "wells")).toBe(false);
  });
});

describe("loadCellServeDecision -- the I/O path over the same rule", () => {
  const STORE_NOT_CONFIGURED_ROW = "store-not-configured (the fixture's own _notCoveredHere row)";

  it(`${STORE_NOT_CONFIGURED_ROW} is a declared refusal on a slated rail, never a fallback`, async () => {
    // 48021 IS slated for wells. An unconfigured store used to mean "keep the
    // legacy value" on this path; under the ruling it is a declared refusal.
    setParcelRecordQueryableForTests(null);
    const decision = await loadCellServeDecision("48021", "34137", "wells");
    expect(decision.serve).toBe("cell");
    expect(decision.form).toBe("refusal");
    expect(decision.refusalCode).toBe("store-not-configured");
    expect(decision.reason ?? "").toContain("no RETRIEVAL_API_KEY");
  });

  it("an unslated pair short-circuits before any I/O, even with a store that would explode if queried", async () => {
    setParcelRecordQueryableForTests({
      async query() {
        throw new Error("this store must never be queried for an unslated pair");
      },
    });
    const decision = await loadCellServeDecision("00000", "1", "wells");
    expect(decision.serve).toBe("current-path");
  });

  it("a slated pair with no cell row is a declared refusal naming the missing row", async () => {
    setParcelRecordQueryableForTests(memoryParcelRecordStore({ cells: [] }));
    const decision = await loadCellServeDecision("48021", "34137", "wells");
    expect(decision.form).toBe("refusal");
    expect(decision.refusalCode).toBe("no-such-parcel-or-rail");
  });
});

/**
 * FALSIFIER 4, by source inspection: the county verdict cannot get back into
 * the serve path without failing here.
 */
describe("the county verdict is not the serve switch (source-level)", () => {
  const LIB_DIR = new URL("./", import.meta.url);
  const VERDICT_READER_MODULES = [
    "parcelGateVerdictRead",
    "parcelRecordAllowlist",
    "parcelGateVerdictVocabulary",
  ];

  function cutoverFiles(): string[] {
    return readdirSync(LIB_DIR)
      .filter((f) => /ServeCutover\.ts$/.test(f))
      .filter((f) => !f.endsWith(".test.ts"));
  }

  it("there are cutover modules to check at all (a vacuous scan must not pass)", () => {
    expect(cutoverFiles().length).toBeGreaterThanOrEqual(17);
  });

  it("EVERY cutover module decides through cellServeRule and imports no verdict reader", () => {
    for (const file of cutoverFiles()) {
      const src = readFileSync(new URL(file, LIB_DIR), "utf8");
      expect(src, `${file} does not ask cellServeRule`).toMatch(/from "\.\/cellServeRule"/);
      const importLines = src
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"));
      for (const verdictModule of VERDICT_READER_MODULES) {
        const offending = importLines.filter((line) => line.includes(`/${verdictModule}"`));
        expect(
          offending,
          `${file} imports ${verdictModule} again -- the verdict is a grade, not the serve switch`,
        ).toEqual([]);
      }
    }
  });

  it("resolveAllowlist / resolveAllowlistState / resolveVerdictStore have NO production importer left", () => {
    const productionFiles = readdirSync(LIB_DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
    );
    const allowlistItself = "parcelRecordAllowlist.ts";
    for (const file of productionFiles) {
      if (file === allowlistItself) continue;
      const src = readFileSync(new URL(file, LIB_DIR), "utf8");
      for (const symbol of ["resolveAllowlist", "resolveAllowlistState", "resolveVerdictStore"]) {
        const importLines = src
          .split("\n")
          .filter((line) => line.trimStart().startsWith("import") && line.includes(symbol));
        expect(
          importLines,
          `${file} imports ${symbol} -- no serve decision may branch on the county verdict (P-297)`,
        ).toEqual([]);
      }
    }
  });
});

/**
 * FALSIFIER: the rule and the ADAPTERS cannot disagree. Checked against
 * wellFactFromParcelRecord because it is the one adapter whose refusal
 * vocabulary is a plain map of the cell reader's own codes.
 */
describe("the rail adapters answer with the rule's own refusal vocabulary", () => {
  it("every refusal row's code is what wellFactFromParcelRecord serves for the same cell", async () => {
    const { rows } = loadFixture();
    const refusalRows = rows.filter(
      (r) => r.slated && r.expect.form === "refusal" && r.expect.refusalCode !== "no-such-parcel-or-rail",
    );
    expect(refusalRows.length).toBeGreaterThan(0);
    for (const row of refusalRows) {
      const decision = resolveCellServeDecision(row.slated, cellForRow(row));
      if (decision.refusalCode === null) throw new Error("unreachable");
      setParcelRecordQueryableForTests(
        memoryParcelRecordStore({
          cells: [{ placeKey: "48021:34137", railKey: "wells", cellState: row.cellState }],
        }),
      );
      const served = await wellFactFromParcelRecord("48021:34137");
      expect(served.state, `fixture row "${row.name}"`).toBe("refused");
      if (served.state !== "refused") throw new Error("unreachable");
      expect(served.code, `fixture row "${row.name}" disagrees with the rule`).toBe(
        PARCEL_RECORD_REFUSAL_CODES[decision.refusalCode],
      );
      resetParcelRecordQueryableForTests();
    }
  });

  it("the absence rows serve an absence in the adapter too -- a stated absence, never a refusal", async () => {
    const { rows } = loadFixture();
    const absenceRows = rows.filter((r) => r.slated && r.expect.form === "absence");
    expect(absenceRows.length).toBe(2);
    for (const row of absenceRows) {
      setParcelRecordQueryableForTests(
        memoryParcelRecordStore({
          cells: [{ placeKey: "48021:34137", railKey: "wells", cellState: row.cellState }],
        }),
      );
      const served = await wellFactFromParcelRecord("48021:34137");
      expect(served.state, `fixture row "${row.name}"`).toBe("absent");
      if (served.state !== "absent" || !served.absence) throw new Error("unreachable");
      expect(served.absence.kind).toBe(row.expect.absenceVerdict);
      resetParcelRecordQueryableForTests();
    }
  });

  it("a value cell with companion rows serves a present well in the adapter (the value form)", async () => {
    const { rows } = loadFixture();
    const row = rows.find((r) => r.name === "slated-value-cell-with-companion-rows-is-still-a-value");
    if (!row) throw new Error("unreachable: pinned row missing");
    setParcelRecordQueryableForTests(
      memoryParcelRecordStore({
        cells: [{ placeKey: "48021:34137", railKey: "wells", cellState: row.cellState }],
        companionRows: [
          {
            placeKey: "48021:34137",
            railKey: "wells",
            rowIndex: 0,
            payload: { api: "42000001030000", wellStatus: "dry", isOrphan: false },
            source: "tx_rrc",
            vintage: "2026-08-16",
          },
        ],
      }),
    );
    const served = await wellFactFromParcelRecord("48021:34137");
    expect(served.state).toBe("present");
  });
});

/** The fixture's own shape, restated for the hauska-engine lane's copy. */
describe("the fixture shape the engine lane mirrors", () => {
  it("every row carries exactly the four expected fields plus the inputs", () => {
    const { rows } = loadFixture();
    const decisionKeys: Array<keyof CellServeDecision> = [
      "serve",
      "form",
      "absenceVerdict",
      "refusalCode",
      "reason",
    ];
    expect(decisionKeys).toContain("serve");
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["cellState", "companionRows", "expect", "name", "slated"].sort(),
      );
      expect(Object.keys(row.expect).sort()).toEqual(
        ["absenceVerdict", "form", "refusalCode", "serve"].sort(),
      );
    }
  });
});
