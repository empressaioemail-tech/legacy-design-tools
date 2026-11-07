/**
 * P-351 (2026-09-18). THE FIXTURES THE RETIREMENT RESOLUTION IS PROVEN ON.
 *
 * Every one of these is a shape MEASURED on production 2026-09-18, not invented:
 * the Hays keys are R-account numbers with the prefix the source already
 * stripped, the colliding account is a real prop_id that sits at the same bare
 * number the node's key carries, and Williamson's pair is the county's own
 * published `prop_id` -> `wcad_property_id` row. The numbers themselves are
 * synthetic (`100013` and not a real Hays key) so no fixture can be mistaken
 * for a claim about a named parcel; the SHAPES are not synthetic and that is
 * the whole point of keeping them here rather than inline in a test.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than literals in the test. The falsifier
 * is "on the pre-change code this fixture retires wrongly". A fixture that
 * changed shape while being tuned until the test passed would make that claim
 * unfalsifiable, so the data sits in one place with the production shape it
 * mirrors written beside it, and the test only reads it.
 */

/** One declared-vintage `cad_property` row, in the columns the resolution reads. */
export interface CadRollRowFixture {
  propId: string;
  taxYear: number;
  /** The county's Geographic ID. The crosswalk join key. Null when not published. */
  propertyNumber: string | null;
  /** The CAD account number, e.g. Hays' `R100013`. Null when the county publishes none. */
  quickRefId: string | null;
  marketValue: number | null;
  situsAddress: string | null;
}

/**
 * HAYS 48209 -- the two-keyspace county whose served keys are the county's
 * published account numbers and whose roll is keyed by the CAD's own
 * PropertyID. Four rows, one per node below:
 *
 *   120302   the account behind node 100013 (register `R100013`)
 *   100013   the UNRELATED account that sits at node 100013's bare number --
 *            the collision P-177 measured and this row's dollar question asks
 *            about. Note its own property_number is a different parcel.
 *   130637   the account behind node 100014, present at the PRIOR vintage only
 *   140740   the account behind node 100016, live, reached by the geo bind
 */
export const HAYS_ROLL_2026: readonly CadRollRowFixture[] = [
  {
    propId: "120302",
    taxYear: 2026,
    propertyNumber: "GEO-100013",
    quickRefId: "R100013",
    marketValue: 425000,
    situsAddress: "100 RIVER RD, DRIPPING SPRINGS, TX 78620",
  },
  {
    propId: "100013",
    taxYear: 2026,
    propertyNumber: "GEO-999999",
    quickRefId: "P120302",
    marketValue: 9382,
    situsAddress: "9999 OTHER RD, KYLE, TX 78640",
  },
  {
    propId: "140740",
    taxYear: 2026,
    propertyNumber: "GEO-100016",
    quickRefId: "R100016",
    marketValue: 512000,
    situsAddress: "16 CREEK BEND, BUDA, TX 78610",
  },
  {
    propId: "150939",
    taxYear: 2026,
    propertyNumber: "GEO-100017",
    quickRefId: "R100017",
    marketValue: 275000,
    situsAddress: "17 MESA VERDE, KYLE, TX 78640",
  },
];

/**
 * HAYS 48209 at the PRIOR declared vintage (2025). Carries ONLY what the
 * identity read needs, because that is all `fetchPriorVintageQuickRefRegister`
 * selects: the account leaving the roll is `R100014` -> prop_id `130637`, and
 * it is NOT in the 2026 roll above. That absence is the county's real
 * retirement signal and is the only way this county can name an account that
 * has left.
 */
export const HAYS_ROLL_2025: readonly CadRollRowFixture[] = [
  {
    propId: "130637",
    taxYear: 2025,
    propertyNumber: "GEO-100014",
    quickRefId: "R100014",
    marketValue: 476980,
    situsAddress: "14 OAK HOLLOW, DRIPPING SPRINGS, TX 78620",
  },
  {
    propId: "140740",
    taxYear: 2025,
    propertyNumber: "GEO-100016",
    quickRefId: "R100016",
    marketValue: 498000,
    situsAddress: "16 CREEK BEND, BUDA, TX 78610",
  },
];

