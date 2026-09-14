import { describe, expect, it } from "vitest";
import {
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
});
