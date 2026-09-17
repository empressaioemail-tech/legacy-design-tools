/**
 * P-322 (OPS-16 A-212, operator 2026-09-17) — the Cotality-dependent rail reaches a customer as a
 * DECLARED ABSENCE, not as a scheduling gap.
 *
 * WHAT THIS FILE GUARDS. Before P-322, every unslated pair got one string, and for Bastrop,
 * Caldwell, Hays and McLennan that string said the rail was "served only from parcel_record
 * (Williamson and Travis counties only) ... once this (county, rail) pair is slated with a passing
 * gate verdict. Not there yet for this parcel." A customer reads that as "the data exists and the
 * switch is not flipped for your county". The truth for those four is that the rail has NO source
 * and the planned one is the Cotality agreement, which is not in hand (A-184, P-267, P-283).
 *
 * Both directions, per the dispatch's verify-by-violation:
 *   - the four no-source counties render the declared absence, and
 *   - the counties that are NOT no-source (the two slated ones, and a county outside the program
 *     entirely) keep the pre-P-322 string, so the change is scoped and not a blanket rewrite.
 * Non-vacuity: the two branches are asserted to DIFFER, so a run where the new string silently
 * collapsed back to the old one fails rather than passing on both.
 */

import { describe, expect, it } from "vitest";
import {
  AG_VALUATION_DECLARED_ABSENCE_REASON,
  AG_VALUATION_NO_SOURCE_COUNTIES,
  notCutOverAgValuationFact,
} from "./agValuationFactRead";

/** The four counties the vendor register names for this rail (A-184 / P-267). */
const NO_SOURCE_COUNTIES = ["48021", "48055", "48209", "48309"];
/** Counties that must NOT get the declared absence: the two slated ones. */
const SLATED_COUNTIES = ["48453", "48491"];
/** A county outside the six-county program entirely. */
const OUTSIDE_PROGRAM = "48103";

const PRE_P322_REASON_FRAGMENT = "slated with a passing gate verdict";

function reasonFor(parcelNodeId: string): string {
  return notCutOverAgValuationFact(parcelNodeId).reason;
}

describe("notCutOverAgValuationFact — P-322 declared absence", () => {
  it("the register's four counties are the ones this module declares", () => {
    expect([...AG_VALUATION_NO_SOURCE_COUNTIES].sort()).toEqual([...NO_SOURCE_COUNTIES].sort());
  });

  it("all three things the ruling requires are in the string: what the rail is, that it is not sourced, what would fill it", () => {
    // what the rail is
    expect(AG_VALUATION_DECLARED_ABSENCE_REASON).toContain("Agricultural valuation");
    expect(AG_VALUATION_DECLARED_ABSENCE_REASON).toContain("appraises as agricultural");
    // that it is not yet sourced, and that nothing was looked at
    expect(AG_VALUATION_DECLARED_ABSENCE_REASON).toContain("Not yet sourced");
    expect(AG_VALUATION_DECLARED_ABSENCE_REASON).toContain("nothing has been looked up for this parcel");
    // what would fill it
    expect(AG_VALUATION_DECLARED_ABSENCE_REASON).toContain("would fill it");
    // and it never claims a verified absence
    expect(AG_VALUATION_DECLARED_ABSENCE_REASON).toContain("never a verified absence");
  });

  it("each of the four no-source counties renders the declared absence", () => {
    for (const fips of NO_SOURCE_COUNTIES) {
      const fact = notCutOverAgValuationFact(`${fips}:97658`);
      expect(fact.state).toBe("refused");
      expect(fact.entityId).toBe(`${fips}:97658`);
      expect(fact.reason).toBe(AG_VALUATION_DECLARED_ABSENCE_REASON);
    }
  });

  it("the live Hays subject renders it", () => {
    expect(reasonFor("48209:97658")).toBe(AG_VALUATION_DECLARED_ABSENCE_REASON);
  });

  it("NEGATIVE CONTROL: the declared absence no longer carries the false slating framing", () => {
    for (const fips of NO_SOURCE_COUNTIES) {
      expect(reasonFor(`${fips}:1`)).not.toContain(PRE_P322_REASON_FRAGMENT);
      expect(reasonFor(`${fips}:1`)).not.toContain("no legacy serve path");
    }
  });

  it("SCOPE: the two slated counties and a county outside the program keep the pre-P-322 string", () => {
    for (const fips of [...SLATED_COUNTIES, OUTSIDE_PROGRAM]) {
      const reason = reasonFor(`${fips}:1`);
      expect(reason).toContain(PRE_P322_REASON_FRAGMENT);
      expect(reason).not.toBe(AG_VALUATION_DECLARED_ABSENCE_REASON);
    }
  });

  it("SCOPE: a malformed or empty node id is not mistaken for a no-source county", () => {
    for (const bad of ["", "not-a-valid-id", ":123", "48021", "480219:1"]) {
      expect(reasonFor(bad)).toContain(PRE_P322_REASON_FRAGMENT);
    }
  });

  it("NON-VACUITY: the two branches differ, and the wire code is unchanged on both", () => {
    const declared = notCutOverAgValuationFact("48209:97658");
    const other = notCutOverAgValuationFact("48453:97658");
    expect(declared.reason).not.toBe(other.reason);
    // The code stays `not-cut-over`: the rail genuinely has not cut over to the
    // ledger in these counties. Only the reason was false.
    expect(declared.code).toBe("not-cut-over");
    expect(other.code).toBe("not-cut-over");
    expect(declared.source).toBe("ag-valuation-fact");
  });
});
