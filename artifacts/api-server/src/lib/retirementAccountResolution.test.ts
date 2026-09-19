/**
 * P-351 (2026-09-18). THE RETIREMENT RESOLUTION, PROVEN BY VIOLATION.
 *
 * THE DEFECT, IN ONE SENTENCE, because every test below is about this and
 * nothing else: after P-177 the builder's retirement arm reads
 * `cadPropRow == null`, and that one statement arrives from TWO opposite
 * states -- "the record's ACCOUNT was named and is genuinely absent from the
 * declared roll" (a real retirement) and "no account could be named, so
 * nothing was ever looked up" (a lookup that did not happen). Measured on
 * production 2026-09-18, Hays served 1,386 retirements of which 0 were
 * genuine, and Williamson retired all 282,570 of its published R nodes, of
 * which 0 were genuine. A lookup that did not happen is not a lookup that came
 * back empty.
 *
 * HOW BOTH DIRECTIONS ARE SHOWN WITHOUT A STASH. The pre-change behaviour is
 * not simulated: it is the builder's own LEGACY PATH, which the fixed builder
 * still takes whenever no resolution is supplied (`retirementResolution ==
 * null`) and which is unchanged by this row. So each falsifier below runs the
 * SAME fixture twice --
 *
 *   (1) the pre-change input: the roll (raw, or the remapped view the pre-P-351
 *       CLI actually handed the builder) and NO resolution -> the defect
 *       reproduces;
 *   (2) the fixed input: the same roll plus the resolution -> the defect is
 *       gone.
 *
 * -- and asserts the defective outcome in (1) and the correct one in (2). A
 * test that only asserted (2) would pass on a builder that ignored the
 * resolution entirely for any population it happens to get right.
 */

import { describe, it, expect } from "vitest";
import {
  buildPublishedAccountPair,
  buildPublishedNodeKeyByAccountKey,
  chooseRetirementResolution,
  describeRetirementKeyspaces,
  ownPropIdResolution,
  rAccountRegisterKey,
  nodeKeyShapeClass,
  type PublishedAccountPairRow,
  type RetirementResolution,
} from "./retirementAccountResolution";
import {
  accountKeyedBlastRadius,
  assertAccountKeyedBlastRadius,
  partitionAccountKeyedWork,
  ACCOUNT_KEYED_RETIREMENT_FORBIDDEN_FACT_KEYS,
} from "./accountKeyedWork";
import type { PropIdCadPropertyEntry } from "./joinIntegrityGate";
import { contentHashForPayload } from "./placeLayerUtils";
import {
  buildConformantTier1Payload,
  type ConformantTier1BuildInput,
  type ConformantTier1Payload,
} from "./nodeFacetBakeTier1Conformant";
import {
  HAYS_DECLARED_TAX_YEAR,
  HAYS_NODE_GEO_IDS,
  HAYS_PRIOR_TAX_YEAR,
  HAYS_ROLL_2025,
  HAYS_ROLL_2026,
  HAYS_SERVED_KEYS,
  TWO_KEYSPACE_LABELS,
  WILLIAMSON_ACCOUNT_PAIR,
  WILLIAMSON_ROLL_2026,
  WILLIAMSON_SERVED_KEYS,
  type CadRollRowFixture,
} from "./__tests__/__fixtures__/p351RetirementKeyspace";

// ---------------------------------------------------------------------------
// The world, assembled the way the CLI assembles it. Every helper here mirrors
// a specific block of `nodeFacetBakeTier1ConformantCli.ts`; nothing here
// decides anything the CLI does not decide.
// ---------------------------------------------------------------------------

const HAYS_KEYS = describeRetirementKeyspaces(true);
const SINGLE_KEYS = describeRetirementKeyspaces(false);

/** A full roll entry: the row is read for dollars and identity, so nothing is left to chance. */
function rollEntry(r: CadRollRowFixture): PropIdCadPropertyEntry {
  return {
    propId: r.propId,
    taxYear: r.taxYear,
    sourceVintage: `cad-${r.taxYear}`,
    situsAddress: r.situsAddress,
    situsCity: null,
    situsZip: null,
    landAcres: null,
    propertyNumber: r.propertyNumber,
    quickRefId: r.quickRefId,
    rollMembership: null,
    declaredSourceFile: null,
    marketValue: r.marketValue,
    assessedValue: r.marketValue,
    landValue: null,
    improvementValue: null,
    livingAreaSqft: null,
    yearBuilt: null,
    legalDescription: null,
    exemptionCodes: null,
  };
}

const haysRoll = new Map(HAYS_ROLL_2026.map((r) => [r.propId, rollEntry(r)]));
const haysRoll2025 = new Map(HAYS_ROLL_2025.map((r) => [r.propId, rollEntry(r)]));

function haysRollFor(): ConformantTier1BuildInput["cadPropertyRoll"] {
  return { consulted: true, declaredTaxYear: HAYS_DECLARED_TAX_YEAR, byPropId: haysRoll };
}

/**
 * The pre-P-351 CLI's REMAPPED view, reduced to the one row a test needs. The
 * CLI built it by iterating the work ids and inserting a row ONLY where the
 * account-attribute crosswalk bound one; a node whose bind declined got NO
 * entry, and the builder then read that absence as an earned retirement.
 */
function remappedView(
  nodeKey: string,
  boundAccountPropId: string | null,
): ConformantTier1BuildInput["cadPropertyRoll"] {
  const byPropId = new Map<string, PropIdCadPropertyEntry>();
  const bound = boundAccountPropId == null ? null : haysRoll.get(boundAccountPropId);
  if (bound) byPropId.set(nodeKey, bound);
  return { consulted: true, declaredTaxYear: HAYS_DECLARED_TAX_YEAR, byPropId };
}

/**
 * The FIXED CLI's BUILDER roll, in the shape the builder's own lookup asks for.
 * The CLI keeps two maps over the SAME rows: this one
 * (`builderRollByAccount`) is keyed by the ACCOUNT the resolution named, and is
 * what `buildConformantTier1Payload` is handed; the node-keyed one above is what
 * the CLI's own situs/ring/geometry reads use. Built here the way the CLI builds
 * it, so the test cannot prove a keying its caller does not implement.
 */