/**
 * The node's own published identifiers, per served key. `geoId` is the
 * `txgio_parcel.geo_id` the parcel index publishes for the node itself; null
 * means the node carries none (78 of Hays' 1,386 do, measured 2026-09-18).
 */
export const HAYS_NODE_GEO_IDS: ReadonlyMap<string, string | null> = new Map([
  // THE 810 CLASS (2026-09-18): the node carries NO geo_id, so nothing on the
  // node's own side can contradict the account its own number names. Its bare
  // key 100013 is ALSO a real, unrelated roll prop_id carrying 9,382 -- the
  // collision P-177 measured -- which is what the pre-change code read.
  ["100013", null],
  // The account left the roll: nothing on the declared roll names it, and only
  // the PRIOR vintage can.
  ["100014", "GEO-100014"],
  // Nothing names an account for this one at all.
  ["100015", null],
  // The ordinary live case the geo bind handles.
  ["100016", "GEO-100016"],
  // THE 232 CLASS: the node's own published geo_id names a DIFFERENT parcel
  // than the account its own number names. Two published identifiers
  // disagreeing; the row refuses the bind rather than picking a winner.
  ["100017", "GEO-ANOTHER-PARCEL"],
]);

/** The tax year the Hays declaration is read at, and the prior vintage beside it. */
export const HAYS_DECLARED_TAX_YEAR = 2026;
export const HAYS_PRIOR_TAX_YEAR = 2025;

/**
 * WILLIAMSON 48491 -- the county that publishes NO account numbers: both
 * extracts carry ZERO non-blank `quick_ref_id` on either vintage (measured
 * 2026-09-18), so the register paths cannot fire at all and the county's own
 * staged pair is the only identifier that relates its served R keys to its
 * numeric accounts.
 *
 * `R005578` is reached by the pair and its account is LIVE on the declared
 * roll -- the 282,146-node case. `R006142` is one of the 424 the pair does not
 * reach (a real key measured unreachable on production).
 */
export const WILLIAMSON_ACCOUNT_PAIR: readonly {
  nodeKey: string;
  accountKey: string;
  source: string;
}[] = [
  { nodeKey: "R005578", accountKey: "123456", source: "tx_wcad_owner" },
  // The second extract names the SAME account for the same key. Both extracts
  // agree on all 287,321 keys they share on production, and this is that case.
  { nodeKey: "R005578", accountKey: "123456", source: "tx_wcad_ag_valuation" },
];

export const WILLIAMSON_ROLL_2026: readonly CadRollRowFixture[] = [
  {
    propId: "123456",
    taxYear: 2026,
    propertyNumber: null,
    quickRefId: null,
    marketValue: 318400,
    situsAddress: "578 PRIVATE RD, GEORGETOWN, TX 78628",
  },
];

/** The keyspace labels `describeRetirementKeyspaces(true)` produces, named once. */
export const TWO_KEYSPACE_LABELS = {
  nodeKeyspace:
    "the county's published parcel index (txgio_parcel.prop_id) -- the served node key",
  rollKeyspace:
    "the county's CAD roll prop_id (cad_property.prop_id, the county's own PropertyID)",
} as const;

/** The node keys the writer-(b) instrument is measured on. */
export const HAYS_SERVED_KEYS = ["100013", "100014", "100015", "100016", "100017"] as const;
export const WILLIAMSON_SERVED_KEYS = ["R005578", "R006142", "R007323"] as const;

/** Every Hays roll row, both vintages, as the CLI's `cadPropertyRoll` map. */
export function haysRollByPropId(
  rows: readonly CadRollRowFixture[],
): Map<string, CadRollRowFixture> {
  return new Map(rows.map((r) => [r.propId, r]));
}

/**
 * The indexes the CLI builds from the roll rows it ALREADY loaded -- the same
 * read that feeds the dollars, so the resolution and the facts cannot disagree
 * about which row is which. Built here the same way the CLI builds them, so a
 * test cannot prove a rule the caller does not implement.
 */
export function registerIndexes(
  rows: readonly CadRollRowFixture[],
): {
  registerPropIdByQuickRefId: Map<string, string>;
  refusedRegisterKeys: Set<string>;
  propertyNumberByAccountPropId: Map<string, string>;
} {
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
