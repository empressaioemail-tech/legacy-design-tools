/**
 * P-270 (OPS-24 scope X11) — unit tests for the ONE place in this repo that
 * decides whether a setback citation's effective date was readable AT SOURCE
 * and what the surface says when it was not. Pure functions: no DB, no
 * network.
 *
 * The groups below are the four questions the dispatch asks a lane to answer,
 * each carrying the falsifier it is meant to trip:
 *
 *   1. THE DECISION IS IN ONE PLACE — the exact sentence is pinned HERE, so a
 *      drift between this repo and hauska-map's copy is a failing test rather
 *      than a silent difference in what the customer reads.
 *   2. THE THREE STATES ARE THREE — absent-at-source, unparseable and
 *      never-looked asserted apart from each other, so collapsing any two
 *      into one boolean fails.
 *   3. THE ROW IS NEVER PUBLISHED WITHOUT A CITATION, AND NEVER ON A READABLE
 *      DATE — the agreeing control, asserted on both sides.
 *   4. THE DATE IS NEVER DEFAULTED — every unreadable case asserts
 *      `sourceDate === null`, so introducing a fallback date fails here.
 */

import { describe, expect, it } from "vitest";
import { dateFromTableEffectiveDate } from "@empressaio/setback-corpus/resolve";

import {
  NEVER_LOOKED_DATE_READ,
  SETBACK_CITATION_FUTURE_EFFECTIVE_TOKEN,
  SETBACK_CITATION_VINTAGE_TOKEN,
  SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE,
  applyFutureEffectiveState,
  disclosureWithCitationVintage,
  readableBasisOrNull,
  readAdoptedDateFromRowAtSource,
  readSetbackDateAtSource,
  readSetbackDateFromRowAtSource,
  readSetbackDateFromTable,
  setbackCitationVintageRow,
  setbackFutureEffectiveCardMarker,
  setbackFutureEffectiveNote,
  stateFromWireBasis,
  type SetbackDateRead,
  type SetbackDateReadState,
} from "./setbackCitationVintage";

const CITATION =
  "https://online.encodeplus.com/regs/pflugerville/doc-view.aspx?print=1&tocid=004.004";

describe("P-270 pin — the one customer sentence", () => {
  /**
   * THE DRIFT GUARD. hauska-map's
   * `apps/property-explorer/api/_lib/setback-citation-vintage.ts` pins this
   * identical literal in its own test. If either repo edits the sentence
   * alone, exactly one of the two suites fails: the customer cannot be told
   * two different things about one rule.
   */
  it("is byte-identical to the literal hauska-map pins", () => {
    expect(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE).toBe(
      "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.",
    );
  });

  it("names the consequence and the next step, and states no date of its own", () => {
    // A date here would enter the probe's disclosure-text fallback and read as
    // a real vintage — the exact silent pick this lane removes.
    expect(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE).not.toMatch(/\d{4}/);
    expect(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE).toContain("not as current");
    expect(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE).toContain("Verify with the city.");
  });

  it("publishes under the vocabulary token the conflict row is keyed by", () => {
    expect(SETBACK_CITATION_VINTAGE_TOKEN).toBe("setback-citation-vintage-unreadable");
  });
});