function accountKeyedBuilderView(
  accountPropId: string | null,
): ConformantTier1BuildInput["cadPropertyRoll"] {
  const byPropId = new Map<string, PropIdCadPropertyEntry>();
  if (accountPropId != null) {
    const row = haysRoll.get(accountPropId);
    if (row) byPropId.set(accountPropId, row);
  }
  return { consulted: true, declaredTaxYear: HAYS_DECLARED_TAX_YEAR, byPropId };
}

/** The indexes the CLI builds from the roll rows it ALREADY loaded -- the same read that feeds the dollars. */
function registerIndexes(rows: readonly CadRollRowFixture[]) {
  const registerPropIdByQuickRefId = new Map<string, string>();
  const refusedRegisterKeys = new Set<string>();
  const propertyNumberByAccountPropId = new Map<string, string>();
  for (const row of rows) {
    const pn = row.propertyNumber?.trim() ?? "";
    if (pn !== "") propertyNumberByAccountPropId.set(row.propId, pn);
    const qr = row.quickRefId?.trim().toUpperCase() ?? "";
    if (qr === "") continue;
    const existing = registerPropIdByQuickRefId.get(qr);
    if (existing === undefined) registerPropIdByQuickRefId.set(qr, row.propId);
    else if (existing !== row.propId) refusedRegisterKeys.add(qr);
  }
  return { registerPropIdByQuickRefId, refusedRegisterKeys, propertyNumberByAccountPropId };
}

const haysIdx = registerIndexes(HAYS_ROLL_2026);
const haysPriorIdx = registerIndexes(HAYS_ROLL_2025);

/** geo_id -> the roll prop_id whose published property_number equals it. */
function geoIdIndex(rows: readonly CadRollRowFixture[]): Map<string, string> {
  return new Map(
    rows
      .filter((r) => r.propertyNumber != null)
      .map((r) => [r.propertyNumber as string, r.propId]),
  );
}

/** account prop_id -> its account-number stem, the geo bind's corroborator. */
function stemIndex(rows: readonly CadRollRowFixture[]): Map<string, string> {
  return new Map(
    rows
      .filter((r) => r.quickRefId != null && /^R[0-9]+$/.test(r.quickRefId))
      .map((r) => [r.propId, (r.quickRefId as string).slice(1)]),
  );
}

/** `nodeGeoId` is the value the CLI reads off `txgio_parcel.geo_id` for the node itself. */
function haysResolution(nodeKey: string): RetirementResolution {
  return chooseRetirementResolution({
    nodeKey,
    countyFips: "48209",
    blocked: true,
    nodeGeoId: HAYS_NODE_GEO_IDS.get(nodeKey) ?? null,
    geoIdToAccountPropId: geoIdIndex([...haysRoll.values()]),
    accountStemByPropId: stemIndex([...haysRoll.values()]),
    propertyNumberByAccountPropId: haysIdx.propertyNumberByAccountPropId,
    registerPropIdByQuickRefId: haysIdx.registerPropIdByQuickRefId,
    refusedRegisterKeys: haysIdx.refusedRegisterKeys,
    priorRegisterByQuickRefId: new Map(
      [...haysPriorIdx.registerPropIdByQuickRefId].map(([qr, propId]) => [
        qr,
        {
          propId,
          propertyNumber: haysPriorIdx.propertyNumberByAccountPropId.get(propId) ?? null,
        },
      ]),
    ),
    refusedPriorRegisterKeys: haysPriorIdx.refusedRegisterKeys,
    keyspaces: HAYS_KEYS,
  });
}

function williamsonPair() {
  const bySource = new Map<string, PublishedAccountPairRow[]>();
  for (const p of WILLIAMSON_ACCOUNT_PAIR) {
    const row: PublishedAccountPairRow = {
      nodeKey: p.nodeKey,
      accountKey: p.accountKey,
      source: p.source,
    };
    const b = bySource.get(p.source);
    if (b) b.push(row);
    else bySource.set(p.source, [row]);
  }
  return buildPublishedAccountPair([...bySource.values()]);
}

const WILLIAMSON_KEYS = describeRetirementKeyspaces(true);

function williamsonRoll(): ConformantTier1BuildInput["cadPropertyRoll"] {
  return {
    consulted: true,
    declaredTaxYear: 2026,
    byPropId: new Map(WILLIAMSON_ROLL_2026.map((r) => [r.propId, rollEntry(r)])),
  };
}

function williamsonResolution(nodeKey: string): RetirementResolution {
  return chooseRetirementResolution({
    nodeKey,
    countyFips: "48491",
    blocked: true,
    nodeGeoId: null,
    geoIdToAccountPropId: new Map(),
    accountStemByPropId: new Map(),
    propertyNumberByAccountPropId: new Map(),
    // Williamson publishes ZERO non-blank quick_ref_id on either vintage
    // (measured 2026-09-18): the register paths cannot fire at all.
    registerPropIdByQuickRefId: new Map(),
    priorRegisterByQuickRefId: new Map(),
    keyspaces: WILLIAMSON_KEYS,
    publishedPair: williamsonPair(),
  });
}

const CANONICAL_ACCESS = { discoverability: "catalog-listed", entitlement: "anyone-free" };
const NOW = "2026-09-18T12:00:00.000Z";

/**
 * The bake's own content hash, not a second implementation of one: the same
 * function the write path stamps with, so a golden hash here and a served
 * hash there are comparable numbers rather than two opinions.
 */
function hashPayload(p: ConformantTier1Payload): string {
  return contentHashForPayload(p as unknown as Record<string, unknown>);
}

/**
 * THE BYTE-IDENTITY GOLDEN HASH. Recorded 2026-09-18 by building this exact
 * payload (48209 node 100016, the four declared-vintage Hays roll rows, no
 * resolution supplied) through the PRE-change builder -- the four modified LDT
 * source files stashed, the fixture and the inputs untouched -- and hashing the
 * serialised payload with `contentHashForPayload`. Filled in from that
 * measurement; the test asserts the shape first so a placeholder can never pass
 * as a measurement.
 */
