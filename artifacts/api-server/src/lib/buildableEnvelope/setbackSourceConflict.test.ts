/**
 * P-340 — the R-1 conflict row's shape, its one customer sentence, and the
 * agreeing control that keeps it honest.
 *
 * The sentence is pinned BYTE-FOR-BYTE against hauska-map's copy
 * (`apps/property-explorer/api/_lib/setback-source-conflict.ts`), exactly as
 * the P-270 citation-vintage pair is: two repos, one literal, a test in each,
 * so a drift is a failing suite rather than a silent difference between what
 * the card tells a customer and what the drawing tells them.
 */

import { describe, expect, it } from "vitest";

import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";
import {
  SETBACK_SOURCE_CONFLICT_NOTE,
  SETBACK_SOURCE_CONFLICT_TOKEN,
  disclosureWithSourceConflict,
  setbackSourceConflictUnreadableState,
  sourceConflictRowForResolution,
} from "./setbackSourceConflict";

describe("SETBACK_SOURCE_CONFLICT_NOTE", () => {
  it("is the one pinned customer sentence (byte-identical to hauska-map's copy)", () => {
    expect(SETBACK_SOURCE_CONFLICT_NOTE).toBe(
      "Setback sources disagree on this parcel and at least one source's effective date could not be read at source — both candidates are served and neither is settled. Verify with the city.",
    );
    expect(SETBACK_SOURCE_CONFLICT_TOKEN).toBe("setback-source-conflict");
    // The em dash is ONE U+2014, not a mojibake pair: the sentence is printed to
    // customers by both surfaces, and a mangled dash is a visible defect that a
    // same-bytes comparison would happily carry across both copies.
    expect([...SETBACK_SOURCE_CONFLICT_NOTE].filter((c) => c === "\u2014")).toHaveLength(1);
    expect(SETBACK_SOURCE_CONFLICT_NOTE).not.toContain("\uFFFD");
  });
});

describe("sourceConflictRowForResolution", () => {
  it("serves both candidates when the sources disagree and a date is unreadable", () => {
    // Measured P-340 subject: Buda `48209:140047`. The codified row says the
    // corner is 15; the atom rule says 10; neither carries a readable date
    // (no corpus table has an `effectiveDate`, the atom has no
    // `sourceVintage`). R-1: a conflict, both values served.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "buda-tx",
      districtCode: "R2",
      atomRule: {
        front: 20,
        side: 10,
        rear: 25,
        sideCornerFt: 10,
        districtCode: "R2",
        sourceVintage: null,
      },
    })!;
    const row = sourceConflictRowForResolution(resolved)!;
    expect(row.kind).toBe(SETBACK_SOURCE_CONFLICT_TOKEN);
    expect(row.state).toBe("unreadable-absent-at-source");
    expect(row.note).toBe(SETBACK_SOURCE_CONFLICT_NOTE);
    expect(row.candidates).toHaveLength(2);
    const cornerValues = row.candidates
      .map((c) => c.scalars.side_corner_ft)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(cornerValues).toEqual([10, 15]);
    // The tier-highest candidate is still SERVED (the interim stance both
    // surfaces take), disclosed rather than presented as settled.
    expect(resolved.scalars.side_corner_ft).toBe(15);
  });

  it("the agreeing control: an undated but AGREEING pair is not a conflict", () => {
    // Dripping Springs `48209:142415`: the row and the atom agree on all four
    // axes, and both dates are unreadable. A row here would teach a customer to
    // distrust a value both sources agree on, so there must not be one.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "dripping-springs-tx",
      districtCode: "SF-2",
      atomRule: {
        front: 25,
        side: 15,
        rear: 25,
        sideCornerFt: 15,
        districtCode: "SF-2",
        sourceVintage: null,
      },
    })!;
    expect(resolved.conflict).toBeUndefined();
    expect(sourceConflictRowForResolution(resolved)).toBeNull();
  });

  it("reads the unreadable cause off the candidate that has one, not off the winner", () => {
    // A DATED winner disagreeing with an undated candidate is still a conflict,
    // and the row must name the UNDATED side's cause.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-development-code",
      districtCode: "SF-1",
      atomRule: {
        front: 32,
        side: 12,
        rear: 32,
        sideCornerFt: 22,
        sourceAdapter: "property atom-chain setback-rule",
        sourceVintage: null,
      },
    })!;
    expect(resolved.conflict).toBeDefined();
    const undated = resolved.conflict!.candidates.find((c) => c.sourceDate === null)!;
    expect(undated.dateBasis).toBe("unreadable");
    expect(setbackSourceConflictUnreadableState(resolved)).toBe(
      "unreadable-absent-at-source",
    );
  });

  it("declares nothing for a resolution with no conflict, and names the cause from the candidate that has one", () => {
    // The cause for "there is nothing to read here" is the P-270 `never-looked`
    // member, not `absent-at-source`: this function is asked about a resolution
    // that may be absent entirely, and calling an unasked question "absent at
    // source" would tell a reader the source was consulted. The P-270 mapper
    // only ever produces these two answers for a basis (`stateFromWireBasis`),
    // and its `read`/`future-effective` members describe a date that WAS read,
    // which is not an unreadable cause at all — the guard above them is
    // defensive, and this asserts the two real inputs rather than inventing a
    // third.
    expect(setbackSourceConflictUnreadableState(null)).toBe("unreadable-never-looked");
    expect(
      setbackSourceConflictUnreadableState({ dateBasis: "unreadable" }),
    ).toBe("unreadable-absent-at-source");
    expect(
      sourceConflictRowForResolution({
        dateBasis: "unreadable",
        conflict: undefined,
      }),
    ).toBeNull();
    // A conflict carrying ONE candidate is not a conflict either: there is no
    // disagreement to disclose, and the two-candidate guard says so.
    expect(
      sourceConflictRowForResolution({
        dateBasis: "unreadable",
        conflict: {
          reason: "single candidate",
          candidates: [
            {
              sourceKind: "atom-chain",
              sourceLabel: "x",
              scalars: { front_ft: 1, side_ft: 1, rear_ft: 1 },
              sourceDate: null,
              dateBasis: "unreadable",
            },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("disclosureWithSourceConflict", () => {
  it("appends the sentence, and is a no-op without a row", () => {
    expect(disclosureWithSourceConflict("Existing note.", null)).toBe("Existing note.");
    expect(disclosureWithSourceConflict(null, null)).toBeUndefined();
    expect(disclosureWithSourceConflict("", null)).toBeUndefined();
    const row = {
      kind: SETBACK_SOURCE_CONFLICT_TOKEN,
      state: "unreadable-absent-at-source" as const,
      reason: "r",
      candidates: [],
      note: SETBACK_SOURCE_CONFLICT_NOTE,
    };
    expect(disclosureWithSourceConflict("Existing note.", row)).toBe(
      `Existing note. ${SETBACK_SOURCE_CONFLICT_NOTE}`,
    );
    expect(disclosureWithSourceConflict(null, row)).toBe(SETBACK_SOURCE_CONFLICT_NOTE);
  });
});