describe("P-270 — reading a codified table's date AT SOURCE", () => {
  it("a table with a readable own effectiveDate reads as `read`, carrying the date", () => {
    // The live shape: bastrop-development-code.json, one of the five tables in
    // lib/adapters/src/local/setbacks that carry the field at all.
    expect(readSetbackDateFromTable({ effectiveDate: "2026-04-14" })).toEqual({
      sourceDate: "2026-04-14",
      state: "read",
    });
  });

  it("PFLUGERVILLE'S OWN SHAPE: a table with NO effectiveDate key is absent-at-source, not unparseable", () => {
    // pflugerville-tx.json has no `effectiveDate` key at all (verified against
    // the shipped file), so the source's statement is "no date", and the
    // defect is not a malformed value.
    expect(readSetbackDateFromTable({ jurisdictionKey: "pflugerville-tx" })).toEqual({
      sourceDate: null,
      state: "unreadable-absent-at-source",
    });
  });

  it("a table whose effectiveDate is present and explicitly null is absent-at-source", () => {
    expect(readSetbackDateFromTable({ effectiveDate: null })).toEqual({
      sourceDate: null,
      state: "unreadable-absent-at-source",
    });
  });

  it("a table whose effectiveDate is populated with something that is not a date is unparseable", () => {
    for (const bad of ["April 2026", "2026-4-1", "accessed 2026-04-14", 20260414]) {
      expect(readSetbackDateFromTable({ effectiveDate: bad })).toEqual({
        sourceDate: null,
        state: "unreadable-unparseable",
      });
    }
  });

  it("never reads the table's `note` as a date, however date-shaped it looks", () => {
    // The corpus's own dateFromTableEffectiveDate doc says an "accessed ..."
    // note records when someone LOOKED. This asserts the refusal directly,
    // because the note is where a plausible-looking date always lives.
    expect(
      readSetbackDateFromTable({
        note: "accessed 2026-09-17; codified from the UDC adopted 2011-03-02",
        districts: [],
      }),
    ).toEqual({ sourceDate: null, state: "unreadable-absent-at-source" });
  });

  it("a table that is not an object at all is absent-at-source rather than a throw", () => {
    expect(readSetbackDateFromTable(null)).toEqual({
      sourceDate: null,
      state: "unreadable-absent-at-source",
    });
    expect(readSetbackDateFromTable(undefined)).toEqual({
      sourceDate: null,
      state: "unreadable-absent-at-source",
    });
  });
});

