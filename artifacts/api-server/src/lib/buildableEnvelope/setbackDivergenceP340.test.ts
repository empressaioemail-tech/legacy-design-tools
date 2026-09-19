/**
 * P-340 — THE DIVERGENCE TEST, route half. The drawing route's answer for the
 * 7 measured `PANEL-DRAW-TABLE-DISAGREE` subjects, pinned against hauska-map's
 * answer so a one-sided change FAILS rather than drifts.
 *
 * THE MEASUREMENT. `surface-probe.mjs`'s `PANEL-DRAW-TABLE-DISAGREE` class
 * compares the card's 4-tuple against the route's 4-tuple for a parcel with no
 * exemptions; on 2026-09-18 it fired on these 7 (fixture below, captured from
 * the live surfaces on 2026-09-18 in
 * `_inbox/2026-09-18_155840_surface_probe.json`). Two mechanisms, both a
 * two-homes problem, and BOTH sides were wrong about something:
 *
 *  - FIVE subjects: the CARD collapsed `side_corner_ft` whenever the atom
 *    rule's corner equalled its side yard, so it served `20/10/25/-` where the
 *    codified row said `20/10/25/15`. The card is fixed on its side
 *    (`hauska-map` `withDecidedScalars`).
 *  - TWO Austin subjects: the ROUTE read the county store's base code `SF` and
 *    crossed it into the longest prefix match (`SF-4A`, 15/3.5/5/10) while the
 *    city layer and the parcel's own setback atom say `SF-3`/`SF-2`
 *    (25/5/10/15). The route is fixed on this side
 *    (`firstResolvableDistrictCode` + the ambiguity refusal in `mapDistrict`).
 *
 * WHY THIS SUITE IS A COPY AND NOT AN IMPORT. The card lives in hauska-map, in
 * another repo, and the two surfaces must agree by CONSTRUCTION rather than by
 * sharing a function. hauska-map's copy of this fixture lives at
 * `apps/property-explorer/api/_lib/setback-card-route-divergence.test.ts` and
 * pins the SAME 7 expected tuples, so changing ONE side alone fails the OTHER
 * side's copy of the expectation. The fixture below is deliberately literal:
 * every value in it was read off a live surface, not computed here.
 */

import { describe, expect, it } from "vitest";

import { getSetbackTableForZoning } from "@workspace/adapters";

import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";
import {
  firstResolvableDistrictCode,
  mapDistrict,
} from "./districtMapping";
import { sourceConflictRowForResolution } from "./setbackSourceConflict";

type Subject = {
  /** The probe's own subject id. */
  parcelNodeId: string;
  jurisdictionKey: string;
  /** The district the CARD reads (the atom chain's zoning fact / record stamp). */
  cardDistrict: string;
  /** What the ROUTE reads first: the county store's GIS zoning stamp. */
  gisZoningCode: string;
  /** The atom chain's own district fact, the route's next signal. */
  atomDistrict: string;
  atomRule: {
    front: number;
    side: number;
    rear: number;
    /** The wire's own spelling — see `AtomChainSetbackWire`. */
    sideCornerFt: number;
    districtCode: string;
    sourceVintage: string | null;
  };
  /** Measured 2026-09-18, before this lane. `null` = the axis was absent on the card. */
  cardBefore: [number, number, number, number | null];
  /** Measured 2026-09-18, before this lane. */
  routeBefore: [number, number, number, number | null];
  /** What BOTH surfaces must serve after this lane. */
  bothAfter: [number, number, number, number | null];
  /** Does R-1 declare this a conflict (both dates unreadable AND values disagree)? */
  conflict: boolean;
};

/**
 * The 7 subjects, verbatim from the 2026-09-18 probe artifact. MUST stay
 * byte-identical to hauska-map's
 * `apps/property-explorer/api/_lib/setback-card-route-divergence.test.ts`
 * fixture: the two copies are the two halves of one paired control.
 */