const PRE_P351_GOLDEN_HASH =
  "eba16ad66a51ca86d94e440dd909f00eb095d082da1d46d210f4fc267ea1391b";

/** A conformant atom body, with the node's own claim, for any county. */
function body(fips: string, nodeKey: string, overrides: Record<string, unknown> = {}) {
  return {
    shape: "conformant-v1",
    nodeId: `${fips}:${nodeKey}`,
    entityType: "cad-parcel-roll",
    claim: {
      kind: "cad-parcel-roll",
      countyFips: fips,
      sourceIdentifiers: { prop_id: nodeKey, taxYear: HAYS_PRIOR_TAX_YEAR },
      situsAddress: "1 CLAIM RD, KYLE, TX 78640",
      situsCity: "KYLE",
      situsZip: "78640",
      ownerName: "OWNER MUST NEVER BAKE",
      legalDescription: "LOT 1",
      landValue: 10000,
      improvementValue: 90000,
      marketValue: 100000,
      assessedValue: 100000,
      yearBuilt: 1950,
      livingAreaSqft: 1200,
      landAcres: 0.3815,
      propertyUseCode: "A1",
      centroid: null,
      ...((overrides.claim as Record<string, unknown> | undefined) ?? {}),
    },
    access: CANONICAL_ACCESS,
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "claim")),
  };
}

function build(
  fips: string,
  countyName: string,
  nodeKey: string,
  opts: {
    cadPropertyRoll: ConformantTier1BuildInput["cadPropertyRoll"];
    retirementResolution?: RetirementResolution;
  },
) {
  return buildConformantTier1Payload({
    body: body(fips, nodeKey),
    parcelNodeId: `${fips}:${nodeKey}`,
    countyFips: fips,
    countyName,
    situsAddress: "1 CLAIM RD, KYLE, TX 78640",
    access: CANONICAL_ACCESS,
    accessNormalizedFrom: null,
    publishRunId: "3f0f4bd1-89f0-4a4e-9a6a-2b7f0c3a9d11",
    parcelJoin: { table: "txgio_parcel", row: null, gateBlocked: true },
    cadPropertyRoll: opts.cadPropertyRoll,
    ...(opts.retirementResolution
      ? { retirementResolution: opts.retirementResolution }
      : {}),
    nowIso: NOW,
  });
}

const buildHays = (
  nodeKey: string,
  opts: {
    cadPropertyRoll: ConformantTier1BuildInput["cadPropertyRoll"];
    retirementResolution?: RetirementResolution;
  },
) => build("48209", "Hays", nodeKey, opts);

const buildWilliamson = (
  nodeKey: string,
  opts: {
    cadPropertyRoll: ConformantTier1BuildInput["cadPropertyRoll"];
    retirementResolution?: RetirementResolution;
  },
) => build("48491", "Williamson", nodeKey, opts);

// ---------------------------------------------------------------------------
// The pure module: the register's own key, key shape, and the pair's refusals.
// ---------------------------------------------------------------------------

describe("P-351 the R-account register key is the PUBLISHED identifier, never a bare number", () => {
  it("prefixes the node key, so the register test can never be a bare-number match", () => {
    expect(rAccountRegisterKey("100013")).toBe("R100013");
    expect(rAccountRegisterKey("R100013")).toBeNull();
    expect(rAccountRegisterKey("PRIVATE ROAD")).toBeNull();
    expect(rAccountRegisterKey("")).toBeNull();
  });

  it("classifies key shape for the writer-(b) keyspace split and for nothing else", () => {
    expect(nodeKeyShapeClass("100013")).toBe("numeric");
    expect(nodeKeyShapeClass("R005578")).toBe("r-account");
    expect(nodeKeyShapeClass("PRIVATE ROAD")).toBe("other");
  });
});