describe("P-270 — reading a companion row's date AT SOURCE", () => {
  it("a strict yyyy-mm-dd in a PRESENT key reads as `read`", () => {
    expect(readSetbackDateAtSource({ present: true, value: "2026-04-14" })).toEqual({
      sourceDate: "2026-04-14",
      state: "read",
    });
  });

  it("a key that is MISSING reads as absent-at-source, not unparseable", () => {
    expect(readSetbackDateAtSource({ present: false, value: undefined })).toEqual({
      sourceDate: null,
      state: "unreadable-absent-at-source",
    });
  });

  it("a POPULATED key this module will not accept as a date reads as unparseable", () => {
    for (const bad of ["April 2026", "2026-4-1", "2026", "", "see the ordinance"]) {
      expect(readSetbackDateAtSource({ present: true, value: bad })).toEqual({
        sourceDate: null,
        state: "unreadable-unparseable",
      });
    }
  });

  it("NEVER falls back to a default date: every unreadable read carries sourceDate null", () => {
    const reads: SetbackDateRead[] = [
      readSetbackDateAtSource({ present: false, value: undefined }),
      readSetbackDateAtSource({ present: true, value: null }),
      readSetbackDateAtSource({ present: true, value: "garbage" }),
      readSetbackDateFromTable({ jurisdictionKey: "pflugerville-tx" }),
      NEVER_LOOKED_DATE_READ,
      stateFromWireBasis("unreadable"),
      stateFromWireBasis(undefined),
    ];
    for (const read of reads) expect(read.sourceDate).toBeNull();
  });

  it("reads the first PRESENT key out of a row, so a null first key is not skipped for a later value", () => {
    expect(
      readSetbackDateFromRowAtSource(
        { effectiveDate: null, effective_date: "2026-04-14" },
        ["effectiveDate", "effective_date"],
      ),
    ).toEqual({ sourceDate: null, state: "unreadable-absent-at-source" });
  });

  it("a row with none of the keys is absent-at-source: the rail WAS consulted and stated nothing", () => {
    expect(
      readSetbackDateFromRowAtSource(
        { citationUrl: CITATION, districtCode: "SF-S" },
        ["effectiveDate", "effective_date"],
      ),
    ).toEqual({ sourceDate: null, state: "unreadable-absent-at-source" });
  });

  it("AGREES WITH THE CORPUS READER on every value: `read` iff the corpus returns a sourceDate", () => {
    // This is the falsifier for "two date parsers on one path". The module
    // asserts agreement against the corpus's own reader rather than
    // re-hardcoding a notion of "a date", so if the corpus's
    // parseStrictIsoDate ever tightens (e.g. gains calendar validation), the
    // two cannot silently diverge — this fails instead.
    //
    // Note what the corpus's stance actually IS: `parseStrictIsoDate` is
    // shape-only (`/^(\d{4})-(\d{2})-(\d{2})$/`), so "2026-02-31" is a
    // readable date to it. This module deliberately inherits that rather than
    // being stricter: being stricter here would make the vintage row fire on a
    // date the resolver is happy to ORDER BY, i.e. the surface would call
    // undated a rule the resolver just compared on its date.
    const probes = [
      "2026-04-14",
      "2024-02-29",
      "2026-02-31",
      "April 2026",
      "2026-4-1",
      "2026-04-14T00:00:00Z",
      "2026-04-14 extra",
      "",
      "  2026-04-14  ",
      "accessed 2026-04-14",
      "1970-01-01",
    ];
    for (const value of probes) {
      const corpus = dateFromTableEffectiveDate(value);
      const mine = readSetbackDateAtSource({ present: true, value });
      expect(mine.sourceDate).toBe(corpus.sourceDate);
      expect(mine.state === "read").toBe(corpus.sourceDate !== null);
    }
    // Standing witness that the probe list is not vacuous in either direction:
    expect(readSetbackDateAtSource({ present: true, value: "2026-04-14" }).state).toBe("read");
    expect(readSetbackDateAtSource({ present: true, value: "April 2026" }).state).toBe(
      "unreadable-unparseable",
    );
  });

  it("NEVER INVENTS 1970-01-01: a placeholder date only ever appears if the source literally carries it", () => {
    // The corpus documents `unreadable` as "never a placeholder date like
    // 1970-01-01". This module produces no date at all for an unreadable
    // source, so the epoch can only reach the wire by being typed into the
    // source, where it is a claim the source made and not one this path made.
    for (const absent of [null, undefined, "no date recorded"]) {
      const read = readSetbackDateAtSource({ present: true, value: absent });
      expect(read.sourceDate).toBeNull();
      expect(read.sourceDate).not.toBe("1970-01-01");
    }
    expect(readSetbackDateFromTable({ districts: [] }).sourceDate).toBeNull();
  });
});

describe("P-270 — the conflict row", () => {
  const unreadable = (state: SetbackDateReadState = "unreadable-absent-at-source") => ({
    sourceDate: null,
    state,
  });

  it("THE AGREEING CONTROL: a readable date publishes NO row", () => {
    expect(
      setbackCitationVintageRow({
        date: { sourceDate: "2026-04-14", state: "read" },
        citationUrl: CITATION,
        sourceLabel: "codified setback table bastrop-development-code (City of Bastrop)",
      }),
    ).toBeNull();
  });

  it("publishes no row when there is no citation: there is nothing to qualify", () => {
    for (const url of [null, undefined, "", "   "]) {
      expect(
        setbackCitationVintageRow({ date: unreadable(), citationUrl: url, sourceLabel: "x" }),
      ).toBeNull();
    }
  });

  it("carries the state, the citation it is about, the source label and the one sentence", () => {
    expect(
      setbackCitationVintageRow({
        date: unreadable("unreadable-absent-at-source"),
        citationUrl: CITATION,
        sourceLabel: "codified setback table pflugerville-tx (City of Pflugerville)",
      }),
    ).toEqual({
      kind: SETBACK_CITATION_VINTAGE_TOKEN,
      state: "unreadable-absent-at-source",
      sourceLabel: "codified setback table pflugerville-tx (City of Pflugerville)",
      citationUrl: CITATION,
      note: SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE,
    });
  });

  it("KEEPS THE THREE STATES APART — one input differing only in state yields three different rows", () => {
    const states: SetbackDateReadState[] = [
      "unreadable-absent-at-source",
      "unreadable-unparseable",
      "unreadable-never-looked",
    ];
    const rows = states.map((state) =>
      setbackCitationVintageRow({ date: unreadable(state), citationUrl: CITATION, sourceLabel: null }),
    );
    expect(rows.map((r) => r?.state)).toEqual(states);
    expect(new Set(rows.map((r) => r?.state)).size).toBe(3);
    // ...and the note is deliberately the SAME sentence for all three, so the
    // cause lives only in the machine-readable member.
    expect(new Set(rows.map((r) => r?.note)).size).toBe(1);
  });

  it("a missing source label is null, never the string `undefined`", () => {
    expect(
      setbackCitationVintageRow({ date: unreadable(), citationUrl: CITATION, sourceLabel: "  " })
        ?.sourceLabel,
    ).toBeNull();
  });
});

