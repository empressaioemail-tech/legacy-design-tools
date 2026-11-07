/**
 * P-180 (2026-09-13). DURABLE RETIREMENT OF THE HOLLOW ACCOUNT-KEYED NODES.
 *
 * For a gate-blocked county the `atoms` table carries BOTH the canonical
 * TxGIO-keyed node (the parcel with geometry and cells, e.g. 48209:97658) AND
 * account-keyed atoms minted from the CAD roll's own `PropertyID` (e.g.
 * 48209:84639, 84632-84638). The latter are HOLLOW: no `txgio_parcel` row
 * publishes that prop_id, so the node has no geometry and serves a card that
 * describes an ACCOUNT, not the parcel. P-177 retired five of them with a
 * snapshot marker, but that marker is not durable -- the tier-1 bake re-mints
 * one work item per CAD atom on every republish, overwriting it.
 *
 * The durable half is to DROP them before any prepass or write: for a
 * gate-blocked county a work item whose prop_id is not a TxGIO node id is
 * account-keyed. Measured live (2026-09-14, production, read-only):
 * 84639/84632/84633/84634/84638 have zero `txgio_parcel` rows for 48209 while
 * 97658 has one, so the rule excludes exactly the hollow set and keeps every
 * real node.
 *
 * A non-blocked county never calls this: there the bare prop_id IS the CAD
 * account id and every atom key is a real node key.
 *
 * ---------------------------------------------------------------------------
 * P-180 WAVE 6 (2026-09-14, operator ruling A-146 option B). THE EXCLUSION
 * ALONE BROKE THE PUBLISH WALK, so the exclusion is now paired with a
 * RETIREMENT PASS.
 *
 * A node dropped from the work list is never rewritten, so it keeps the
 * PREVIOUS run's `publishRunId` forever. The factory's verify-walk
 * (`hauska-factory src/jobs/verify-walk.mjs`) requires the CURRENT publish run
 * id on EVERY parcel it sweeps -- and it requires it on an earned retirement
 * too, before returning `RECORD_RETIRED` (`gradeParcelResponse`: the
 * `recordRetirement` branch checks `responseCarriesPublishRunId` first). The
 * street sweep samples whatever shares a street with the anchors, and hollow
 * nodes share streets with real ones, so a Hays republish ALWAYS fails
 * `BP-PUBLISH-RUN-01` on some excluded node. Measured: run
 * `factory-bastrop-publish-fwv5s` failed on 48209:84629..84639.
 *
 * Both invariants stay. The fact build still excludes the hollow nodes (they
 * are not parcels and must not be re-minted with account facts); the bake then
 * RETIRES every excluded node with the CURRENT run id in a cheap pass, writing
 * a retirement record and NO facts. The stamp the walk wants then exists on
 * exactly the population the walk can sweep.
 *
 * The mission's own falsifier for this pass is "if any excluded node serves
 * facts after step 3, the pass wrote more than a retirement" -- which is why
 * the payload below carries identity, access, the run stamp and the earned
 * retirement, and deliberately no `baseFacts` / `zoning` / `envelope` /
 * `acreage` / `landUse` value. It is a retirement, not a bake.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * P-370 (2026-09-19). THE MEMBERSHIP TEST ASKS THE NODE'S OWN KEYSPACE.
 *
 * P-180's rule reads "a work item whose prop_id is not a `txgio_parcel` prop_id
 * is account-keyed". That sentence is only true of a county with ONE numbering
 * system. Measure it on Williamson 48491 (staging, read-only, 2026-09-19): the
 * parcel table holds 304,162 R-prefixed prop_ids and ZERO numeric ones, while
 * the bake's work list carries the 319,480 numeric keys the declared roll is
 * keyed by. So the bare-key test calls every one of them account-keyed, the
 * excluded set IS the whole numeric served keyspace, and P-351's blast-radius
 * refusal fires -- refusing the run instead of emptying the county, which is
 * how the 2026-09-17 write that retired 319,480 live rows was caught, and also
 * why the county cannot publish at all.
 *
 * THE THIRD VERDICT IS A DECLARATION, NOT A RETIREMENT. The dispatch's own
 * sentence is "a node the pair maps to a published parcel is not hollow; a node
 * no published identifier reaches is DECLARED (not retired, not excluded as
 * hollow)". Read with its neighbours that can only mean: in a county that
 * PUBLISHES a pair over this run's account-shaped keys, the bare-key comparison
 * is not admissible evidence of hollowness for those keys at all. A key the
 * pair names to a prop_id this county's parcel table publishes is a served
 * parcel (kept, counted); a key it does not name is KEPT AND DECLARED, with the
 * declaration made by the arm that already declares a node whose account cannot
 * be resolved (writer (a)'s `retirementResolution`, P-351). Nothing in that
 * keyspace is retired on a comparison between two numbering systems.
 *
 * WHY THE LOUDER-LOOKING ALTERNATIVE IS THE WRONG ONE, measured rather than
 * argued. An arm that only MOVES REACHED KEYS BACK leaves the keys the pair
 * does not reach excluded, i.e. retired: 319,480 excluded by the bare test,
 * 282,146 moved back, 37,334 STILL RETIRED -- and 37,334 is 11.7% of a
 * keyspace whose every key P-327 measured present on the declared 2026 roll,
 * so the run would write 37,334 false retirements while P-351's guard, which is
 * SET EQUALITY against a whole keyspace, cannot see it and cannot fire. A
 * narrower version of the same defect. The shipped rule retires nothing on a
 * comparison the county's own published identifiers cannot settle.
 *
 * THE COUNTY SCOPING IS THE TEST, not a filter someone remembered to add. The
 * staged extracts carry no county column, so a lookup by account number alone
 * can MATCH ANOTHER COUNTY'S PARCEL. The second identifier is therefore scoped
 * by `txgioPropIds` -- THIS county's parcel table -- so a key whose paired
 * prop_id this county does not publish is not reached by it, whatever the
 * extract said. Measured: no Hays 48209 key is named by the pair to a key
 * Hays' parcel table publishes, so Hays' hollow set is unchanged key for key.
 *
 * ABSENT, THIS IS THE OLD TEST EXACTLY. A county that publishes no pair, and
 * every caller written before P-370, passes nothing and gets the pre-P-370
 * verdict -- which is what keeps Hays' measured shape behaving exactly as it
 * did.
 * ---------------------------------------------------------------------------
 */

