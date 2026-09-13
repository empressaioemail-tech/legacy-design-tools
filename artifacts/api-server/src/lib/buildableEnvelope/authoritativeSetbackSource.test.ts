import { describe, expect, it } from "vitest";

import {
  effectiveDateForTable,
  resolveAuthoritativeSetbacks,
} from "./authoritativeSetbackSource";

describe("resolveAuthoritativeSetbacks", () => {
  it("R-1 falsifier: a NEWER lower-tier atom (real sourceVintage) beats an OLDER codified table, despite tier -- the exact case the old tier-first ranking got wrong", () => {
    // bastrop-development-code's SF-1 effectiveDate is 2026-04-14 (Ord.
    // 2026-06). An atom-chain candidate with a genuinely later sourceVintage
    // must win under R-1 even though codified-ordinance outranks atom-chain
    // by tier -- the old ranking (tier decided first, date only broke a tie
    // WITHIN one tier) could never let this happen. This is the same
    // falsifier the shared resolver's own non-vacuity suite pre-registers
    // (case 1: "the LOWER-tier candidate is newer and wins").
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-development-code",
      districtCode: "SF-1",
      atomRule: {
        front: 32,
        side: 12,
        rear: 32,
        side_corner: 22,
        sourceAdapter: "property atom-chain setback-rule",
        sourceVintage: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.sourceKind).toBe("atom-chain");
    expect(resolved!.scalars).toEqual({
      front_ft: 32,
      side_ft: 12,
      rear_ft: 32,
      side_corner_ft: 22,
    });
    expect(resolved!.effectiveDate).toBe("2026-08-01");
    expect(resolved!.dateBasis).toBe("atom-source-vintage");
    expect(resolved!.conflict).toBeUndefined();
  });

  it("an unreadable atom date (extractedAt is NOT a source date) that disagrees with the codified table is a disclosed CONFLICT, not a silent tier-first pick", () => {
    // This is the exact fixture the old test used to assert a clean
    // "codified always wins" resolution for. Under R-1 the atom's date
    // cannot be read (extractedAt is emit time, not source time -- the old
    // code's own bug), so this is a genuine conflict: the codified table
    // (2026-04-14, readable) disagrees in value with an unreadable-date
    // candidate. `scalars`/`sourceKind` still surface the tier-highest
    // value for wire back-compat, but `conflict` MUST be present and name
    // both candidates -- a caller that ignores it is choosing to ignore an
    // R-1 conflict, not being handed a silent pick.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-city-tx",
      districtCode: "SF-1",
      atomRule: {
        front: 25,
        side: 5,
        rear: 25,
        side_corner: 15,
        sourceAdapter: "bastrop-city-gis-layer-23",
        extractedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.sourceKind).toBe("codified-ordinance");
    expect(resolved!.scalars.front_ft).toBe(30);
    expect(resolved!.scalars.side_ft).toBe(10);
    expect(resolved!.conflict).toBeDefined();
    expect(resolved!.conflict!.candidates).toHaveLength(2);
    expect(
      resolved!.conflict!.candidates.some((c) => c.dateBasis === "unreadable"),
    ).toBe(true);
  });

  it("dates equal (both READABLE) -> tier breaks the tie cleanly, no conflict", () => {
    // Both candidates carry a real, readable date -- R-1's tie-break case,
    // not its conflict case (conflict requires an UNREADABLE date on one
    // side). Same shared-resolver falsifier case as
    // "dates tie exactly -> tier breaks it" in
    // @empressaio/setback-corpus's own resolve suite.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-development-code",
      districtCode: "SF-1",
      atomRule: {
        front: 99,
        side: 99,
        rear: 99,
        side_corner: 99,
        sourceAdapter: "property atom-chain setback-rule",
        sourceVintage: "2026-04-14T00:00:00.000Z",
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.sourceKind).toBe("codified-ordinance");
    expect(resolved!.scalars.front_ft).toBe(30);
    expect(resolved!.conflict).toBeUndefined();
  });

  it("resolves Pflugerville SF-S from codified table, no atom candidate", () => {
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "pflugerville-tx",
      districtCode: "SF-S",
      atomRule: null,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.scalars).toEqual({
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
      side_corner_ft: 15,
    });
    expect(resolved!.sourceKind).toBe("codified-ordinance");
    expect(resolved!.conflict).toBeUndefined();
  });
});

describe("effectiveDateForTable", () => {
  it("reads explicit effectiveDate when set on table JSON", () => {
    expect(
      effectiveDateForTable({
        jurisdictionKey: "x",
        jurisdictionDisplayName: "X",
        effectiveDate: "2026-04-14",
        districts: [],
      } as never),
    ).toBe("2026-04-14");
  });

  it("R-1 fix: an 'accessed ...' note is NOT an effective date -- returns 'unreadable', never the accessed date and never a placeholder like 1970-01-01", () => {
    expect(
      effectiveDateForTable({
        jurisdictionKey: "x",
        jurisdictionDisplayName: "X",
        note: "Codified from the City of X Code; accessed 2026-07-23.",
        districts: [],
      } as never),
    ).toBe("unreadable");
  });

  it("no effectiveDate and no note -> 'unreadable', never 1970-01-01", () => {
    expect(
      effectiveDateForTable({
        jurisdictionKey: "x",
        jurisdictionDisplayName: "X",
        districts: [],
      } as never),
    ).toBe("unreadable");
  });
});