describe("P-270 — the disclosure and the basis", () => {
  const row = () =>
    setbackCitationVintageRow({
      date: { sourceDate: null, state: "unreadable-absent-at-source" },
      citationUrl: CITATION,
      sourceLabel: null,
    });

  it("appends the sentence to whatever disclosure the payload already carries", () => {
    expect(disclosureWithCitationVintage("Estimated buildable area. Not survey grade.", row())).toBe(
      `Estimated buildable area. Not survey grade. ${SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE}`,
    );
  });

  it("NO ROW: returns the disclosure unchanged, and `undefined` when there was none", () => {
    // This is what keeps a payload whose date IS readable (or which cites
    // nothing) byte-identical to what it was before this lane.
    expect(disclosureWithCitationVintage("Estimated buildable area.", null)).toBe(
      "Estimated buildable area.",
    );
    expect(disclosureWithCitationVintage(null, null)).toBeUndefined();
    expect(disclosureWithCitationVintage("   ", null)).toBeUndefined();
  });

  it("reports the basis only for a date that was actually read", () => {
    expect(
      readableBasisOrNull({ sourceDate: "2026-04-14", state: "read" }, "corpus-table-effective-date"),
    ).toBe("corpus-table-effective-date");
    expect(readableBasisOrNull({ sourceDate: null, state: "unreadable-unparseable" }, "unreadable")).toBeNull();
    expect(readableBasisOrNull({ sourceDate: "2026-04-14", state: "read" }, null)).toBeNull();
  });
});

describe("P-270 — a wire that carries only the corpus's basis", () => {
  it("a basis that says `unreadable` reads as absent-at-source: the source states no readable date", () => {
    expect(stateFromWireBasis("unreadable")).toEqual({
      sourceDate: null,
      state: "unreadable-absent-at-source",
    });
  });

  it("no basis at all is never-looked: nothing on that path consulted a date", () => {
    expect(stateFromWireBasis(undefined)).toEqual(NEVER_LOOKED_DATE_READ);
    expect(stateFromWireBasis(null)).toEqual(NEVER_LOOKED_DATE_READ);
    expect(stateFromWireBasis("")).toEqual(NEVER_LOOKED_DATE_READ);
  });

  it("does not invent a fourth state to represent its own ignorance of the wire", () => {
    // The corpus's SetbackDateBasis collapses "absent" and "unparseable" into
    // the single string "unreadable", so on this wire they cannot be told
    // apart. The honest weaker state is chosen rather than a member that would
    // claim a distinction the wire does not carry.
    expect(stateFromWireBasis("unreadable").state).toBe("unreadable-absent-at-source");
    expect(stateFromWireBasis("unreadable").state).not.toBe("read");
  });

  it("a basis naming a readable source is NOT `read` on its own — a basis without a date is not a date", () => {
    // Deliberate: readableBasisOrNull requires both. This module never derives
    // a date from the basis's NAME, which would be assuming a date from a
    // source kind — the exact thing the ruling forbids.
    for (const basis of [
      "corpus-table-effective-date",
      "atom-source-vintage",
      "gis-row-citation-ordinance",
    ]) {
      expect(stateFromWireBasis(basis)).toEqual(NEVER_LOOKED_DATE_READ);
    }
  });
});

