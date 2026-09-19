import { describe, expect, it } from "vitest";
import {
  accountKeyedMembershipVerdict,
  ACCOUNT_KEYED_RETIREMENT_FORBIDDEN_FACT_KEYS,
  isAccountKeyedNodeId,
  partitionAccountKeyedWork,
  planAccountKeyedRetirements,
  servedPayloadCarriesPublishRunId,
  type AccountKeyedAccessResolution,
  type AccountKeyedRetirementPayload,
  type AccountKeyedWorkItem,
} from "../accountKeyedWork";
import { isEarnedRecordRetirement } from "../recordRetirement";
/**
 * P-180 (2026-09-13). The bake work-list exclusion that makes P-177's
 * non-durable retirement marker durable. Live fixture: Hays 48209 production
 * has a `txgio_parcel` row for 97658 (a real TxGIO node) and none for the
 * five hollow account-keyed ids P-177 retired.
 */
describe("P-180 isAccountKeyedNodeId (bake work-list exclusion)", () => {
  const haysTxgioPropIds = new Set(["97658", "97651", "97652", "97653", "97657"]);

  it("excludes the hollow account-keyed ids P-177 retired", () => {
    for (const id of ["84639", "84632", "84633", "84634", "84638"]) {
      expect(isAccountKeyedNodeId(id, haysTxgioPropIds)).toBe(true);
    }
  });

  it("keeps every real TxGIO node, including the ones whose bare number also collides with a CAD account", () => {
    for (const id of ["97658", "97651", "97652", "97653", "97657"]) {
      expect(isAccountKeyedNodeId(id, haysTxgioPropIds)).toBe(false);
    }
  });

  it("does not treat a malformed/empty prop id as account-keyed", () => {
    expect(isAccountKeyedNodeId("", haysTxgioPropIds)).toBe(false);
    expect(isAccountKeyedNodeId("   ", haysTxgioPropIds)).toBe(false);
  });

  it("excludes every id when the county publishes no TxGIO prop ids at all", () => {
    expect(isAccountKeyedNodeId("97658", new Set())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P-370 (2026-09-19). THE MEMBERSHIP TEST ASKS THE NODE'S OWN KEYSPACE.
//
// The defect: the rule above asks "is this key a `txgio_parcel` prop_id", which
// is the right question only in a county whose served keys ARE that table's
// keys. In Williamson the parcel table publishes R-prefixed ids and the work
// list carries the 319,480 numeric keys the declared 2026 roll is keyed by, so
// the bare-key test excluded a whole LIVE keyspace -- and writer (b)'s own
// blast-radius refusal (P-351) then held the county unable to publish, which is
// where the 2026-09-19 staging publish died.
//
// The second published identifier is the county's OWN pair read by the ACCOUNT,
// and its PRESENCE is the trigger (`PublishedPairMembership`, not an empty map).
// Four outcomes are asserted below, including the one that is neither a
// retirement nor a pass: a key the pair does not reach is KEPT AND DECLARED.
// Both directions: with the pair, nothing of a county's account-shaped keyspace
// is retired; without it -- and for a key the pair names to a prop_id this
// county's parcel table does not publish -- the verdict is the pre-P-370 one
// exactly, which is what keeps Hays' measured hollow set unchanged key for key.
// ---------------------------------------------------------------------------
describe("P-370 the second published identifier: the county's own pair, read by the account", () => {
  /**
   * A PARCEL TABLE IN THE OTHER NUMBERING -- Williamson's shape. The keys it
   * publishes are r-account-shaped and the work list's are numeric, which is
   * what makes its absence from this table no evidence of hollowness.
   */
  const parcelIndex = new Set(["R97658", "R97651"]);
  /** And the same table in the SAME numbering as the work keys -- Hays' shape. */
  const haysParcelIndex = new Set(["97658", "97651"]);
  const pair = (entries: Array<[string, string]>, shapes: string[] = ["r-account"]) => ({
    nodeKeyByAccountKey: new Map(entries),
    sources: ["tx_wcad_owner"],
    parcelTableShapeClasses: new Set(shapes),
  });

  it("FOUR OUTCOMES, named, so no caller can read one as another", () => {
    expect(accountKeyedMembershipVerdict("R97658", parcelIndex)).toBe("published-parcel-node");
    expect(accountKeyedMembershipVerdict("84639", parcelIndex, pair([["84639", "R97658"]]))).toBe(
      "reached-by-published-pair",
    );
    expect(accountKeyedMembershipVerdict("84639", parcelIndex, pair([["99999", "R97658"]]))).toBe(
      "declared-no-published-identifier",
    );
    expect(accountKeyedMembershipVerdict("84639", parcelIndex)).toBe("hollow-account-keyed");
  });

  it("BOTH DIRECTIONS: a key the pair names to a published prop_id is not hollow; the same key with no pair is", () => {
    expect(isAccountKeyedNodeId("84639", parcelIndex)).toBe(true);
    expect(isAccountKeyedNodeId("84639", parcelIndex, pair([["84639", "R97658"]]))).toBe(false);
  });

  it("a key the pair names to a prop_id THIS county does not publish is NOT reached by it", () => {
    // The extracts carry no county column, so this is the collision the pair can
    // not be trusted about on its own: the named prop_id must be a parcel the
    // caller's own parcel table publishes.
    expect(
      accountKeyedMembershipVerdict("84639", parcelIndex, pair([["84639", "R048816"]])),
    ).toBe("declared-no-published-identifier");
    // ...and in the SAME-numbering county it is not even that: a numeric parcel
    // table judges a numeric key's absence as evidence, whatever the extract said.
    expect(
      accountKeyedMembershipVerdict("84639", haysParcelIndex, pair([["84639", "R048816"]], ["numeric"])),
    ).toBe("hollow-account-keyed");
  });

  it("THE DECLARATION NEEDS BOTH FACTS: a pair present, and a parcel table that does not use this key's shape", () => {
    // (1) No pair at all -> the pre-P-370 verdict, even in the disjoint-shape
    // county. A county with a disjoint numbering and no published pair has NO
    // identifier to declare with, and stopping its retirement without putting a
    // declaration in its place would be a silent gap rather than a declared one.
    expect(isAccountKeyedNodeId("84639", parcelIndex, undefined)).toBe(true);
    expect(isAccountKeyedNodeId("84639", parcelIndex, null)).toBe(true);
    // (2) A pair present, but this county's parcel table publishes keys OF THIS
    // SHAPE, so the absence IS evidence -> the pre-P-370 verdict. This is Hays,
    // and it is why a cross-county pair row cannot disarm it.
    const haysShaped = pair([], ["numeric"]);
    expect(isAccountKeyedNodeId("84639", haysParcelIndex, haysShaped)).toBe(true);
    // (3) Both, and the key is declared -- kept in the fact build, not retired.
    expect(isAccountKeyedNodeId("84639", parcelIndex, pair([]))).toBe(false);
    expect(accountKeyedMembershipVerdict("84639", parcelIndex, pair([]))).toBe(
      "declared-no-published-identifier",
    );
    // A parcel table that publishes NO keys at all is the empty case of (3):
    // nothing about this table is evidence about any key.
    expect(accountKeyedMembershipVerdict("84639", new Set(), pair([]))).toBe(
      "declared-no-published-identifier",
    );
  });

  it("the pre-P-370 verdicts are untouched when no pair is supplied", () => {
    for (const id of ["84639", "84632", "84633", "84634", "84638", "97658", "97651", ""]) {
      expect(isAccountKeyedNodeId(id, parcelIndex, undefined)).toBe(
        isAccountKeyedNodeId(id, parcelIndex),
      );
      expect(accountKeyedMembershipVerdict(id, parcelIndex, undefined)).toBe(
        accountKeyedMembershipVerdict(id, parcelIndex),
      );
    }
    // An id the pass never read is kept, as it was before: excluding on an
    // unparseable key is how a pass drops a row it cannot account for.
    expect(isAccountKeyedNodeId("", parcelIndex, pair([["", "97658"]]))).toBe(false);
  });

  it("HAYS' GOLDEN HOLLOW LIST IS UNCHANGED KEY FOR KEY -- refused, not declared, because Hays' table uses its keys' numbering", () => {
    const work = ["84639", "84632", "84633", "84634", "84638", "97658", "97651"].map((p) => ({
      parcelNodeId: `48209:${p}`,
      body: {},
    }));
    const golden = ["48209:84632", "48209:84633", "48209:84634", "48209:84638", "48209:84639"];
    const bare = partitionAccountKeyedWork(work, haysParcelIndex);
    expect(bare.excluded.map((w) => w.parcelNodeId).sort()).toEqual(golden);
    expect(bare.declaredNoPublishedIdentifier).toBe(0);
    // ...and the CLI's own rule (nothing read for this county -> pass NOTHING)
    // changes nothing.
    const nothing = partitionAccountKeyedWork(work, haysParcelIndex, undefined);
    expect(nothing.excluded.map((w) => w.parcelNodeId).sort()).toEqual(golden);
    expect(nothing.declaredNoPublishedIdentifier).toBe(0);
    // ...AND THE HAZARD NAMED ABOVE, measured: a pair the caller DID read for
    // Hays (the extracts have no county column, so a Hays account number can
    // match a Williamson parcel) names two of these keys to Williamson prop_ids.
    // Hays' own table publishes numeric keys, so a numeric key's absence from it
    // is still evidence and the list does not move by one key.
    const collided = partitionAccountKeyedWork(
      work,
      haysParcelIndex,
      pair([["84639", "R048816"], ["84632", "R041604"]], ["numeric"]),
    );
    expect(collided.excluded.map((w) => w.parcelNodeId).sort()).toEqual(golden);
    expect(collided.declaredNoPublishedIdentifier).toBe(0);
    expect(collided.reachedByPublishedPair).toBe(0);
  });

  it("COUNTED, NOT INFERRED: the keys the pair reached and the keys that are declared", () => {
    const work = ["84639", "99999", "97658"].map((p) => ({
      parcelNodeId: `48491:${p}`,
      body: {},
    }));
    const { kept, excluded, reachedByPublishedPair, declaredNoPublishedIdentifier } =
      partitionAccountKeyedWork(
        work,
        parcelIndex,
        pair([["84639", "R97658"], ["99999", "R048816"]]),
      );
    expect(kept.map((w) => w.parcelNodeId)).toEqual(["48491:84639", "48491:99999", "48491:97658"]);
    expect(excluded).toEqual([]);
    // 84639 is named to a prop_id this county publishes; 99999 IS named by the
    // pair but to a prop_id it does not publish, so it is DECLARED and NOT
    // counted as reached -- the counters measure the county's two numbering
    // systems, not the extract's row count. 97658 is named by nothing.
    expect(reachedByPublishedPair).toBe(1);
    expect(declaredNoPublishedIdentifier).toBe(2);
  });

  it("NOTHING OF A COUNTY'S ACCOUNT-SHAPED KEYSPACE IS RETIRED WHEN IT PUBLISHES A PAIR", () => {
    // The population end state, in one assertion: a pair that reaches 2 of 4 and
    // names two to prop_ids this county does not publish leaves the exclusion
    // EMPTY, and the keyspace it would have emptied is the one P-351's guard
    // refuses.
    const work = ["1", "2", "3", "4"].map((p) => ({ parcelNodeId: `48491:${p}`, body: {} }));
    const delivered = partitionAccountKeyedWork(
      work,
      new Set(["R1", "R2"]),
      pair([["1", "R1"], ["2", "R2"], ["3", "R9"], ["4", "R8"]]),
    );
    expect(delivered.excluded).toEqual([]);
    expect(delivered.reachedByPublishedPair).toBe(2);
    expect(delivered.declaredNoPublishedIdentifier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P-180 WAVE 6 (2026-09-14, operator ruling A-146 option B). The exclusion is
// paired with a retirement pass so an excluded node carries the CURRENT run id.
//
// The run id and the stale id below are the REAL ones from the failing publish:
// `factory-bastrop-publish-fwv5s` (12f464a9-66af-4cc9-ad17-95e5b82f0011)
// failed BP-PUBLISH-RUN-01 on 48209:84629, which still carried
// e0f6e487-130a-48b0-b0d1-0620ce398326 from the previous bake.
// ---------------------------------------------------------------------------
const CURRENT_RUN = "12f464a9-66af-4cc9-ad17-95e5b82f0011";
const STALE_RUN = "e0f6e487-130a-48b0-b0d1-0620ce398326";
const CONFORMANT_SCHEMA_VERSION = "node-facets-tier1-conformant-v1";

const ACCESS = { discoverability: "catalog-listed", entitlement: "anyone-free" };

function hollowItem(propId: string, taxYear: number | null = 2025) {
  return {
    parcelNodeId: `48209:${propId}`,
    body: { access: ACCESS, sourceIdentifiers: { prop_id: propId, taxYear } },
  };
}

function alwaysNormalizes(): AccountKeyedAccessResolution {
  return { ok: true, access: ACCESS, accessNormalizedFrom: null };
}

function planFor(
  // Typed to the module's own work-item shape, not to `hollowItem`'s return:
  // an excluded node's `body` is an atom body (`Record<string, unknown>`) and
  // its access pair is validated at RUNTIME by `resolveAccess`. Narrowing this
  // to a well-formed pair would make the unresolvable-pair case (below)
  // unconstructible, which is exactly the population the pass must count.
  excluded: AccountKeyedWorkItem[],
  overrides: Partial<Parameters<typeof planAccountKeyedRetirements>[0]> = {},
) {
  return planAccountKeyedRetirements({
    excluded,
    countyFips: "48209",
    countyName: "Hays",
    facetSchemaVersion: CONFORMANT_SCHEMA_VERSION,
    shapeSource: "conformant-v1",
    source: "conformant-v1-cad-parcel-roll",
    publishRunId: CURRENT_RUN,
    asOf: "2026-09-14T03:31:56.883Z",
    resolveAccess: alwaysNormalizes,
    readLastSeenTaxYear: (body) =>
      typeof body.sourceIdentifiers === "object" &&
      body.sourceIdentifiers !== null &&
      typeof (body.sourceIdentifiers as Record<string, unknown>).taxYear === "number"
        ? ((body.sourceIdentifiers as Record<string, unknown>).taxYear as number)
        : null,
    ...overrides,
  });
}

describe("P-180 partition (the fact build still skips the hollow node)", () => {
  const realItem = {
    parcelNodeId: "48209:97658",
    body: { access: ACCESS, sourceIdentifiers: { prop_id: "97658", taxYear: 2026 } },
  };
  const hollow = hollowItem("84629");

  it("keeps the TxGIO node in the fact build and excludes the account-keyed node from it", () => {
    const { kept, excluded } = partitionAccountKeyedWork(
      [realItem, hollow],
      new Set(["97658"]),
    );
    expect(kept.map((w) => w.parcelNodeId)).toEqual(["48209:97658"]);
    expect(excluded.map((w) => w.parcelNodeId)).toEqual(["48209:84629"]);
    // The load-bearing half: the hollow node is NOT in the fact build's list.
    expect(kept.some((w) => w.parcelNodeId === "48209:84629")).toBe(false);
  });

  it("excludes nothing in a county whose TxGIO index is not consulted (empty work list, empty result)", () => {
    const { kept, excluded } = partitionAccountKeyedWork([], new Set(["97658"]));
    expect(kept).toEqual([]);
    expect(excluded).toEqual([]);
  });
});

describe("P-180 retirement pass (the stamp the walk wants exists)", () => {
  const hollow = hollowItem("84629");

  /** The served snapshot store, keyed by node id. Seeded with the STALE payload the previous bake left. */
  function staleStore() {
    const store = new Map<string, Record<string, unknown>>();
    store.set("48209:84629", {
      publishRunId: STALE_RUN,
      recordRetirement: { status: "retired", verdict: "absent-verified" },
      baseFacts: { apn: "84629", acreage: { value: 1.2 } },
    });
    return store;
  }

  it("FAILS as the walk failed when the excluded node is left with a stale stamp (the pre-wave-6 state)", () => {
    const store = staleStore();
    // This is exactly what `factory-bastrop-publish-fwv5s` measured on
    // 48209:84629 before this pass existed: the exclusion alone leaves the
    // stale run id in place, and the walk's own predicate refuses it.
    expect(servedPayloadCarriesPublishRunId(store.get("48209:84629"), CURRENT_RUN)).toBe(false);
  });

  it("passes the walk's own stamp predicate after the pass, and replaces the stale id", () => {
    const store = staleStore();
    const { writes, accessRefused } = planFor([hollow]);
    expect(accessRefused).toBe(0);
    for (const write of writes) store.set(write.parcelNodeId, write.payload as unknown as Record<string, unknown>);
    expect(store.get("48209:84629")?.publishRunId).toBe(CURRENT_RUN);
    expect(store.get("48209:84629")?.publishRunId).not.toBe(STALE_RUN);
    expect(servedPayloadCarriesPublishRunId(store.get("48209:84629"), CURRENT_RUN)).toBe(true);
  });

  it("writes exactly one retirement per excluded node -- no population is dropped or double-covered", () => {
    const excluded = ["84629", "84630", "84631", "84639"].map((p) => hollowItem(p));
    const { writes, accessRefused } = planFor(excluded);
    expect(writes.length + accessRefused).toBe(excluded.length);
    expect(writes.map((w) => w.parcelNodeId).sort()).toEqual(
      excluded.map((e) => e.parcelNodeId).sort(),
    );
  });

  it("counts an unnormalizable access pair and invents no pair for it", () => {
    const good = hollowItem("84629");
    // The second node's atom carries a pair the normalizer cannot resolve.
    const bad = {
      parcelNodeId: "48209:84630",
      body: { access: { entitlement: "anyone-free" }, sourceIdentifiers: { prop_id: "84630", taxYear: 2025 } },
    };
    const { writes, accessRefused } = planFor([good, bad], {
      resolveAccess: (input) => {
        const rec = input as Record<string, unknown> | null;
        return rec && typeof rec.discoverability === "string"
          ? alwaysNormalizes()
          : { ok: false };
      },
    });
    expect(accessRefused).toBe(1);
    expect(writes.map((w) => w.parcelNodeId)).toEqual(["48209:84629"]);
    // The refused node gets NO write at all -- not a payload with an invented pair.
    expect(writes.some((w) => w.parcelNodeId === "48209:84630")).toBe(false);
    expect(writes.length + accessRefused).toBe(2);
  });

  it("omits the stamp (rather than inventing one) when the bake has no publish run, and the walk then requires nothing", () => {
    const { writes } = planFor([hollow], { publishRunId: undefined });
    expect(writes).toHaveLength(1);
    expect("publishRunId" in writes[0].payload).toBe(false);
    expect(servedPayloadCarriesPublishRunId(writes[0].payload, null)).toBe(true);
  });
});

describe("P-180 retirement payload (a retirement, not a bake)", () => {
  const payloads: AccountKeyedRetirementPayload[] = planFor([
    hollowItem("84629"),
    hollowItem("84630"),
  ]).writes.map((w) => w.payload);

  it("carries an EARNED retirement the walk's own predicate accepts", () => {
    for (const p of payloads) expect(isEarnedRecordRetirement(p.recordRetirement)).toBe(true);
  });

  it("carries the conformant-v1 markers the walk checks before it looks at the retirement", () => {
    for (const p of payloads) {
      expect(p.facetSchemaVersion).toBe(CONFORMANT_SCHEMA_VERSION);
      expect(p.source).toContain("conformant-v1");
      expect(p.shapeSource).toBe("conformant-v1");
    }
  });

  it("serves NO facts: no fact-shaped key exists anywhere on the payload", () => {
    for (const p of payloads) {
      for (const key of ACCOUNT_KEYED_RETIREMENT_FORBIDDEN_FACT_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(p, key)).toBe(false);
      }
      expect(Object.keys(p.facets.base).sort()).toEqual([
        "apn",
        "parcelNodeId",
        "situsAddress",
      ]);
      expect(p.facets.base.situsAddress).toBeNull();
      expect(p.facetCoverage).toEqual({
        tier1: "populated",
        baseFacts: false,
        landUse: false,
        acreage: false,
        zoning: false,
        envelope: false,
      });
    }
  });

  it("names the parcel and the account in its basis, so two parcels never share one", () => {
    const [first, second] = payloads.map((p) => p.recordRetirement.basis);
    expect(first).toContain("48209:84629");
    expect(second).toContain("48209:84630");
    expect(first).not.toBe(second);
    // The scope names what was searched, so the absence is a positive determination.
    expect(payloads[0].recordRetirement.scopeSearched).toContain("txgio_parcel");
  });

  // -------------------------------------------------------------------------
  // P-370 (2026-09-19). THE RETIREMENT TEXT IS UNCHANGED, AND THAT IS A RESULT.
  //
  // P-370 added a third verdict -- a key a county's OWN published pair does not
  // reach is KEPT AND DECLARED, not retired. So a record is now written ONLY for
  // the counties whose same record was already right (those that publish no pair
  // over this run's keys), and this is the pinned proof rather than a claim: the
  // exact string, character for character, of the record the pre-P-370 code
  // wrote. A change here would mean P-370 had reworded somebody else's counties.
  // -------------------------------------------------------------------------
  it("THE RECORD'S BYTES ARE EXACTLY THE RECORD P-370's PREDECESSOR WROTE", () => {
    const [p] = payloads;
    expect(p.recordRetirement.scopeSearched).toBe(
      "txgio_parcel (the county's published parcel index), county_fips 48209, prop_id = 84629",
    );
    expect(p.recordRetirement.basis).toBe(
      "48209:84629: prop_id 84629 carries no row in the Hays County published parcel index " +
        "(txgio_parcel) for county_fips 48209, so this node is ACCOUNT-KEYED, not a parcel node: " +
        "it has no published geometry and no parcel facts; its own claim last carried tax_year 2025. " +
        "Retired by the tier-1 bake's account-keyed exclusion (P-180); no facts are served for it.",
    );
    expect(p.recordRetirement.authority).toBe(
      "Hays County GIS published parcel index (txgio_parcel) for county_fips 48209",
    );
    // And a county that DOES publish a pair writes no record at all through this
    // pass: its unreached keys are kept, so nothing is excluded to retire.
    const kept = partitionAccountKeyedWork(
      [hollowItem("84629")],
      new Set(),
      undefined,
    );
    expect(kept.excluded).toHaveLength(1);
    const declared = partitionAccountKeyedWork([hollowItem("84629")], new Set(), {
      nodeKeyByAccountKey: new Map([["99999", "R000001"]]),
      sources: ["tx_wcad_owner"],
      parcelTableShapeClasses: new Set(["r-account"]),
    });
    expect(declared.excluded).toEqual([]);
    expect(declared.declaredNoPublishedIdentifier).toBe(1);
    expect(planFor(declared.excluded).writes).toEqual([]);
  });
});