import { nodeKeyShapeClass } from "./retirementAccountResolution";

/** The subject a work item carries: the atom body and the node id derived from it. */
export interface AccountKeyedWorkItem {
  body: Record<string, unknown>;
  parcelNodeId: string;
}

/**
 * P-370 (2026-09-19). THE COUNTY'S OWN PUBLISHED PAIR, READ BY THE ACCOUNT.
 *
 * The subject is the map `buildPublishedNodeKeyByAccountKey` returns: account
 * key -> the ONE parcel-index prop_id the county's extracts name for it, for
 * `tx_wcad_owner` / `tx_wcad_ag_valuation` the numeric account the declared
 * roll is keyed by against the R prop_id the parcel index publishes.
 *
 * PRESENCE IS THE TRIGGER, and it is deliberately not inferable from the map's
 * size. NON-NULL means "this county publishes a pair over this run's
 * account-shaped keys: the read returned at least one row naming one of them",
 * which is exactly when the dispatch's third verdict applies. A county whose
 * read returned nothing for its keys passes NOTHING -- not an empty map -- and
 * gets the pre-P-370 verdict, which is what keeps a county whose published pair
 * is silent byte-identical to before. `sources` names every extract that
 * contributed so a declaration can say which identifiers were searched.
 */
export interface PublishedPairMembership {
  /** account key -> the ONE parcel-index prop_id the extracts name for it. */
  readonly nodeKeyByAccountKey: ReadonlyMap<string, string>;
  /** Every extract that contributed, named. */
  readonly sources: readonly string[];
  /**
   * THE SECOND FACT, WITHOUT WHICH THE FIRST IS DANGEROUS: the key SHAPE CLASSES
   * the parcel table's own prop_id column publishes, measured on the rows this
   * run just read (`nodeKeyShapeClass` over `txgioPropIds`).
   *
   * A key whose own shape class is NOT among them belongs to a numbering this
   * table does not use, so its absence from the table is not evidence of
   * hollowness. This is what keeps a CROSS-COUNTY pair row from disarming a
   * county whose parcel table DOES use the key's numbering: the staged extracts
   * carry no county column, so an account number in one county can match a
   * parcel in another, and without this fact Hays -- parcel table numeric, work
   * keys numeric, and a pair row that happens to name one of its keys to a
   * Williamson prop_id -- would have its whole hollow set declared instead of
   * retired. Measured 2026-09-19: Williamson's parcel table publishes 304,162
   * r-account-shaped keys and ZERO numeric ones; Hays' publishes numeric keys.
   */
  readonly parcelTableShapeClasses: ReadonlySet<string>;
}