describe("P-354 (2026-09-18) — a date that has not arrived yet", () => {
  const AS_OF = "2026-09-18";
  const GEORGETOWN_ADOPTED = "2026-08-11";
  const GEORGETOWN_EFFECTIVE = "2026-11-01";

  it("THE ROW: a real future date reads as `future-effective`, naming BOTH dates", () => {
    const read = applyFutureEffectiveState(
      { sourceDate: GEORGETOWN_EFFECTIVE, state: "read" },
      { adoptedDate: GEORGETOWN_ADOPTED, asOf: AS_OF },
    );
    expect(read.state).toBe("future-effective");
    expect(read.sourceDate).toBe(GEORGETOWN_EFFECTIVE);
    expect(read.adoptedDate).toBe(GEORGETOWN_ADOPTED);

    const declaration = setbackCitationVintageRow({
      date: read,
      citationUrl: CITATION,
      sourceLabel: "codified setback table georgetown-tx",
    });
    expect(declaration?.kind).toBe(SETBACK_CITATION_FUTURE_EFFECTIVE_TOKEN);
    expect(declaration?.kind).not.toBe(SETBACK_CITATION_VINTAGE_TOKEN);
    expect(declaration?.note).toContain(`adopted ${GEORGETOWN_ADOPTED}`);
    expect(declaration?.note).toContain(`takes effect ${GEORGETOWN_EFFECTIVE}`);
    // ...and NEVER the sentence for a date that could not be read.
    expect(declaration?.note).not.toBe(SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE);
  });

  it("THE CONTROL: a date that HAS arrived is still `read`, and publishes no row", () => {
    const read = applyFutureEffectiveState(
      { sourceDate: "2026-04-14", state: "read" },
      { adoptedDate: GEORGETOWN_ADOPTED, asOf: AS_OF },
    );
    expect(read).toEqual({ sourceDate: "2026-04-14", state: "read" });
    expect(
      setbackCitationVintageRow({ date: read, citationUrl: CITATION, sourceLabel: null }),
    ).toBeNull();
  });

  it("THE DAY IT TAKES EFFECT IS NOT THE FUTURE: asOf == effectiveDate reads `read`", () => {
    const read = applyFutureEffectiveState(
      { sourceDate: GEORGETOWN_EFFECTIVE, state: "read" },
      { asOf: GEORGETOWN_EFFECTIVE },
    );
    expect(read.state).toBe("read");
  });

  it("THE FALSIFIER FOR A SHAPE-ONLY DATE: `2026-13-99` is NOT promoted, and prints no nonsense", async () => {
    // This is the bug this test was written from. `2026-13-99` IS a date to the
    // corpus's shape-only reader, which ORDERS candidates by it, so this rail
    // serves it as the effective date and makes no unreadable declaration (the
    // ruling pinned in setbackRulesFactFromParcelRecord.test.ts). But it is NOT
    // a real calendar date, so "has it arrived?" has no answer, and a lexical
    // comparison would sail past `asOf` and print `takes effect 2026-13-99` as
    // a legal fact to a customer.
    const shapeOnly = readSetbackDateAtSource({ present: true, value: "2026-13-99" });
    expect(shapeOnly.state).toBe("read"); // the corpus's stance, inherited
    expect(shapeOnly.sourceDate).toBe("2026-13-99");

    const read = applyFutureEffectiveState(shapeOnly, { asOf: AS_OF });
    expect(read.state).toBe("read");
    expect(read.state).not.toBe("future-effective");
    expect(
      setbackCitationVintageRow({ date: read, citationUrl: CITATION, sourceLabel: null }),
    ).toBeNull();
    expect(JSON.stringify(read)).not.toContain("takes effect");
  });

  it("...and the same holds for a roll-forward date: `2026-02-31` is not promoted either", () => {
    // Lexically later than asOf, and shape-only a date, but it normalizes to
    // 2026-03-03, so no arrival can be reasoned about.
    const read = applyFutureEffectiveState(
      { sourceDate: "2026-02-31", state: "read" },
      { asOf: "2026-01-01" },
    );
    expect(read.state).toBe("read");
  });

  it("an UNREADABLE read is never promoted, whatever the asOf", () => {
    for (const state of [
      "unreadable-absent-at-source",
      "unreadable-unparseable",
      "unreadable-never-looked",
    ] as const) {
      expect(applyFutureEffectiveState({ sourceDate: null, state }, { asOf: "2000-01-01" })).toEqual({
        sourceDate: null,
        state,
      });
    }
  });

  it("AN ADOPTION DATE THAT IS NOT A REAL DATE is dropped, and the sentence names one date", () => {
    // The resolver never reads this field, so requiring it to be real
    // contradicts no ranking decision -- and the alternative is printing
    // `adopted 2026-13-99` beside an otherwise honest effective date.
    const read = applyFutureEffectiveState(
      { sourceDate: GEORGETOWN_EFFECTIVE, state: "read" },
      { adoptedDate: "2026-13-99", asOf: AS_OF },
    );
    expect(read.adoptedDate).toBeNull();
    expect(setbackFutureEffectiveNote(read.adoptedDate ?? null, GEORGETOWN_EFFECTIVE)).toBe(
      `Setback rule takes effect ${GEORGETOWN_EFFECTIVE} — the rule is served ahead of its effective date, not as current. Verify with the city.`,
    );
    expect(setbackFutureEffectiveCardMarker(null, GEORGETOWN_EFFECTIVE)).toBe(
      `takes effect ${GEORGETOWN_EFFECTIVE}`,
    );
  });

  it("reads the adoption date from the row's own spellings, and only real dates survive", () => {
    expect(
      readAdoptedDateFromRowAtSource({ adoptedDate: GEORGETOWN_ADOPTED }, [
        "adoptedDate",
        "adopted_date",
      ]),
    ).toBe(GEORGETOWN_ADOPTED);
    expect(
      readAdoptedDateFromRowAtSource({ adopted_date: GEORGETOWN_ADOPTED }, [
        "adoptedDate",
        "adopted_date",
      ]),
    ).toBe(GEORGETOWN_ADOPTED);
    expect(
      readAdoptedDateFromRowAtSource({ adoptedDate: "August 11, 2026" }, ["adoptedDate"]),
    ).toBeNull();
    expect(readAdoptedDateFromRowAtSource({}, ["adoptedDate"])).toBeNull();
  });

  it("the row read carries the adoption date through to the state in ONE call", () => {
    const read = readSetbackDateFromRowAtSource(
      { effectiveDate: GEORGETOWN_EFFECTIVE, adoptedDate: GEORGETOWN_ADOPTED },
      ["effectiveDate", "effective_date"],
      { adoptedKeys: ["adoptedDate", "adopted_date"], asOf: AS_OF },
    );
    expect(read).toEqual({
      sourceDate: GEORGETOWN_EFFECTIVE,
      state: "future-effective",
      adoptedDate: GEORGETOWN_ADOPTED,
    });
  });

  it("a future-effective date's BASIS is still reported: it was read, it is just not in force", () => {
    // NOTE the basis used here is `corpus-table-effective-date`, an existing
    // member of the installed corpus's `SetbackDateBasis`. The member this
    // lane's factory half writes for a row-level date
    // (`corpus-row-effective-date`) is NEW IN CORPUS 1.5.0, which is not
    // published yet, so naming it in a typed position here would not compile
    // against the 1.2.0 this repo installs. The assertion is about the STATE
    // reporting its basis, not about which member it is, and it will hold
    // unchanged when 1.5.0 lands.
    expect(
      readableBasisOrNull(
        { sourceDate: GEORGETOWN_EFFECTIVE, state: "future-effective" },
        "corpus-table-effective-date",
      ),
    ).toBe("corpus-table-effective-date");
  });
});