const SUBJECTS: Subject[] = [
  {
    parcelNodeId: "48209:140047",
    jurisdictionKey: "buda-tx",
    cardDistrict: "R2",
    gisZoningCode: "R2",
    atomDistrict: "R2",
    atomRule: {
      front: 20,
      side: 10,
      rear: 25,
      sideCornerFt: 10,
      districtCode: "R2",
      sourceVintage: null,
    },
    cardBefore: [20, 10, 25, null],
    routeBefore: [20, 10, 25, 15],
    bothAfter: [20, 10, 25, 15],
    conflict: true,
  },
  {
    parcelNodeId: "48209:142415",
    jurisdictionKey: "dripping-springs-tx",
    cardDistrict: "SF-2",
    gisZoningCode: "SF-2",
    atomDistrict: "SF-2",
    atomRule: {
      front: 25,
      side: 15,
      rear: 25,
      sideCornerFt: 15,
      districtCode: "SF-2",
      sourceVintage: null,
    },
    cardBefore: [25, 15, 25, null],
    routeBefore: [25, 15, 25, 15],
    bothAfter: [25, 15, 25, 15],
    conflict: false,
  },
  {
    parcelNodeId: "48209:145880",
    jurisdictionKey: "kyle-tx",
    cardDistrict: "R-1-A",
    gisZoningCode: "R-1-A",
    atomDistrict: "R-1-A",
    atomRule: {
      front: 25,
      side: 10,
      rear: 15,
      sideCornerFt: 10,
      districtCode: "R-1-A",
      sourceVintage: null,
    },
    cardBefore: [25, 10, 15, null],
    routeBefore: [25, 10, 15, 10],
    bothAfter: [25, 10, 15, 10],
    conflict: false,
  },
  {
    parcelNodeId: "48209:166141",
    jurisdictionKey: "san-marcos-tx",
    cardDistrict: "MU",
    gisZoningCode: "MU",
    atomDistrict: "MU",
    atomRule: {
      front: 25,
      side: 7.5,
      rear: 5,
      sideCornerFt: 7.5,
      districtCode: "MU",
      sourceVintage: null,
    },
    cardBefore: [25, 7.5, 5, null],
    routeBefore: [25, 7.5, 5, 15],
    bothAfter: [25, 7.5, 5, 15],
    conflict: true,
  },
  {
    parcelNodeId: "48209:97658",
    jurisdictionKey: "san-marcos-tx",
    cardDistrict: "SF-6",
    gisZoningCode: "SF-6",
    atomDistrict: "SF-6",
    atomRule: {
      front: 25,
      side: 5,
      rear: 20,
      sideCornerFt: 5,
      districtCode: "SF-6",
      sourceVintage: null,
    },
    cardBefore: [25, 5, 20, null],
    routeBefore: [25, 5, 20, 15],
    bothAfter: [25, 5, 20, 15],
    conflict: true,
  },
  {
    parcelNodeId: "48453:239852",
    jurisdictionKey: "austin-tx",
    cardDistrict: "SF-3",
    gisZoningCode: "SF",
    atomDistrict: "SF-3",
    atomRule: {
      front: 25,
      side: 5,
      rear: 10,
      sideCornerFt: 15,
      districtCode: "SF-3",
      sourceVintage: null,
    },
    cardBefore: [25, 5, 10, 15],
    routeBefore: [15, 3.5, 5, 10],
    bothAfter: [25, 5, 10, 15],
    conflict: false,
  },
  {
    parcelNodeId: "48453:367134",
    jurisdictionKey: "austin-tx",
    cardDistrict: "SF-2",
    gisZoningCode: "SF",
    atomDistrict: "SF-2",
    atomRule: {
      front: 25,
      side: 5,
      rear: 10,
      sideCornerFt: 15,
      districtCode: "SF-2",
      sourceVintage: null,
    },
    cardBefore: [25, 5, 10, 15],
    routeBefore: [15, 3.5, 5, 10],
    bothAfter: [25, 5, 10, 15],
    conflict: false,
  },
];

const tuple = (s: {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
  side_corner_ft?: number;
}): [number, number, number, number | null] => [
  s.front_ft,
  s.side_ft,
  s.rear_ft,
  s.side_corner_ft ?? null,
];

const tableFor = (key: string, code: string) => getSetbackTableForZoning(key, code);