/**
 * P-370. THE FOUR OUTCOMES, each named so a caller cannot read one as another.
 * The first three are KEPT IN THE FACT BUILD; only the last is excluded.
 */
export type AccountKeyedMembershipVerdict =
  /** The parcel table publishes this key in its own numbering. Kept. */
  | "published-parcel-node"
  /** The county's published pair names it to a prop_id the parcel table publishes. Kept. */
  | "reached-by-published-pair"
  /**
   * The county publishes a pair over this run's account-shaped keys and it does
   * NOT name this one. Kept, and its absence of an account is DECLARED rather
   * than retired: the comparison the bare-key test makes is between two
   * numbering systems, and a declaration beats a false absence.
   */
  | "declared-no-published-identifier"
  /** No pair published for this county: the pre-P-370 verdict. Excluded. */
  | "hollow-account-keyed";

/**
 * P-370 (2026-09-19). THE MEMBERSHIP TEST ASKS THE NODE'S OWN KEYSPACE.
 *
 * THE DEFECT THIS CLOSES. The test was "is this key a `txgio_parcel` prop_id".
 * That is the right question for a county whose served keys ARE the parcel
 * table's keys, and it is the wrong question for a county that publishes TWO
 * numbering systems for one parcel: there a key can be absent from the parcel
 * table and still be a node with a published parcel, because the parcel table
 * is keyed by the county's OTHER number. Measured on staging 2026-09-19
 * (read-only): Williamson 48491's parcel table holds 304,162 R-prefixed
 * prop_ids and ZERO numeric ones, while the bake's work list carries 319,480
 * numeric declared-roll keys, of which 282,146 are named by the county's own
 * published pair to an R prop_id the parcel table DOES publish. On the bare-key
 * test every one of the 319,480 is "account-keyed", the exclusion IS the whole
 * numeric served keyspace, and writer (b)'s blast-radius refusal (P-351) fires
 * -- which is how the whole-keyspace write that emptied 319,480 live rows on
 * 2026-09-17 (P-327's F5) was caught, and also why Williamson cannot publish.
 *
 * WHAT THE SECOND IDENTIFIER IS, exactly. `publishedPair` is the county's OWN
 * pair, read in the ACCOUNT direction for exactly the keys this run holds. A
 * key it names whose named node key IS in `txgioPropIds` is a key a published
 * identifier reaches a PUBLISHED parcel through, so it is not hollow -- that is
 * the node's own keyspace being read through the county's own pair instead of
 * through a table in the other numbering system. A key it does not name is
 * DECLARED, not retired (see the file header for why that is the dispatch's
 * sentence and why the alternative writes false retirements).
 */
export function accountKeyedMembershipVerdict(
  propId: string,
  txgioPropIds: ReadonlySet<string>,
  publishedPair?: PublishedPairMembership | null,
): AccountKeyedMembershipVerdict {
  const id = propId.trim();
  // An unparseable id is not a key at all. It keeps the pre-P-370 verdict
  // (kept): excluding on an id the pass never read is how a pass drops a row it
  // cannot account for.
  if (id === "") return "published-parcel-node";
  if (txgioPropIds.has(id)) return "published-parcel-node";
  if (publishedPair != null) {
    const pairedNodeKey = publishedPair.nodeKeyByAccountKey.get(id) ?? null;
    if (pairedNodeKey != null && txgioPropIds.has(pairedNodeKey)) {
      return "reached-by-published-pair";
    }
    // THE DECLARATION RESTS ON TWO FACTS AND BOTH MUST HOLD. (1) the county
    // publishes a pair over this run's keys -- `publishedPair` is present; and
    // (2) the parcel table does not use THIS key's numbering at all, measured on
    // the table's own keys. Either alone is not enough, and each has its own
    // measured failure: the pair alone lets a cross-county pair row turn a
    // county whose parcel table DOES use this numbering (Hays) into a county
    // that declares its whole hollow set; the shape alone would stop a county
    // with a disjoint numbering from retiring anything, with no published
    // identifier taking the retirement's place -- a silent gap rather than a
    // declared one.
    if (!publishedPair.parcelTableShapeClasses.has(nodeKeyShapeClass(id))) {
      return "declared-no-published-identifier";
    }
  }
  return "hollow-account-keyed";
}