describe("P-351 the published pair refuses rather than picking a winner", () => {
  it("two extracts naming the SAME account yield the pair", () => {
    const pair = williamsonPair();
    expect(pair.pairByNodeKey.get("R005578")).toBe("123456");
    expect(pair.sources.length).toBe(2);
    expect(pair.refusedDisagreement).toBe(0);
  });

  it("two extracts DISAGREEING on a key refuse that key and count it", () => {
    const pair = buildPublishedAccountPair([
      [{ nodeKey: "R1", accountKey: "111", source: "tx_wcad_owner" }],
      [{ nodeKey: "R1", accountKey: "222", source: "tx_wcad_ag_valuation" }],
    ]);
    expect(pair.pairByNodeKey.has("R1")).toBe(false);
    expect(pair.refusedDisagreement).toBe(1);
  });

  it("one extract naming a key twice with different accounts refuses it as ambiguous", () => {
    const pair = buildPublishedAccountPair([
      [
        { nodeKey: "R1", accountKey: "111", source: "tx_wcad_owner" },
        { nodeKey: "R1", accountKey: "222", source: "tx_wcad_owner" },
      ],
    ]);
    expect(pair.pairByNodeKey.has("R1")).toBe(false);
    expect(pair.refusedAmbiguous).toBe(1);
  });

  it("a key an extract carried with NO account is refused and counted, never silently dropped", () => {
    const pair = buildPublishedAccountPair([
      [{ nodeKey: "R1", accountKey: "", source: "tx_wcad_owner" }],
    ]);
    expect(pair.pairByNodeKey.has("R1")).toBe(false);
    expect(pair.refusedNoAccount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F1 -- HAYS COLLISION. Both directions.
// ---------------------------------------------------------------------------

describe("F1 HAYS COLLISION: a node whose bare key is also an unrelated account's prop_id", () => {
  // Node 100013: carries NO geo_id (the 810 class), and its bare key 100013 IS
  // a real declared-roll prop_id for an unrelated account worth 9,382. The
  // node's OWN account is R100013 -> prop_id 120302, worth 425,000.
  it("PRE-CHANGE (raw roll, no resolution): serves the colliding account's dollars", () => {
    const p = buildHays("100013", { cadPropertyRoll: haysRollFor() });
    expect(p.baseFacts.cadRoll.marketValue?.v).toBe(9382);
    expect(p.baseFacts.cadRoll.marketValue?.v).not.toBe(425000);
  });

  it("PRE-CHANGE (the remapped view the CLI built once the bind declined, no resolution): earns a FALSE retirement", () => {
    const preChange = buildHays("100013", {
      cadPropertyRoll: remappedView("100013", null),
    });
    expect(preChange.recordRetirement).not.toBeNull();
    expect(preChange.recordRetirement?.status).toBe("retired");
    expect(preChange.retirementResolution).toBeUndefined();
  });

  it("FIXED: resolves through the declared register, does NOT retire, and takes the right account's dollars", () => {
    const resolution = haysResolution("100013");
    expect(resolution.status).toBe("resolved");
    expect(resolution.path).toBe("r-account-register");
    expect(resolution.accountKey).toBe("120302");
    expect(resolution.accountOnDeclaredRoll).toBe(true);

    // The defect's own shape, kept in both directions: the roll the pre-change
    // CLI built for this node carried NO entry at all. Handed to the FIXED arm
    // with its resolution, it still does not retire -- the resolution already
    // determined that R100013 IS on the declared roll, and the arm does not
    // reach a retirement from a row it was never given.
    const noEntry = buildHays("100013", {
      cadPropertyRoll: remappedView("100013", null),
      retirementResolution: resolution,
    });
    expect(noEntry.recordRetirement).toBeNull();
    expect(noEntry.retirementResolution?.verdict).toBe("account-resolved");
    expect(noEntry.retirementResolution?.path).toBe("r-account-register");
    expect(noEntry.retirementResolution?.accountKey).toBe("120302");
    expect(noEntry.retirementResolution?.basis).toContain("NOT retired");

    // And with the builder roll the FIXED CLI actually hands it -- keyed by the
    // ACCOUNT (see `builderRollByAccount` in the CLI) -- the dollars come off the
    // account, never the colliding row at the node's bare number.
    const fixed = buildHays("100013", {
      cadPropertyRoll: accountKeyedBuilderView(resolution.accountKey),
      retirementResolution: resolution,
    });
    expect(fixed.recordRetirement).toBeNull();
    expect(fixed.baseFacts.cadRoll.marketValue?.v).toBe(425000);
  });
});

// ---------------------------------------------------------------------------
// F2 -- WILLIAMSON PAIR. Both directions.
// ---------------------------------------------------------------------------

describe("F2 WILLIAMSON PAIR: the R node reached by the county's own published pair, and the one it does not reach", () => {
  it("PRE-CHANGE (remapped view, no resolution): an R node whose account IS on the roll earns a retirement", () => {
    const preChange = buildWilliamson("R005578", {
      cadPropertyRoll: remappedView("R005578", null),
    });
    expect(preChange.recordRetirement).not.toBeNull();
  });

  it("FIXED: reached by the pair -> resolves to the numeric account, does NOT retire, and serves its facts", () => {
    const resolution = williamsonResolution("R005578");
    expect(resolution.status).toBe("resolved");
    expect(resolution.path).toBe("published-account-pair");
    expect(resolution.accountKey).toBe("123456");
    // The pair names a key in the ROLL's keyspace, so nothing here has decided
    // presence -- the arm's own single lookup stays the test.
    expect(resolution.accountOnDeclaredRoll).toBeNull();

    const fixed = buildWilliamson("R005578", {
      cadPropertyRoll: williamsonRoll(),
      retirementResolution: resolution,
    });
    expect(fixed.recordRetirement).toBeNull();
    expect(fixed.baseFacts.cadRoll.marketValue?.v).toBe(318400);
    expect(fixed.retirementResolution?.verdict).toBe("account-resolved");
    expect(fixed.retirementResolution?.accountKey).toBe("123456");
  });

  it("FIXED: NOT reached by the pair -> NOT retired, and the payload declares why", () => {
    const resolution = williamsonResolution("R006142");
    expect(resolution.status).toBe("unresolved");
    expect(resolution.reason).toBe("no-published-identifier");

    const preChange = buildWilliamson("R006142", {
      cadPropertyRoll: remappedView("R006142", null),
    });
    // The defect, for the 424 nodes the pair does not reach: a retirement.
    expect(preChange.recordRetirement).not.toBeNull();

    const fixed = buildWilliamson("R006142", {
      cadPropertyRoll: remappedView("R006142", null),
      retirementResolution: resolution,
    });
    expect(fixed.recordRetirement).toBeNull();
    expect(fixed.retirementResolution?.verdict).toBe("key-unresolvable");
  });
});

// ---------------------------------------------------------------------------
// F3 -- THE PREDICATE IS NOT WEAKENED. A genuine retirement still retires.
// ---------------------------------------------------------------------------

describe("F3 A GENUINE ACCOUNT RETIREMENT STILL RETIRES", () => {
  // Node 100014: its account R100014 -> prop_id 130637 was on the 2025 roll
  // and is on NO 2026 row. The declared roll cannot name it (it is gone); the
  // PRIOR vintage names it for identity only. This is the county's real
  // retirement signal and it must survive the fix.
  it("the account left the roll -> the prior vintage names it and the record retires", () => {
    const resolution = haysResolution("100014");
    expect(resolution.status).toBe("resolved");
    expect(resolution.path).toBe("r-account-register-prior-vintage");
    expect(resolution.accountKey).toBe("130637");
    expect(resolution.accountOnDeclaredRoll).toBe(false);

    const fixed = buildHays("100014", {
      cadPropertyRoll: haysRollFor(),
      retirementResolution: resolution,
    });
    expect(fixed.recordRetirement).not.toBeNull();
    expect(fixed.recordRetirement?.status).toBe("retired");
    // The retirement names the ACCOUNT it compared, not the node's bare key.
    expect(fixed.recordRetirement?.basis).toContain("130637");
    expect(fixed.recordRetirement?.scopeSearched).toContain("48209");
  });

  it("the prior-vintage account's prop_id is NEVER read as a declared-roll row", () => {
    // 130637 is not a declared-2026 prop_id at all, so the raw roll cannot
    // serve it; this pins the rule, not the accident. The assertion that
    // matters is that the arm does not read the roll at that key even when a
    // row IS there -- see the next test.
    expect(haysRoll.has("130637")).toBe(false);
    const fixed = buildHays("100014", {
      cadPropertyRoll: haysRollFor(),
      retirementResolution: haysResolution("100014"),
    });
    expect(fixed.baseFacts.cadRoll.marketValue).toBeNull();
  });

  it("a prior-vintage prop_id that COLLIDES with a declared-roll row is still not read", () => {
    // The hazard this rule exists for: the prior account's prop_id happens to
    // equal a live, unrelated declared-roll row. Reading it would serve that
    // row's dollars under this record AND cancel its earned retirement.
    const colliding = new Map(haysRoll);
    colliding.set("130637", rollEntry({ ...HAYS_ROLL_2026[1] as CadRollRowFixture, propId: "130637" }));
    const fixed = buildHays("100014", {
      cadPropertyRoll: {
        consulted: true,
        declaredTaxYear: HAYS_DECLARED_TAX_YEAR,
        byPropId: colliding,
      },
      retirementResolution: haysResolution("100014"),
    });
    expect(fixed.baseFacts.cadRoll.marketValue).toBeNull();
    expect(fixed.recordRetirement).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F4 -- AN UNRESOLVABLE KEY IS DECLARED, NOT RETIRED.
// ---------------------------------------------------------------------------

describe("F4 AN UNRESOLVABLE KEY IS DECLARED, NOT RETIRED", () => {
  it("nothing names an account -> no retirement, and a per-parcel basis that says so", () => {
    const resolution = haysResolution("100015");
    expect(resolution.status).toBe("unresolved");
    expect(resolution.accountKey).toBeNull();
    expect(resolution.reason).not.toBeNull();

    const preChange = buildHays("100015", {
      cadPropertyRoll: remappedView("100015", null),
    });
    expect(preChange.recordRetirement).not.toBeNull();

    const fixed = buildHays("100015", {
      cadPropertyRoll: remappedView("100015", null),
      retirementResolution: resolution,
    });
    expect(fixed.recordRetirement).toBeNull();
    const statement = fixed.retirementResolution;
    expect(statement?.verdict).toBe("key-unresolvable");
    expect(statement?.reason).toBe(resolution.reason);
    expect(statement?.basis).toContain("48209:100015");
    expect(statement?.nodeKeyspace).toBe(TWO_KEYSPACE_LABELS.nodeKeyspace);
    expect(statement?.rollKeyspace).toBe(TWO_KEYSPACE_LABELS.rollKeyspace);
    expect(statement?.rollTaxYear).toBe(HAYS_DECLARED_TAX_YEAR);
  });

  it("two parcels never share a character-identical basis", () => {
    const a = buildHays("100015", {
      cadPropertyRoll: remappedView("100015", null),
      retirementResolution: haysResolution("100015"),
    });
    const b = buildWilliamson("R006142", {
      cadPropertyRoll: remappedView("R006142", null),
      retirementResolution: williamsonResolution("R006142"),
    });
    expect(a.retirementResolution?.basis).not.toBe(b.retirementResolution?.basis);
  });

  it("a CONTRADICTED key is refused, not retired: the node's own geo_id names another parcel", () => {
    // Node 100017: its own published geo_id disagrees with the property_number
    // of the account its own number names (the 232 class, measured).
    const resolution = haysResolution("100017");
    expect(resolution.status).toBe("unresolved");
    expect(resolution.reason).toBe("contradicted-by-node-identifier");

    const fixed = buildHays("100017", {
      cadPropertyRoll: remappedView("100017", null),
      retirementResolution: resolution,
    });
    expect(fixed.recordRetirement).toBeNull();
    expect(fixed.retirementResolution?.verdict).toBe("key-unresolvable");
  });

  it("an ambiguous published account number is refused rather than won by a coin toss", () => {
    const resolution = chooseRetirementResolution({
      nodeKey: "100013",
      countyFips: "48209",
      blocked: true,
      nodeGeoId: null,
      registerPropIdByQuickRefId: new Map([["R100013", "120302"]]),
      refusedRegisterKeys: new Set(["R100013"]),
      keyspaces: HAYS_KEYS,
    });
    expect(resolution.status).toBe("unresolved");
    expect(resolution.reason).toBe("ambiguous-property-number");
  });
});

// ---------------------------------------------------------------------------
// F5 -- A SINGLE-KEYSPACE COUNTY IS UNTOUCHED.
// ---------------------------------------------------------------------------

describe("F5 A SINGLE-KEYSPACE COUNTY IS BYTE-IDENTICAL", () => {
  it("with no resolution supplied, the payload carries NO retirementResolution key at all", () => {
    const p = buildHays("100016", { cadPropertyRoll: haysRollFor() });
    expect("retirementResolution" in p).toBe(false);
    expect(p.retirementResolution).toBeUndefined();
  });

  it("the legacy path's bytes do not depend on the resolution machinery (golden hash, recorded on pre-P-351 code)", () => {
    // GOLDEN HASH. Recorded by building this exact payload on the PRE-change
    // builder (`git stash` of the LDT source changes, the same fixture, the
    // same inputs) and hashing the serialised payload with the bake's own
    // `contentHashForPayload`. If a later change alters a single-keyspace
    // payload that carries no resolution, this fails and the change is
    // visible rather than absorbed.
    const p = buildHays("100016", { cadPropertyRoll: haysRollFor() });
    expect(PRE_P351_GOLDEN_HASH).toMatch(/^[0-9a-f]{16,}$/);
    expect(hashPayload(p)).toBe(PRE_P351_GOLDEN_HASH);
  });

  it("the single-keyspace resolution is the own-prop-id path and names ONE keyspace", () => {
    const r = ownPropIdResolution("34137", SINGLE_KEYS);
    expect(r.path).toBe("own-prop-id");
    expect(r.accountKey).toBe("34137");
    expect(SINGLE_KEYS.nodeKeyspace).toBe(SINGLE_KEYS.rollKeyspace);
    expect(SINGLE_KEYS.nodeKeyspace).not.toBe(TWO_KEYSPACE_LABELS.nodeKeyspace);
  });
});

// ---------------------------------------------------------------------------
// F6 -- THE WRITER-(b) INSTRUMENT FIRES ON A WHOLE KEYSPACE AND NOT OTHERWISE.
// ---------------------------------------------------------------------------

describe("F6 WRITER (b)'s BLAST-RADIUS INSTRUMENT", () => {
  const served = (name: string, keys: readonly string[]) => ({ name, keys: new Set(keys) });

  it("REFUSES when the excluded set IS a whole served keyspace, and names it", () => {
    const excluded = WILLIAMSON_SERVED_KEYS.map((k) => ({
      parcelNodeId: `48491:${k}`,
      body: {},
    }));
    const verdict = accountKeyedBlastRadius(excluded, [
      served("the county's R-account served node keys", WILLIAMSON_SERVED_KEYS),
    ]);
    expect(verdict.verdict).toBe("refuse");
    expect(verdict.keyspace).toBe("the county's R-account served node keys");
    expect(verdict.reason).toContain("ACCOUNT_KEYED_BLAST_RADIUS");
    expect(() => assertAccountKeyedBlastRadius(verdict)).toThrow(
      /ACCOUNT_KEYED_BLAST_RADIUS/,
    );
  });

  it("REFUSES one keyspace while another survives: the shape a single keyspace cannot see", () => {
    const excluded = WILLIAMSON_SERVED_KEYS.map((k) => ({
      parcelNodeId: `48491:${k}`,
      body: {},
    }));
    const verdict = accountKeyedBlastRadius(excluded, [
      served("R-account keys", WILLIAMSON_SERVED_KEYS),
      served("numeric keys", HAYS_SERVED_KEYS),
    ]);
    expect(verdict.verdict).toBe("refuse");
    expect(verdict.keyspace).toBe("R-account keys");
    expect(verdict.perKeyspace).toEqual([
      { name: "R-account keys", served: 3, excluded: 3 },
      { name: "numeric keys", served: 5, excluded: 0 },
    ]);
  });

  it("PASSES the measured Hays shape: a hollow subset of ONE keyspace is the pass's premise, not a blast radius", () => {
    const excluded = ["100013", "100014"].map((k) => ({
      parcelNodeId: `48209:${k}`,
      body: {},
    }));
    const verdict = accountKeyedBlastRadius(excluded, [
      served("numeric keys", HAYS_SERVED_KEYS),
    ]);
    expect(verdict.verdict).toBe("ok");
    expect(verdict.keyspace).toBeNull();
    expect(() => assertAccountKeyedBlastRadius(verdict)).not.toThrow();
  });

  it("an EMPTY served keyspace is not refused: there is nothing to empty", () => {
    const verdict = accountKeyedBlastRadius([], [served("empty", [])]);
    expect(verdict.verdict).toBe("ok");
  });

  it("the pass and the instrument read the SAME partition, so neither can disagree about the population", () => {
    const work = HAYS_SERVED_KEYS.map((k) => ({ parcelNodeId: `48209:${k}`, body: {} }));
    const { excluded } = partitionAccountKeyedWork(work, new Set(["100013", "100014"]));
    expect(excluded.map((e) => e.parcelNodeId).sort()).toEqual([
      "48209:100015",
      "48209:100016",
      "48209:100017",
    ]);
  });

  it("the retirement payload the pass writes still carries NO facts (the mission's own falsifier)", () => {
    expect(ACCOUNT_KEYED_RETIREMENT_FORBIDDEN_FACT_KEYS).toContain("baseFacts");
    expect(ACCOUNT_KEYED_RETIREMENT_FORBIDDEN_FACT_KEYS).toContain("cadRoll");
  });
});

// ---------------------------------------------------------------------------
// F7 -- THE KEYS THAT CANNOT BE NAMED ARE COUNTED, NOT ABSORBED.
// ---------------------------------------------------------------------------

describe("F7 EVERY OUTCOME IS A DISTINCT PATH OR A DISTINCT NAMED REASON", () => {
  it("the five Hays nodes land on five distinct outcomes, so a run that stops resolving is visible", () => {
    const outcomes = HAYS_SERVED_KEYS.map((k) => {
      const r = haysResolution(k);
      return r.status === "resolved" ? `resolved:${r.path}` : `unresolved:${r.reason}`;
    });
    expect(outcomes).toEqual([
      // 100013: the colliding node, named by the declared register, LIVE.
      "resolved:r-account-register",
      // 100014: the account left the roll; named by the PRIOR vintage.
      "resolved:r-account-register-prior-vintage",
      // 100015: nothing names an account at all.
      "unresolved:no-published-identifier",
      // 100016: the ordinary geo bind.
      "resolved:crosswalk-geo-id-bind",
      // 100017: the 232 class -- two published identifiers disagreeing.
      "unresolved:contradicted-by-node-identifier",
    ]);
    expect(new Set(outcomes).size).toBe(outcomes.length);
  });

  it("resolved names an account and a path; unresolved names a reason -- never both, never neither", () => {
    for (const k of [...HAYS_SERVED_KEYS, ...WILLIAMSON_SERVED_KEYS]) {
      const r = k.startsWith("R") ? williamsonResolution(k) : haysResolution(k);
      if (r.status === "resolved") {
        expect(r.accountKey).not.toBeNull();
        expect(r.path).not.toBeNull();
        expect(r.reason).toBeNull();
      } else {
        expect(r.accountKey).toBeNull();
        expect(r.path).toBeNull();
        expect(r.reason).not.toBeNull();
      }
      expect(r.detail.length).toBeGreaterThan(20);
      expect(r.nodeKey).toBe(k);
    }
  });
});

// ---------------------------------------------------------------------------
// P-370 (2026-09-19) -- WRITER (b) TESTS MEMBERSHIP IN THE NODE'S OWN KEYSPACE.
//
// THE DEFECT, IN ONE SENTENCE, because every test below is about this and
// nothing else: `partitionAccountKeyedWork` asks whether the work key is a
// `txgio_parcel` prop_id, and that is the right question only in a county whose
// served keys ARE that table's keys. Williamson publishes R-prefixed ids in the
// parcel table and keys its declared roll numerically, so the bare-key test
// excluded the WHOLE numeric keyspace -- and F6's instrument above then REFUSED,
// which is exactly the refusal that held the county out of the 2026-09-19
// staging publish.
//
// MEASURED, read-only on staging 2026-09-19, and the numbers the fixture is a
// scale model of: 319,480 numeric work keys, ALL 319,480 excluded by the
// bare-key test (the whole numeric served keyspace, so the run refused and never
// reached a write), of which 282,146 are named by the county's own staged pair
// to an R prop_id the parcel table publishes, leaving 37,334 excluded. The
// fixture keeps that arithmetic and its failure modes at 1/100,000 scale: mostly
// reached, one reached-by-a-pair-row-that-names-a-prop_id-this-county-does-not-
// publish (the two-source disagreement the reverse builder refuses rather than
// guesses), and one named by nothing.
//
// BOTH DIRECTIONS, and the reason this file can show them without a stash: the
// second arm is OPTIONAL, so the same fixture runs through the same partition
// twice -- once as the code ran before P-370 (the refusal reproduces) and once
// with the pair (the refusal is gone) -- and the instrument it refuses with is
// the one F6 above already proves.
// ---------------------------------------------------------------------------
describe("F8 WRITER (b) TESTS THE NODE'S OWN KEYSPACE (P-370)", () => {
  const served = (name: string, keys: readonly string[]) => ({ name, keys: new Set(keys) });

  // The parcel table's prop_id column for this county, as `joinParcelRows` hands
  // it over: R-prefixed. That prefix is the entire defect -- the numeric keys
  // the work list carries are not in it.
  const parcelIndexKeys = new Set(["R005578", "R006142", "R007323"]);
  const NUMERIC_KEYS = ["123456", "999888", "777666"] as const;
  const NUMERIC_KEYSPACE_LABEL =
    "the county's numeric served node keys (the parcel index's own numbering)";
  const R_KEYSPACE_LABEL = "the county's R-account served node keys";

  // The work list: the numeric keys the declared roll is keyed by, and the R keys
  // the parcel table publishes. Both are served; only the R keys are in the
  // parcel table's own numbering.
  const work: { parcelNodeId: string; body: Record<string, unknown> }[] = [
    ...NUMERIC_KEYS.map((k) => ({ parcelNodeId: `48491:${k}`, body: {} })),
    ...WILLIAMSON_SERVED_KEYS.map((k) => ({ parcelNodeId: `48491:${k}`, body: {} })),
  ];
  // 123456 -> R005578: the paydirt row (282,146 of the 319,480 measured).
  // 999888 -> R999999: NAMED, but the parcel table does not publish R999999, so
  // the county scoping must NOT let it through.
  // 777666 -> nothing names it.
  const pair = {
    nodeKeyByAccountKey: new Map([
      ["123456", "R005578"],
      ["999888", "R999999"],
    ]),
    sources: ["tx_wcad_owner", "tx_wcad_ag_valuation"],
    // The parcel table's own numbering for this county, measured on the keys the
    // run read: r-account shaped, and NOT numeric.
    parcelTableShapeClasses: new Set(["r-account"]),
  };
  /** The same pair whose parcel table DOES publish the work keys' shape (Hays). */
  const pairSameNumbering = {
    nodeKeyByAccountKey: new Map([
      ["123456", "R005578"],
      ["999888", "R999999"],
    ]),
    sources: ["tx_wcad_owner"],
    parcelTableShapeClasses: new Set(["numeric"]),
  };
  const servedKeyspaces = [
    served(NUMERIC_KEYSPACE_LABEL, NUMERIC_KEYS),
    served(R_KEYSPACE_LABEL, WILLIAMSON_SERVED_KEYS),
  ];

  it("PRE-CHANGE: the bare-key test excludes the WHOLE numeric keyspace and the instrument REFUSES", () => {
    const { excluded, kept, reachedByPublishedPair, declaredNoPublishedIdentifier } =
      partitionAccountKeyedWork(work, parcelIndexKeys);
    expect(excluded.map((w) => w.parcelNodeId)).toEqual([
      "48491:123456",
      "48491:999888",
      "48491:777666",
    ]);
    expect(kept.map((w) => w.parcelNodeId)).toEqual([
      "48491:R005578",
      "48491:R006142",
      "48491:R007323",
    ]);
    expect(reachedByPublishedPair).toBe(0);
    expect(declaredNoPublishedIdentifier).toBe(0);
    const verdict = accountKeyedBlastRadius(excluded, servedKeyspaces);
    expect(verdict.verdict).toBe("refuse");
    expect(verdict.keyspace).toBe(NUMERIC_KEYSPACE_LABEL);
    expect(verdict.reason).toContain("ACCOUNT_KEYED_BLAST_RADIUS");
    // The per-keyspace line, which is the line the dry run prints and the line
    // the close artifact predicts by hand.
    expect(verdict.perKeyspace).toEqual([
      { name: NUMERIC_KEYSPACE_LABEL, served: 3, excluded: 3 },
      { name: R_KEYSPACE_LABEL, served: 3, excluded: 0 },
    ]);
    expect(() => assertAccountKeyedBlastRadius(verdict)).toThrow(
      /ACCOUNT_KEYED_BLAST_RADIUS/,
    );
  });

  it("FIXED: NOTHING of the numeric keyspace is excluded, and the refusal is gone", () => {
    const { kept, excluded, reachedByPublishedPair, declaredNoPublishedIdentifier } =
      partitionAccountKeyedWork(work, parcelIndexKeys, pair);
    // The prediction, asserted before the instrument is consulted: one key the
    // pair names to a prop_id THIS county publishes, and two that no published
    // identifier reaches -- which are DECLARED, not retired, so the exclusion is
    // EMPTY rather than partial. The partial-exclusion alternative (999888 and
    // 777666 retired) is the end state this lane built first and rejected: 37,334
    // of the real 319,480 would have been false retirements, and a partial
    // extraction of a keyspace is invisible to a guard whose contract is set
    // equality.
    expect(reachedByPublishedPair).toBe(1);
    expect(declaredNoPublishedIdentifier).toBe(2);
    expect(excluded).toEqual([]);
    expect(kept.map((w) => w.parcelNodeId)).toEqual([
      "48491:123456",
      "48491:999888",
      "48491:777666",
      "48491:R005578",
      "48491:R006142",
      "48491:R007323",
    ]);
    const verdict = accountKeyedBlastRadius(excluded, servedKeyspaces);
    expect(verdict.verdict).toBe("ok");
    expect(verdict.keyspace).toBeNull();
    expect(verdict.perKeyspace).toEqual([
      { name: NUMERIC_KEYSPACE_LABEL, served: 3, excluded: 0 },
      { name: R_KEYSPACE_LABEL, served: 3, excluded: 0 },
    ]);
    expect(() => assertAccountKeyedBlastRadius(verdict)).not.toThrow();
  });

  it("THE GUARD STILL FIRES, on the code that ships: no pair published leaves the exclusion whole", () => {
    // The dispatched falsifier, kept exactly: a county whose whole keyspace
    // misses the parcel table and which publishes NO pair still has a
    // whole-keyspace exclusion and the guard still throws. (`undefined` -- not an
    // empty map -- is "no pair": see the F8 membership test in the other suite.)
    const { excluded, reachedByPublishedPair, declaredNoPublishedIdentifier } =
      partitionAccountKeyedWork(work, parcelIndexKeys, undefined);
    expect(reachedByPublishedPair).toBe(0);
    expect(declaredNoPublishedIdentifier).toBe(0);
    expect(excluded).toHaveLength(3);
    expect(() => assertAccountKeyedBlastRadius(accountKeyedBlastRadius(excluded, servedKeyspaces))).toThrow(
      /ACCOUNT_KEYED_BLAST_RADIUS/,
    );
    // ...and a pair whose presence the caller has NOT established (the same
    // county with no read at all) is the same case. What is NOT the same case,
    // and must not be confused with it: a pair the county DOES publish whose
    // every row names an unpublished prop_id -- that is the county speaking, and
    // its keys are DECLARED rather than retired, which is asserted in the suite
    // that owns the membership rule.
  });

  it("HAYS IS UNCHANGED KEY FOR KEY: the same key shapes, the same hollow set, a parcel table that uses their numbering", () => {
    const haysWork = HAYS_SERVED_KEYS.map((k) => ({
      parcelNodeId: `48209:${k}`,
      body: {},
    }));
    const haysParcelIndex = new Set(["100013", "100014"]);
    const golden = ["48209:100015", "48209:100016", "48209:100017"];
    for (const publishedPair of [undefined, pairSameNumbering]) {
      const { excluded, reachedByPublishedPair, declaredNoPublishedIdentifier } =
        partitionAccountKeyedWork(haysWork, haysParcelIndex, publishedPair);
      expect(excluded.map((w) => w.parcelNodeId)).toEqual(golden);
      // Nothing was declared and nothing was reached: the second published
      // identifier is inert in a county whose parcel table speaks its own keys'
      // numbering, whether or not an extract happens to name one of them.
      expect(reachedByPublishedPair).toBe(0);
      expect(declaredNoPublishedIdentifier).toBe(0);
      // The hollow subset of ONE keyspace is the pass's premise, not a blast
      // radius -- the same verdict F6 measures, taken through the new path.
      const verdict = accountKeyedBlastRadius(excluded, [
        served("numeric keys", HAYS_SERVED_KEYS),
      ]);
      expect(verdict.verdict).toBe("ok");
    }
  });

  it("the REVERSE pair refuses a key two extracts disagree about rather than moving it on a toss", () => {
    const { byAccountKey, refusedDisagreement } = buildPublishedNodeKeyByAccountKey([
      [{ accountKey: "123456", nodeKey: "R005578", source: "tx_wcad_owner" }],
      [{ accountKey: "123456", nodeKey: "R007323", source: "tx_wcad_ag_valuation" }],
    ]);
    expect(byAccountKey.size).toBe(0);
    expect(refusedDisagreement).toBe(1);
    // An account an extract carried with NO node key is counted, never assumed
    // onto some parcel -- and an extract naming one account twice with two node
    // keys is refused as ambiguous, as the forward builder already does.
    const none = buildPublishedNodeKeyByAccountKey([
      [{ accountKey: "123456", nodeKey: "", source: "tx_wcad_owner" }],
    ]);
    expect(none.byAccountKey.size).toBe(0);
    expect(none.refusedNoNodeKey).toBe(1);
    const ambiguous = buildPublishedNodeKeyByAccountKey([
      [
        { accountKey: "123456", nodeKey: "R005578", source: "tx_wcad_owner" },
        { accountKey: "123456", nodeKey: "R007323", source: "tx_wcad_owner" },
      ],
    ]);
    expect(ambiguous.byAccountKey.size).toBe(0);
    expect(ambiguous.refusedAmbiguous).toBe(1);
  });

  it("the reverse builder reads the SAME pair the forward one does, with the roles swapped", () => {
    const rows: PublishedAccountPairRow[] = [
      { nodeKey: "R005578", accountKey: "123456", source: "tx_wcad_owner" },
      { nodeKey: "R006142", accountKey: "654321", source: "tx_wcad_owner" },
    ];
    const forward = buildPublishedAccountPair([rows]);
    const reverse = buildPublishedNodeKeyByAccountKey([
      rows.map((r) => ({ accountKey: r.accountKey, nodeKey: r.nodeKey, source: r.source })),
    ]);
    // The forward builder answers nodeKey -> accountKey; the reverse one answers
    // accountKey -> nodeKey over the SAME rows, so it is the inverse and not a
    // second opinion: neither can name a key the other refuses.
    const inverted = new Map([...forward.pairByNodeKey].map(([node, account]) => [account, node]));
    expect([...reverse.byAccountKey]).toEqual([...inverted]);
    expect(reverse.sources).toEqual(forward.sources);
  });
});