describe("P-340 — the route and the card resolve the 7 measured subjects identically", () => {
  for (const subject of SUBJECTS) {
    it(`${subject.parcelNodeId} (${subject.jurisdictionKey} ${subject.gisZoningCode} -> ${subject.cardDistrict})`, () => {
      // 1. The route's district-signal pick: the county store's stamp first,
      //    then the atom chain's own district — and `SF` names no Austin row.
      const districtCode = firstResolvableDistrictCode(
        [subject.gisZoningCode, subject.atomDistrict, subject.atomRule.districtCode],
        subject.jurisdictionKey,
        tableFor,
      );
      expect(districtCode, "route's resolved district code").toBe(subject.cardDistrict);

      // 2. The route's own resolution, through the one shared resolver.
      const resolved = resolveAuthoritativeSetbacks({
        jurisdictionKey: subject.jurisdictionKey,
        districtCode,
        atomRule: subject.atomRule,
      });
      expect(resolved, "route must resolve a value").not.toBeNull();
      expect(tuple(resolved!.scalars)).toEqual(subject.bothAfter);

      // 3. ENFORCEMENT's paired control: at least one side was WRONG before
      //    this lane, so the agreement above is a change and not a tautology.
      expect(
        [subject.cardBefore, subject.routeBefore].some(
          (before) => before.join("/") !== subject.bothAfter.join("/"),
        ),
        "subject must have disagreed with the target before this lane",
      ).toBe(true);

      // 4. R-1's conflict declaration: both dates unreadable (the atom's
      //    `sourceVintage` is null and no corpus table carries an
      //    `effectiveDate`), so a value disagreement is a conflict and a value
      //    agreement is not.
      const row = sourceConflictRowForResolution(resolved);
      expect(!!row, `${subject.parcelNodeId} conflict row`).toBe(subject.conflict);
      if (subject.conflict) expect(row!.candidates).toHaveLength(2);
    });
  }

  it("the one-sided change control: the pre-fix route crossing alone breaks the pairing", () => {
    const austin = SUBJECTS.find((s) => s.parcelNodeId === "48453:239852")!;
    // The measured pre-fix behaviour, reproduced as the one-sided change it
    // was: `SF` resolved to the longest prefix match. The tuple that produced
    // (15/3.5/5/10) is NOT what both surfaces must serve, so a route that
    // regressed here would fail the pairing above.
    const crossing = resolveAuthoritativeSetbacks({
      jurisdictionKey: austin.jurisdictionKey,
      districtCode: "SF-4A",
      atomRule: austin.atomRule,
    })!;
    expect(tuple(crossing.scalars)).toEqual([15, 3.5, 5, 10]);
    expect(tuple(crossing.scalars)).not.toEqual(austin.bothAfter);
  });

  it("refuses to invent a district from an ambiguous base code", () => {
    const austin = getSetbackTableForZoning("austin-tx", "SF-3")!;
    // `SF` is the base of six Austin rows, so it names none of them.
    expect(mapDistrict(austin, "SF")).toBeNull();
    // An UNAMBIGUOUS suffix variant still resolves by prefix (the deliberate
    // fallback P-257 kept), so this guard did not remove the fallback itself.
    expect(mapDistrict(austin, "SF-4AA")?.district.district_name).toMatch(/^SF-4A/);
    // And the row `SF-3` really is the district both surfaces must land on.
    expect(mapDistrict(austin, "SF-3")?.district.front_ft).toBe(25);
  });

  it("keeps the old first signal when no signal names a row", () => {
    // No table for the jurisdiction, or no row for any signal: the first
    // signal is returned unchanged, which is the pre-P-340 behaviour for every
    // parcel this lane did not measure.
    expect(
      firstResolvableDistrictCode(["QQ-9", "QQ-8"], null, tableFor),
    ).toBe("QQ-9");
    expect(
      firstResolvableDistrictCode(["QQ-9", "QQ-8"], "austin-tx", tableFor),
    ).toBe("QQ-9");
    expect(firstResolvableDistrictCode([null, "", undefined], "austin-tx", tableFor)).toBe("");
  });
});