/**
 * `true` when the key would be EXCLUDED as an account-keyed hollow node. Kept
 * as the predicate every guard and caller written before P-370 already reads,
 * now answered by the verdict above so there is one rule and not two.
 */
export function isAccountKeyedNodeId(
  propId: string,
  txgioPropIds: ReadonlySet<string>,
  publishedPair?: PublishedPairMembership | null,
): boolean {
  return accountKeyedMembershipVerdict(propId, txgioPropIds, publishedPair) ===
    "hollow-account-keyed";
}

/**
 * Split a bake work list into the nodes the fact build owns and the hollow
 * account-keyed nodes it must not build. Pure; the CLI owns the TxGIO index
 * read. One implementation, so the fact build and the retirement pass can
 * never disagree about which population was excluded.
 */
export function partitionAccountKeyedWork<T extends { parcelNodeId: string }>(
  work: readonly T[],
  txgioPropIds: ReadonlySet<string>,
  publishedPair?: PublishedPairMembership | null,
): {
  kept: T[];
  excluded: T[];
  reachedByPublishedPair: number;
  declaredNoPublishedIdentifier: number;
} {
  const kept: T[] = [];
  const excluded: T[] = [];
  /**
   * P-370. Counted, not inferred: the keys the county's published pair moved
   * back into the fact build. A run that reports 0 here on a two-keyspace
   * county is the run in which the new identifier did nothing, and it must be
   * legible from outside rather than discovered from a refusal.
   */
  let reachedByPublishedPair = 0;
  /**
   * P-370. And the keys that are KEPT AND DECLARED rather than excluded -- the
   * population the dispatch's third case is about. Counted for the same reason,
   * and counted SEPARATELY: a declaration is not a retirement with softer
   * wording, and a run whose declaration count is not visible cannot be
   * distinguished from a run that retired them.
   */
  let declaredNoPublishedIdentifier = 0;
  for (const item of work) {
    const propId = item.parcelNodeId.split(":")[1] ?? "";
    const verdict = accountKeyedMembershipVerdict(propId, txgioPropIds, publishedPair);
    if (verdict === "hollow-account-keyed") {
      excluded.push(item);
      continue;
    }
    if (verdict === "reached-by-published-pair") reachedByPublishedPair += 1;
    else if (verdict === "declared-no-published-identifier") {
      declaredNoPublishedIdentifier += 1;
    }
    kept.push(item);
  }
  return { kept, excluded, reachedByPublishedPair, declaredNoPublishedIdentifier };
}

/** The node's own bare prop_id (the part of the node id after the colon). */
export function accountKeyedWorkPropId(parcelNodeId: string): string {
  return parcelNodeId.split(":")[1] ?? "";
}

/**
 * P-351 (2026-09-18). WRITER (b)'s BLAST-RADIUS INSTRUMENT.
 *
 * WHY WRITER (b) NEEDS ONE AND WRITER (a) DOES NOT. P-327 measured that the
 * pre-bake gate (`requireRetirementGate` in `runBastropPublish`) cannot reach
 * this pass -- the pass runs INSIDE the bake, after promotion, and any bake run
 * outside that job bypasses the gate entirely. So the pass is the only
 * destructive write in the bake with no reachable refusal in front of it, and
 * the program trap is blunt about the class: "No writer in this program refuses
 * on blast radius yet (P-320). Two counties have now been emptied by
 * presence-shaped comparisons ... treat every destructive status write as
 * unguarded and measure its population before running it."
 *
 * THE SHAPE THE DISPATCH ASKS FOR, and why this one. The pass's premise is
 * "a work id missing from the parcel table is an account-keyed HOLLOW node".
 * That premise is measured on Hays' five hollow atoms and is FALSE for a county
 * whose SERVED keyspace is not the parcel table's keyspace: there, the excluded
 * set can be a whole served keyspace rather than a hollow fringe. So the
 * instrument measures the excluded set against the served keyspaces the caller
 * read, and refuses when the excluded set IS one of them.
 *
 * IT IS NOT A SHARE THRESHOLD, deliberately. A percentage would have to be
 * tuned, and a tuned number is the thing the program's one declared number
 * (MAX_DESTRUCTIVE_SHARE) exists to prevent a second of. Set equality has no
 * constant to argue with: a keyspace whose every member was excluded is a
 * keyspace being emptied, at any size, and a keyspace with one member left is
 * not.
 *
 * WHAT IT DOES NOT GUARD, stated here rather than discovered later: writer (a).
 * The Williamson emptying was writer (a)'s -- its excluded set there was EMPTY,
 * because every removed node was present in the parcel table. Writer (a)'s
 * guard is the retirement resolution itself (a record whose account cannot be
 * named is not retired), which is a different instrument in a different file.
 * Claiming this one covers both is exactly the "a control that measures one
 * thing does not protect the thing beside it" failure the program trap names.
 */
