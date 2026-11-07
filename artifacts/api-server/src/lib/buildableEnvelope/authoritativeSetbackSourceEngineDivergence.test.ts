/**
 * P-154 (OPS-23 wave 4, share) — cross-repo divergence test.
 *
 * "A divergence test compares LDT's answer with the engine's for
 * 48021:34049 and 48021:33223 and fails on disagreement." (mission,
 * falsifier list: "If LDT's and the engine's answers differ for either
 * parcel, the divergence test must fail; if it passes while they differ,
 * the test is vacuous.")
 *
 * `@hauska-engine/adapters` is private and unpublished (404 on npm; see
 * that repo's own `most-current-setback-resolver.ts` docstring and the
 * P-154 wave-3 close) — this test cannot literally `import` the engine's
 * function cross-repo. What it CAN do, and does: assert LDT's
 * `resolveAuthoritativeSetbacks` produces the SAME served answer the
 * engine's own committed test
 * (hauska-engine `packages/adapters/src/local/setbacks/__tests__/
 * bastrop-r1-integration.test.ts`) asserts for the identical real,
 * live-verified 2026-09-12 input data — both repos now call the SAME
 * shared `resolveMostCurrentSetback` from `@empressaio/setback-corpus/
 * resolve`, so if both repos build the same candidates from the same real
 * data, they are guaranteed to agree; this test proves LDT builds the
 * candidates correctly, not just that the algorithm exists.
 *
 * KNOWN, FLAGGED GAP (leave_behind, not fixed this wave): LDT's
 * `AtomChainSetbackWire` carries no field for a per-parcel record's own
 * ordinance-citation text (e.g. layer 23's `Ordinance_` "2019-51"), so it
 * cannot replicate the engine's `parseYearSequenceOrdinanceCitation`
 * year-precision date read for that exact citation shape — only
 * `sourceVintage`. Fed the real 34049 GIS record with no synthesized
 * `sourceVintage`, LDT's atom candidate is `unreadable`-dated, which
 * (correctly, per R-1) produces a disclosed CONFLICT rather than the
 * engine's clean date-based resolve. The two mechanisms still agree on the
 * SERVED answer for this parcel today (codified table wins either way,
 * since it out-tiers the disagreeing/unreadable per-parcel candidate) —
 * this test locks in that agreement on the served answer, which is what
 * every customer surface actually reads (R-4). A future row that widens
 * `AtomChainSetbackWire` to carry a structured citation (so LDT can also
 * reach a genuine, non-conflict resolve here) is not this wave's.
 */
import { describe, expect, it } from "vitest";

import { resolveAuthoritativeSetbacks } from "./authoritativeSetbackSource";

describe("LDT vs hauska-engine divergence — 48021:34049", () => {
  it("SF-1: LDT's served answer (30/10/30/20, codified-ordinance) matches the engine's bastrop-r1-integration.test.ts assertion for the identical real layer-23 row", () => {
    // Same real, live-verified 2026-09-12 layer-23 attributes the engine's
    // own test hard-codes as LIVE_LAYER_23_ROW_34049, translated into LDT's
    // AtomChainSetbackWire shape (front/side/rear/side_corner scalars +
    // sourceAdapter naming the GIS layer). No sourceVintage is synthesized
    // (the real wire carries none for this record today — see the gap noted
    // above), so this exercises LDT's honest CONFLICT-disclosure path, not
    // a fabricated clean resolve.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-development-code",
      districtCode: "SF-1",
      atomRule: {
        front: 25,
        side: 5,
        rear: 25,
        side_corner: 15,
        sourceAdapter: "bastrop-city-gis-layer-23",
        sourceCitation:
          "Bastrop Parcels_One_Click layer 23, prop_id=34049, Ordinance_=2019-51",
      },
    });

    expect(resolved).not.toBeNull();
    // The engine's assertion for this exact input:
    //   table!.districts.find(d => d.district_name.startsWith("SF-1"))
    //   -> front_ft 30, side_ft 10, rear_ft 30, side_corner_ft 20,
    //      display_meta.source_date "2026-04-14",
    //      display_meta.date_basis "ordinance-effective-date"
    expect(resolved!.scalars).toEqual({
      front_ft: 30,
      side_ft: 10,
      rear_ft: 30,
      side_corner_ft: 20,
    });
    expect(resolved!.sourceKind).toBe("codified-ordinance");
    expect(resolved!.effectiveDate).toBe("2026-04-14");
    expect(resolved!.dateBasis).toBe("ordinance-effective-date");
  });
});

describe("LDT vs hauska-engine divergence — 48021:33223", () => {
  it("district GC: LDT honest-declines (null), matching the engine's R13 rule that a per-parcel-record-only BDC district with no supplied record refuses rather than serving a codified row", () => {
    // The engine's getSetbackTableForZoning returns null for a BDC
    // per-parcel-only district code (MU/GC/PDD/PI/IND/OS) with no supplied
    // bastropPerParcelRecord (R13, AMENDMENT 8) -- there is no ruled
    // codified row for GC at all in bastrop-development-code.json (its own
    // note: "MU/GC/PI/IND/P/OS/PDD intentionally ABSENT"), a table LDT
    // vendors byte-for-byte identically to the corpus for this jurisdiction.
    // LDT's own resolver must decline the same way, not manufacture a
    // value from an unrelated SF/RR row.
    const resolved = resolveAuthoritativeSetbacks({
      jurisdictionKey: "bastrop-development-code",
      districtCode: "GC",
      atomRule: null,
    });
    expect(resolved).toBeNull();
  });
});