export interface ServedKeyspace {
  /**
   * The keyspace's name, as the caller read it off the served store. Two
   * keyspaces in one county must be named two different things, or the refusal
   * cannot say which one is being emptied.
   */
  name: string;
  /** Every served node key in it. */
  keys: ReadonlySet<string>;
}

export interface AccountKeyedBlastRadiusVerdict {
  verdict: "ok" | "refuse";
  /** Non-null exactly when `verdict` is `refuse`: the keyspace being emptied. */
  keyspace: string | null;
  /** The population the pass is about to retire. */
  excludedCount: number;
  /** Non-null exactly when `verdict` is `refuse`. */
  reason: string | null;
  /** Every keyspace measured, so a clean run is as legible as a refusal. */
  perKeyspace: readonly { name: string; served: number; excluded: number }[];
}

/**
 * Measure the excluded set against the served keyspaces. Pure, so the refusal
 * can be proven by fixture in both directions.
 *
 * REFUSES when a keyspace has at least one served member and EVERY one of them
 * is in the excluded set. An empty served keyspace is not refused (there is
 * nothing to empty), and a keyspace with a surviving member is not refused --
 * Hays' own measured shape (56,629 hollow atoms beside 116,421 live ones, in
 * one keyspace) passes.
 */
export function accountKeyedBlastRadius(
  excluded: readonly { parcelNodeId: string }[],
  servedKeyspaces: readonly ServedKeyspace[],
): AccountKeyedBlastRadiusVerdict {
  const excludedKeys = new Set<string>();
  for (const item of excluded) {
    const key = accountKeyedWorkPropId(item.parcelNodeId).trim();
    if (key !== "") excludedKeys.add(key);
  }
  const perKeyspace: { name: string; served: number; excluded: number }[] = [];
  let refused: string | null = null;
  for (const space of servedKeyspaces) {
    const servedKeys = new Set<string>();
    for (const k of space.keys) {
      const key = k.trim();
      if (key !== "") servedKeys.add(key);
    }
    let hit = 0;
    for (const key of servedKeys) if (excludedKeys.has(key)) hit += 1;
    perKeyspace.push({ name: space.name, served: servedKeys.size, excluded: hit });
    if (refused == null && servedKeys.size > 0 && hit === servedKeys.size) {
      refused = space.name;
    }
  }
  if (refused == null) {
    return {
      verdict: "ok",
      keyspace: null,
      excludedCount: excludedKeys.size,
      reason: null,
      perKeyspace,
    };
  }
  const measured = perKeyspace.find((k) => k.name === refused);
  return {
    verdict: "refuse",
    keyspace: refused,
    excludedCount: excludedKeys.size,
    reason:
      `ACCOUNT_KEYED_BLAST_RADIUS: the work excluded from the fact build IS the whole served ` +
      `keyspace "${refused}" (${measured?.excluded ?? 0} of ${measured?.served ?? 0} served keys ` +
      `excluded): the pass would retire an entire served keyspace rather than the hollow ` +
      `account-keyed fringe it was written for. The exclusion's premise -- a work id missing ` +
      `from the parcel table is an account-keyed HOLLOW node -- is measured on Hays' five hollow ` +
      `atoms and is false for a county whose served keyspace is not the parcel table's keyspace. ` +
      `Refusing the run; nothing was written.`,
    perKeyspace,
  };
}

/** The refusal, as the throw the CLI takes. Never swallowed by the caller. */
export function assertAccountKeyedBlastRadius(
  verdict: AccountKeyedBlastRadiusVerdict,
): void {
  if (verdict.verdict === "refuse") {
    throw new Error(verdict.reason ?? "ACCOUNT_KEYED_BLAST_RADIUS");
  }
}

/** A RECORD-LEVEL retirement declaration. Same shape every retirement consumer reads. */
export interface AccountKeyedRetirementRecord {
  status: "retired";
  verdict: "absent-verified";
  authority: string;
  scopeSearched: string;
  asOf: string;
  basis: string;
  lastSeenTaxYear: number | null;
}

export interface AccountKeyedRetirementInput {
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  /** The node's own bare prop_id (the part of the node id after the colon). */
  propId: string;
  facetSchemaVersion: string;
  shapeSource: string;
  source: string;
  access: { discoverability: string; entitlement: string };
  accessNormalizedFrom?: string | null;
  publishRunId?: string | undefined;
  asOf: string;
  lastSeenTaxYear: number | null;
}

export interface AccountKeyedRetirementPayload {
  facetSchemaVersion: string;
  tier: 1;
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  shapeSource: string;
  baked: true;
  source: string;
  access: { discoverability: string; entitlement: string };
  accessNormalizedFrom?: string;
  publishRunId?: string;
  recordRetirement: AccountKeyedRetirementRecord;
  facets: { base: { parcelNodeId: string; situsAddress: null; apn: string } };
  facetCoverage: {
    tier1: "populated";
    baseFacts: false;
    landUse: false;
    acreage: false;
    zoning: false;
    envelope: false;
  };
  provenance: { tierNote: string; roadsPending: true };
  bakedAt: string;
}

/** Fact-shaped keys a retirement payload must never carry. Named, so a test can assert on them. */
export const ACCOUNT_KEYED_RETIREMENT_FORBIDDEN_FACT_KEYS: readonly string[] = [
  "baseFacts",
  "zoning",
  "envelope",
  "acreage",
  "landUse",
  "cadRoll",
  "structuralFact",
];

/**
 * Build the retirement record for one excluded node. Pure: the CLI supplies
 * the run stamp, the clock and the claim's own last-seen tax year.
 *
 * The basis NAMES the node and the account, so two parcels never share a
 * character-identical basis -- the same rule every earned absence in this bake
 * follows. It says exactly what was searched (the county's published parcel
 * index) and what was found (no row for this prop_id), which is the positive
 * determination that makes the absence earned rather than a silent miss.
 */
export function buildAccountKeyedRetirementRecord(
  input: Pick<
    AccountKeyedRetirementInput,
    "parcelNodeId" | "countyFips" | "countyName" | "propId" | "asOf" | "lastSeenTaxYear"
  >,
): AccountKeyedRetirementRecord {
  const { parcelNodeId, countyFips, countyName, propId, asOf, lastSeenTaxYear } = input;
  // P-370 (2026-09-19). UNCHANGED, deliberately. A record here is only written
  // for a key the membership test called HOLLOW, and after P-370 that verdict is
  // reachable only for a county that publishes NO pair over this run's
  // account-shaped keys -- i.e. exactly the counties whose records were already
  // right. The third verdict (a key a county's own pair does not reach) is KEPT
  // AND DECLARED and never reaches this function, so nothing on the retirement
  // path had to change for it: widening this text would have described a
  // declaration with the wording of a retirement.
  return {
    status: "retired",
    verdict: "absent-verified",
    authority: `${countyName} County GIS published parcel index (txgio_parcel) for county_fips ${countyFips}`,
    scopeSearched: `txgio_parcel (the county's published parcel index), county_fips ${countyFips}, prop_id = ${propId}`,
    asOf,
    basis:
      `${parcelNodeId}: prop_id ${propId} carries no row in the ${countyName} County ` +
      `published parcel index (txgio_parcel) for county_fips ${countyFips}, so this node is ` +
      `ACCOUNT-KEYED, not a parcel node: it has no published geometry and no parcel facts` +
      (lastSeenTaxYear != null
        ? `; its own claim last carried tax_year ${lastSeenTaxYear}`
        : "") +
      `. Retired by the tier-1 bake's account-keyed exclusion (P-180); no facts are served for it.`,
    lastSeenTaxYear,
  };
}

/**
 * The retirement payload the bake writes for an excluded node: identity, the
 * canonical access pair, the CURRENT run stamp and the earned retirement --
 * and no facts.
 */
export function buildAccountKeyedRetirementPayload(
  input: AccountKeyedRetirementInput,
): AccountKeyedRetirementPayload {
  const {
    parcelNodeId,
    countyFips,
    countyName,
    propId,
    facetSchemaVersion,
    shapeSource,
    source,
    access,
    accessNormalizedFrom,
    publishRunId,
    asOf,
    lastSeenTaxYear,
  } = input;
  return {
    facetSchemaVersion,
    tier: 1,
    parcelNodeId,
    countyFips,
    countyName,
    shapeSource,
    baked: true,
    source,
    access,
    ...(accessNormalizedFrom ? { accessNormalizedFrom } : {}),
    ...(publishRunId ? { publishRunId } : {}),
    recordRetirement: buildAccountKeyedRetirementRecord({
      parcelNodeId,
      countyFips,
      countyName,
      propId,
      asOf,
      lastSeenTaxYear,
    }),
    facets: {
      base: { parcelNodeId, situsAddress: null, apn: propId },
    },
    facetCoverage: {
      tier1: "populated",
      baseFacts: false,
      landUse: false,
      acreage: false,
      zoning: false,
      envelope: false,
    },
    provenance: {
      tierNote:
        "retired: this node is account-keyed (no published TxGIO parcel for its prop_id), " +
        "so the tier-1 bake builds no facts for it",
      roadsPending: true,
    },
    bakedAt: asOf,
  };
}

/** A normalizable access pair, or the refusal the fact build also takes. */
export type AccountKeyedAccessResolution =
  | {
      ok: true;
      access: { discoverability: string; entitlement: string };
      accessNormalizedFrom: string | null;
    }
  | { ok: false };

export interface AccountKeyedRetirementPlanInput {
  excluded: readonly AccountKeyedWorkItem[];
  countyFips: string;
  countyName: string;
  facetSchemaVersion: string;
  shapeSource: string;
  source: string;
  publishRunId?: string | undefined;
  asOf: string;
  /** Injected so this module stays DB- and contract-free: the CLI passes `normalizeAccessPair`. */
  resolveAccess: (input: unknown) => AccountKeyedAccessResolution;
  /** Injected so the claim reader stays in one place: the CLI passes a `readConformantCadClaim` reader. */
  readLastSeenTaxYear: (body: Record<string, unknown>) => number | null;
}

export interface AccountKeyedRetirementWrite {
  parcelNodeId: string;
  payload: AccountKeyedRetirementPayload;
}

/**
 * The retirement pass, as a PURE PLAN: every excluded node becomes exactly one
 * write carrying the CURRENT run stamp and no facts. The CLI owns the SQL; a
 * test owns a fake store. One item -> one write, so
 * `writes.length + accessRefused === excluded.length` holds by construction and
 * a dropped population is a failing count rather than a silent miss.
 */
export function planAccountKeyedRetirements(
  input: AccountKeyedRetirementPlanInput,
): { writes: AccountKeyedRetirementWrite[]; accessRefused: number } {
  const writes: AccountKeyedRetirementWrite[] = [];
  let accessRefused = 0;
  for (const item of input.excluded) {
    const resolution = input.resolveAccess(item.body.access);
    if (!resolution.ok) {
      accessRefused += 1;
      continue;
    }
    const propId = item.parcelNodeId.split(":")[1] ?? "";
    writes.push({
      parcelNodeId: item.parcelNodeId,
      payload: buildAccountKeyedRetirementPayload({
        parcelNodeId: item.parcelNodeId,
        countyFips: input.countyFips,
        countyName: input.countyName,
        propId,
        facetSchemaVersion: input.facetSchemaVersion,
        shapeSource: input.shapeSource,
        source: input.source,
        access: resolution.access,
        accessNormalizedFrom: resolution.accessNormalizedFrom,
        publishRunId: input.publishRunId,
        asOf: input.asOf,
        lastSeenTaxYear: input.readLastSeenTaxYear(item.body),
      }),
    });
  }
  return { writes, accessRefused };
}

/**
 * The walk's own stamp predicate, mirrored so a test can assert the thing the
 * factory walk asserts (`hauska-factory src/jobs/verify-walk.mjs`
 * `responseCarriesPublishRunId`, read off the served payload). `publishRunId`
 * absent means the walk requires nothing, exactly as it does there.
 */
export function servedPayloadCarriesPublishRunId(
  payload: unknown,
  publishRunId: string | null | undefined,
): boolean {
  if (!publishRunId) return true;
  if (!payload || typeof payload !== "object") return false;
  const rec = payload as Record<string, unknown>;
  if (rec.publishRunId === publishRunId) return true;
  const nested = rec.facets ?? rec.payload ?? rec.data;
  return (
    !!nested &&
    typeof nested === "object" &&
    (nested as Record<string, unknown>).publishRunId === publishRunId
  );
}
