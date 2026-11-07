/**
 * P-351 (2026-09-18). THE ONE RESOLUTION THE RETIREMENT ARM READS.
 *
 * THE DEFECT THIS CLOSES. The bake's conformant retirement arm
 * (`nodeFacetBakeTier1Conformant.ts` `buildConformantTier1Payload`) decides
 * "this record is retired" from ONE statement: the declared-vintage roll
 * carries no row for the key it looked up. That statement is only an earned
 * retirement when the key it looked up was the record's ACCOUNT. On a county
 * whose served keys are not the CAD roll's keys -- Hays 48209, Williamson
 * 48491 -- the arm looked up the node's bare key, missed, and stamped a
 * retirement for a parcel whose account is on the roll and alive. Measured
 * on production 2026-09-18: Hays served 1,386 such retirements, of which 1,042
 * name an R account the declared 2026 roll still carries and 0 are genuine;
 * Williamson's 2026-09-17 run retired 282,570 of its 282,570 published R nodes,
 * of which 282,146 resolve to a numeric account the declared roll still
 * carries and 0 are genuine.
 *
 * THE TWO STATEMENTS THAT WERE THE SAME STATEMENT. P-177 (2026-09-13) replaced
 * the roll handed to the builder with a REMAPPED view keyed by the node's own
 * bare prop_id (`effectiveCadPropertyRoll`). After that, `row == null` reached
 * the retirement arm for two opposite reasons: (1) the node's account WAS NAMED
 * and is genuinely absent from the declared roll -- a real retirement; and
 * (2) the node's account could NOT BE NAMED, so nothing was ever looked up.
 * A lookup that did not happen is not a lookup that came back empty, and no
 * downstream reader could tell them apart. This module is the missing
 * discriminator: it produces, per node, either the ACCOUNT KEY the arm must
 * look up, or a NAMED REASON why no account could be named.
 *
 * THE ORDER OF THE PATHS, and why it is this order:
 *   1. `own-prop-id` -- a county whose prop_id join is NOT gate-blocked has ONE
 *      keyspace: the node's bare key IS the roll's key. Unchanged, and this is
 *      the path every earlier caller takes (the caller supplies no resolution
 *      at all, and the builder falls back to this).
 *   2. `crosswalk-geo-id-bind` -- the node's own published `txgio_parcel.geo_id`
 *      names the account's published `property_number`, corroborated by the
 *      account's own account-number stem agreeing with the node's key. This is
 *      `joinNormalize.accountCrosswalkForNode`, REUSED and not re-derived: the
 *      same function P-177's account-attribute crosswalk already uses, so the
 *      two cannot disagree. It carries an independent corroborator, so it is
 *      tried first.
 *   3. `published-account-pair` -- a pair published by the county's own staged
 *      extracts, read by the caller (`tx_wcad_owner` / `tx_wcad_ag_valuation`
 *      for Williamson: `prop_id` is the R account the parcel index publishes,
 *      `wcad_property_id` is the numeric account the roll is keyed by). Two
 *      extracts that disagree on a key refuse that key rather than pick one.
 *   4. `r-account-register` -- the node's own key IS the county's published
 *      R-account number with the prefix the source already stripped
 *      (`joinNormalize.ts`: Hays' `txgio_parcel.prop_id` values are the county's
 *      QuickRefID numbers, R removed at the source). The register test is the
 *      exact published identifier `R<key>` against the roll's `quick_ref_id`,
 *      never a bare-number match, and it is admissible ONLY when the node's own
 *      geo_id is absent or names the SAME `property_number`: two published
 *      identifiers naming different parcels refuse the bind rather than pick a
 *      winner, the same fail-closed rule `crosswalkBindCorroborated` applies.
 *      This is a PRESENCE test -- "does the county's current roll still carry
 *      the account this node names" -- not a second copy of the crosswalk.
 *   5. `r-account-register-prior-vintage` -- the declared register MISSED, so
 *      the account may have LEFT the roll; an account that left cannot be named
 *      off the roll. The PRIOR declared vintage is asked for its identity only
 *      (no value column is read anywhere on this path, so it structurally
 *      cannot serve a stale value -- the P-178 vintage rule), and a hit means
 *      the account existed and is gone. The presence verdict travels on the
 *      resolution, so the arm's own declared-roll lookup is joined rather than
 *      replaced and a prior prop_id can never be read as a declared-roll row.
 *   6. `unresolved` -- a named reason, never a retirement.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not decide whether the
 * account is on the roll; that stays the arm's single lookup. It does not
 * weaken the retirement predicate: a node whose ACCOUNT resolves and is absent
 * from the declared roll still retires, which is the real retirement signal for
 * these counties. It does not read a store and does not import one: like
 * `joinNormalize.ts`, it is dependency-free so the offline bake and its unit
 * test can import it without dragging a DB connection into module load.
 */

import {
  accountCrosswalkForNode,
  cadAccountNumberStem,
  normalizeForJoin,
} from "./joinNormalize";

/** How a node's account key was reached. `null` on an unresolved node. */
export type RetirementAccountPath =
  | "own-prop-id"
  | "crosswalk-geo-id-bind"
  | "published-account-pair"
  | "r-account-register"
  | "r-account-register-prior-vintage";

/** Why no account could be named. Always set on an unresolved node. */
export type RetirementUnresolvedReason =
  | "no-published-identifier"
  | "no-account-publishes-it"
  | "ambiguous-property-number"
  | "corroboration-refused"
  | "contradicted-by-node-identifier"
  | "pair-unavailable";

/** The two keyspaces this row's resolution compares, named for the payload. */
export interface RetirementKeyspaces {
  /** What the served key IS, in this county. */
  nodeKeyspace: string;
  /** What the declared roll's key IS, in this county. */
  rollKeyspace: string;
}

export interface RetirementResolution {
  status: "resolved" | "unresolved";
  path: RetirementAccountPath | null;
  /** The part of the node id after the colon -- the served key. */
  nodeKey: string;
  /** The key to look up in the declared roll, or null when no account was named. */
  accountKey: string | null;
  nodeKeyspace: string;
  rollKeyspace: string;
  /** The published identifier that named the account, when one did. */
  via: string | null;
  /** The independent identifier that agreed, when the path has one. */
  corroborator: string | null;
  reason: RetirementUnresolvedReason | null;
  /**
   * THE PRESENCE VERDICT, when the path already knows it. `true` = the account
   * was named FROM the declared roll itself, so it is on it by construction
   * (the crosswalk bind, the declared account-number register). `false` = the
   * account was named from the PRIOR declared vintage precisely because the
   * declared roll no longer carries its account number -- the real retirement
   * signal for this county. `null` = nothing here has decided it and the arm's
   * own single lookup is the test (the published-pair path).
   *
   * This exists so the arm never has to guess, and so a prior-vintage account
   * prop_id can never be looked up in the declared roll and mistake an
   * unrelated row at the same number for this record's account.
   */
  accountOnDeclaredRoll: boolean | null;
  /** One sentence naming what was compared, per parcel. */
  detail: string;
}

/**
 * P-351. THE PAYLOAD'S OWN STATEMENT of how this record's account was named --
 * present on every payload whose caller supplied a resolution, resolved or not.
 * A record with no resolution supplied (a single-keyspace county, and every
 * caller built before P-351) carries NO statement and is byte-identical to what
 * it baked before, which is deliberate: there is no cross-keyspace comparison
 * to disclose.
 *
 * `verdict: "key-unresolvable"` is the state that did not exist before this
 * card and is the whole point of it: the record is NOT retired, nothing was
 * looked up, and the payload says so instead of wearing a retirement it did not
 * earn. `recordRetirement` is null beside it.
 */
export interface Tier1RetirementResolution {
  verdict: "account-resolved" | "key-unresolvable";
  path: RetirementAccountPath | null;
  /** The served key this record carries (the part of the node id after the colon). */
  nodeKey: string;
  /** The account key the declared roll was read by, or null when none was named. */
  accountKey: string | null;
  nodeKeyspace: string;
  rollKeyspace: string;
  /** The declared roll's tax year, so the comparison names its vintage. */
  rollTaxYear: number | null;
  /** The published identifier that named the account, when one did. */
  via: string | null;
  /** The independent identifier that agreed, when the path has one. */
  corroborator: string | null;
  reason: RetirementUnresolvedReason | null;
  authority: string;
  scopeSearched: string;
  asOf: string;
  /** Per-parcel: two records may never share a character-identical basis. */
  basis: string;
}

/** One row of a county's published node-key -> account-key pair, from ONE extract. */
export interface PublishedAccountPairRow {
  /** The key the parcel index publishes (the served node key). */
  nodeKey: string;
  /** The account key the CAD roll is keyed by. Null when the extract carries none. */
  accountKey: string | null;
  /** The extract this row came from, for the payload's own provenance. */
  source: string;
}

export interface PublishedAccountPair {
  pairByNodeKey: ReadonlyMap<string, string>;
  /** Keys an extract carried with no account. Refused, counted. */
  refusedNoAccount: number;
  /** Keys one extract named twice with different accounts. Refused, counted. */
  refusedAmbiguous: number;
  /** Keys the extracts named with DIFFERENT accounts. Refused, counted. */
  refusedDisagreement: number;
  /** Every extract that contributed, named. */
  sources: readonly string[];
}

/**
 * Build the published pair from the county's own staged extracts. Pure.
 *
 * FAIL CLOSED THREE WAYS, each counted separately so a run cannot report
 * silence as success: a key with no account in any extract is refused; a key
 * one extract names twice with different accounts is refused as ambiguous; a
 * key two extracts name with different accounts is refused as a disagreement
 * (two published identifiers naming different parcels is positive evidence the
 * pair is wrong for that key, and the caller must not pick a winner).
 */
export function buildPublishedAccountPair(
  extracts: readonly (readonly PublishedAccountPairRow[])[],
): PublishedAccountPair {
  const sources: string[] = [];
  /** source -> node key -> the ONE account that source names (or the ambiguity sentinel). */
  const namedBySource = new Map<string, Map<string, string>>();
  /** every node key ANY extract saw, so a key seen only with a blank account is counted. */
  const seen = new Set<string>();
  for (const rows of extracts) {
    for (const row of rows) {
      const key = row.nodeKey.trim();
      if (key === "") continue;
      if (!sources.includes(row.source)) sources.push(row.source);
      seen.add(key);
      let m = namedBySource.get(row.source);
      if (!m) {
        m = new Map<string, string>();
        namedBySource.set(row.source, m);
      }
      // A row that carries no account contributes NOTHING: the staged extracts
      // are one row per land segment / owner, and a segment row without an
      // account is not evidence against the rows that carry one.
      const account = row.accountKey?.trim() ?? "";
      if (account === "") continue;
      const existing = m.get(key);
      if (existing === undefined) m.set(key, account);
      else if (existing !== account) m.set(key, AMBIGUOUS_WITHIN_SOURCE);
    }
  }
  const pairByNodeKey = new Map<string, string>();
  let refusedNoAccount = 0;
  let refusedAmbiguous = 0;
  let refusedDisagreement = 0;
  for (const key of seen) {
    const named: string[] = [];
    let ambiguous = false;
    let anySourceNamedIt = false;
    for (const m of namedBySource.values()) {
      const v = m.get(key);
      if (v === undefined) continue;
      anySourceNamedIt = true;
      if (v === AMBIGUOUS_WITHIN_SOURCE) ambiguous = true;
      else named.push(v);
    }
    if (ambiguous) {
      refusedAmbiguous += 1;
      continue;
    }
    const distinct = [...new Set(named)];
    if (distinct.length > 1) {
      refusedDisagreement += 1;
      continue;
    }
    if (distinct.length === 1) {
      pairByNodeKey.set(key, distinct[0] as string);
      continue;
    }
    if (!anySourceNamedIt) refusedNoAccount += 1;
  }
  return {
    pairByNodeKey,
    refusedNoAccount,
    refusedAmbiguous,
    refusedDisagreement,
    sources,
  };
}

const AMBIGUOUS_WITHIN_SOURCE = "\u0000ambiguous";

/**
 * P-370 (2026-09-19). THE SAME PUBLISHED PAIR, READ BY THE ACCOUNT.
 *
 * WHY THE OTHER DIRECTION EXISTS AT ALL. `buildPublishedAccountPair` above is
 * read BY the key the parcel index publishes and NAMES the account the declared
 * roll is keyed by -- the direction writer (a)'s retirement arm needs, because
 * a served node's account is what its roll lookup must use. Writer (b)'s
 * membership test asks the mirror question: for a work key that the county's
 * parcel table does NOT publish, is there a published parcel this key names?
 * That is the pair read BY the account.
 *
 * THE ROLES SWAP IN EXACTLY ONE PLACE, deliberately. `buildPublishedAccountPair`
 * is about two ROLES -- the key the pair is indexed by and the one key it names
 * -- not about which numbering system each role happens to hold, so the swap is
 * a field rename at this boundary and nowhere else. The alternative (a second
 * builder with its own copy of the three fail-closed rules) would be two
 * implementations of one contract, and the rules are exactly the ones a
 * two-extract pair must keep: no key named with no value is a refusal, a key one
 * extract names twice with different values is a refusal, and a key two extracts
 * name with different values is a refusal rather than an arbitrary winner.
 */
export interface PublishedNodeKeyByAccountRow {
  /** The account key the declared roll is keyed by -- the key the caller asked about. */
  accountKey: string;
  /** The parcel-index prop_id the extract publishes for that account key. */
  nodeKey: string;
  /** The extract this row came from, for the caller's own provenance line. */
  source: string;
}

export interface PublishedNodeKeyByAccountKey {
  /** account key -> the ONE parcel-index prop_id the extracts name for it. */
  byAccountKey: ReadonlyMap<string, string>;
  /** Account keys an extract carried with no parcel-index prop_id. Refused, counted. */
  refusedNoNodeKey: number;
  /** Account keys one extract named twice with different prop_ids. Refused, counted. */
  refusedAmbiguous: number;
  /** Account keys the extracts named with DIFFERENT prop_ids. Refused, counted. */
  refusedDisagreement: number;
  /** Every extract that contributed, named. */
  sources: readonly string[];
}

export function buildPublishedNodeKeyByAccountKey(
  extracts: readonly (readonly PublishedNodeKeyByAccountRow[])[],
): PublishedNodeKeyByAccountKey {
  const byRole = extracts.map((rows) =>
    rows.map(
      (r): PublishedAccountPairRow => ({
        nodeKey: r.accountKey,
        accountKey: r.nodeKey,
        source: r.source,
      }),
    ),
  );
  const pair = buildPublishedAccountPair(byRole);
  return {
    byAccountKey: pair.pairByNodeKey,
    refusedNoNodeKey: pair.refusedNoAccount,
    refusedAmbiguous: pair.refusedAmbiguous,
    refusedDisagreement: pair.refusedDisagreement,
    sources: pair.sources,
  };
}

/** The published R-account number for a node key, or null when the key is not a number. */
export function rAccountRegisterKey(nodeKey: string): string | null {
  const bare = normalizeForJoin(nodeKey);
  if (!/^[0-9]+$/.test(bare)) return null;
  return `R${bare}`;
}

export interface RetirementResolutionInput {
  nodeKey: string;
  countyFips: string;
  /** True when the county's prop_id join is gate-blocked (two keyspaces). */
  blocked: boolean;
  /** The node's own published `txgio_parcel.geo_id`, trimmed; null when it carries none. */
  nodeGeoId?: string | null;
  /** geo_id -> the CAD account's own prop_id (the crosswalk index the caller already built). */
  geoIdToAccountPropId?: ReadonlyMap<string, string>;
  /** CAD account prop_id -> its account-number stem (the corroborator index). */
  accountStemByPropId?: ReadonlyMap<string, string>;
  /** CAD account prop_id -> its published `property_number`, for the register's contradiction test. */
  propertyNumberByAccountPropId?: ReadonlyMap<string, string>;
  /** upper(btrim(quick_ref_id)) -> the CAD account's own prop_id. */
  registerPropIdByQuickRefId?: ReadonlyMap<string, string>;
  /**
   * Published account numbers the DECLARED roll names more than once with
   * different accounts. Not "absent" -- refused. A register lookup is only
   * evidence when the published identifier is unique in the roll it is read
   * from; two rows carrying `R<key>` are two published identifiers claiming
   * one number, and picking either is the arbitrary winner this row forbids.
   */
  refusedRegisterKeys?: ReadonlySet<string>;
  /**
   * The PRIOR declared vintage's published account-number register, used ONLY
   * to NAME an account the declared vintage no longer carries. Identity only;
   * see `fetchPriorVintageQuickRefRegister`. Absent means the caller did not
   * read it (or the county publishes no account numbers), and a node the
   * declared register misses then falls through to a declared non-retirement.
   */
  priorRegisterByQuickRefId?: ReadonlyMap<
    string,
    { propId: string; propertyNumber: string | null }
  >;
  /** Same refusal as `refusedRegisterKeys`, measured on the PRIOR vintage. */
  refusedPriorRegisterKeys?: ReadonlySet<string>;
  /** The rendered keyspaces, from `describeRetirementKeyspaces`. */
  keyspaces: RetirementKeyspaces;
  /** The county's published node-key -> account-key pair, when it publishes one. */
  publishedPair?: PublishedAccountPair;
}

/**
 * Choose the account key for one node, or a named reason why there is none.
 * Pure. Deterministic: the same inputs always produce the same resolution, so
 * the bake's log and the dry run cannot disagree.
 */
export function chooseRetirementResolution(
  input: RetirementResolutionInput,
): RetirementResolution {
  const nodeKey = input.nodeKey.trim();
  const base = {
    nodeKey,
    nodeKeyspace: input.keyspaces.nodeKeyspace,
    rollKeyspace: input.keyspaces.rollKeyspace,
  };
  if (!input.blocked) {
    return {
      ...base,
      status: "resolved",
      path: "own-prop-id",
      accountKey: nodeKey,
      accountOnDeclaredRoll: null,
      via: `the node's own key, which IS the CAD roll's key in county_fips ${input.countyFips}`,
      corroborator: null,
      reason: null,
      detail:
        `the node's own key ${nodeKey} is the CAD roll's prop_id in county_fips ${input.countyFips} ` +
        `(one keyspace; no crosswalk is needed and none is consulted)`,
    };
  }

  const refusal = (): { reason: RetirementUnresolvedReason; detail: string } | null => {
    const geoId = input.nodeGeoId?.trim() ?? "";
    if (geoId === "" || input.geoIdToAccountPropId == null) return null;
    const account = input.geoIdToAccountPropId.get(geoId) ?? null;
    if (account != null) {
      const stem = input.accountStemByPropId?.get(account) ?? null;
      if (stem != null && stem !== nodeKey) {
        return {
          reason: "corroboration-refused",
          detail:
            `the node's published Geographic ID ${geoId} names account ${account}, whose account ` +
            `number stem ${stem} DISAGREES with the node's own key ${nodeKey}: two published ` +
            `identifiers naming different parcels, so neither is taken`,
        };
      }
      return {
        reason: "no-published-identifier",
        detail:
          `the node's published Geographic ID ${geoId} names account ${account}, but the node ` +
          `carries no account-number stem to corroborate it and no other published identifier ` +
          `names an account`,
      };
    }
    return {
      reason: "no-account-publishes-it",
      detail:
        `the node's published Geographic ID ${geoId} names no account on the declared ` +
        `cad_property roll for county_fips ${input.countyFips}`,
    };
  };

  // 2. The geo_id bind, corroborated. Reuses the ONE implementation.
  const geoId = input.nodeGeoId?.trim() ?? "";
  if (geoId !== "" && input.geoIdToAccountPropId != null) {
    const { accountPropId, reason } = accountCrosswalkForNode(
      nodeKey,
      geoId,
      input.geoIdToAccountPropId,
      input.accountStemByPropId ?? new Map<string, string>(),
    );
    if (accountPropId != null) {
      return {
        ...base,
        status: "resolved",
        path: "crosswalk-geo-id-bind",
        accountKey: accountPropId,
        accountOnDeclaredRoll: true,
        via: `the node's published Geographic ID ${geoId} = cad_property.property_number`,
        corroborator: `the account's own account number stem agrees with the node's key ${nodeKey}`,
        reason: null,
        detail:
          `the node's published Geographic ID ${geoId} names account ${accountPropId} in the ` +
          `declared cad_property roll, corroborated by that account's own account number ` +
          `(stem ${nodeKey}); the retirement predicate compares account key ${accountPropId}`,
      };
    }
    if (reason === "corroboration-refused") {
      const refused = refusal();
      if (refused) return unresolvedOf(base, refused.reason, refused.detail);
    }
  }

  // 3. The county's own published pair.
  const pair = input.publishedPair?.pairByNodeKey.get(nodeKey) ?? null;
  if (pair != null) {
    return {
      ...base,
      status: "resolved",
      path: "published-account-pair",
      accountKey: pair,
      accountOnDeclaredRoll: null,
      via:
        `the county's published account pair (${input.publishedPair?.sources.join(" + ") ?? "staged extracts"}) ` +
        `names account ${pair} for served key ${nodeKey}`,
      corroborator:
        input.publishedPair != null && input.publishedPair.sources.length > 1
          ? `${input.publishedPair.sources.length} published extracts name the same account for this key`
          : null,
      reason: null,
      detail:
        `the served key ${nodeKey} names account ${pair} through the county's own published ` +
        `account pair; the retirement predicate compares account key ${pair}`,
    };
  }

  // 4. The R-account register: the node's key IS the county's published account
  // number. This is a PRESENCE test against the declared roll, so a hit means
  // the account is on the roll and the record is live.
  const registerKey = rAccountRegisterKey(nodeKey);
  if (registerKey != null && input.refusedRegisterKeys?.has(registerKey.toUpperCase())) {
    return unresolvedOf(
      base,
      "ambiguous-property-number",
      `the declared cad_property roll carries more than one row publishing the account number ` +
        `${registerKey} with different accounts, and this node's key ${nodeKey} names exactly ` +
        `that number: a published identifier that is not unique in the roll it is read from ` +
        `cannot name an account, so no account was looked up and no retirement is earned`,
    );
  }
  if (registerKey != null && input.registerPropIdByQuickRefId != null) {
    const account = input.registerPropIdByQuickRefId.get(registerKey.toUpperCase()) ?? null;
    if (account != null) {
      const pn = input.propertyNumberByAccountPropId?.get(account) ?? null;
      const ownGeoId = input.nodeGeoId?.trim() ?? "";
      if (ownGeoId !== "" && pn != null && pn !== ownGeoId) {
        return unresolvedOf(
          base,
          "contradicted-by-node-identifier",
          `the declared roll's own account number ${registerKey} names account ${account}, whose ` +
            `published property_number ${pn} DISAGREES with this node's own published ` +
            `Geographic ID ${ownGeoId}: two published identifiers naming different parcels, so ` +
            `neither is taken and no retirement is earned`,
        );
      }
      return {
        ...base,
        status: "resolved",
        path: "r-account-register",
        accountKey: account,
        accountOnDeclaredRoll: true,
        via: `the declared roll's own published account number ${registerKey}`,
        corroborator:
          ownGeoId !== ""
            ? `the node's own Geographic ID ${ownGeoId} agrees with that account's property_number`
            : null,
        reason: null,
        detail:
          `the served key ${nodeKey} IS the county's published account number ${registerKey}, ` +
          `which the declared cad_property roll still carries as account ${account}` +
          (ownGeoId !== ""
            ? `, and that account's published property_number agrees with the node's own Geographic ID ${ownGeoId}`
            : ` (the node carries no Geographic ID to contradict it)`),
      };
    }
  }

  // 5. The declared register missed. The account may be GONE -- an account that
  // left the roll cannot be named off the roll -- so the prior declared vintage
  // is asked for its IDENTITY only (no value column is read anywhere in this
  // path). A hit means the account existed and is no longer on the roll, which
  // is this county's real retirement signal; the arm's lookup on the declared
  // roll then misses and the record earns its retirement.
  if (registerKey != null && input.refusedPriorRegisterKeys?.has(registerKey.toUpperCase())) {
    return unresolvedOf(
      base,
      "ambiguous-property-number",
      `the prior declared vintage carries more than one row publishing the account number ` +
        `${registerKey} with different accounts, and this node's key ${nodeKey} names exactly ` +
        `that number: an account that cannot be named uniquely on the vintage it is read from ` +
        `does not earn a retirement`,
    );
  }
  if (registerKey != null && input.priorRegisterByQuickRefId != null) {
    const prior = input.priorRegisterByQuickRefId.get(registerKey.toUpperCase()) ?? null;
    if (prior != null) {
      const ownGeoId = input.nodeGeoId?.trim() ?? "";
      if (ownGeoId !== "" && prior.propertyNumber != null && prior.propertyNumber !== ownGeoId) {
        return unresolvedOf(
          base,
          "contradicted-by-node-identifier",
          `the prior declared vintage's account number ${registerKey} names account ${prior.propId}, ` +
            `whose published property_number ${prior.propertyNumber} DISAGREES with this node's ` +
            `own published Geographic ID ${ownGeoId}: two published identifiers naming different ` +
            `parcels, so neither is taken and no retirement is earned`,
        );
      }
      return {
        ...base,
        status: "resolved",
        path: "r-account-register-prior-vintage",
        accountKey: prior.propId,
        accountOnDeclaredRoll: false,
        via:
          `the PRIOR declared vintage's published account number ${registerKey} (identity only; ` +
          `no prior-vintage value column is read)`,
        corroborator:
          ownGeoId !== ""
            ? `the node's own Geographic ID ${ownGeoId} agrees with that prior account's property_number`
            : null,
        reason: null,
        detail:
          `the served key ${nodeKey} IS the county's published account number ${registerKey}; the ` +
          `declared roll no longer carries it, but the prior declared vintage names it as account ` +
          `${prior.propId}, so the account has LEFT the roll` +
          (ownGeoId !== ""
            ? ` and the prior row's property_number agrees with the node's own Geographic ID ${ownGeoId}`
            : ` (the node carries no Geographic ID to contradict it)`),
      };
    }
  }

  // 6. Nothing named an account. Return the most specific refusal we found.
  const refused = refusal();
  if (refused) return unresolvedOf(base, refused.reason, refused.detail);
  return unresolvedOf(
    base,
    "no-published-identifier",
    `no published identifier names an account for served key ${nodeKey} in county_fips ` +
      `${input.countyFips}: the node carries no Geographic ID, its key is not the county's ` +
      `published account number, and the county publishes no account pair for it. No account ` +
      `was looked up, so no retirement is earned`,
  );
}

function unresolvedOf(
  base: Pick<RetirementResolution, "nodeKey" | "nodeKeyspace" | "rollKeyspace">,
  reason: RetirementUnresolvedReason,
  detail: string,
): RetirementResolution {
  return {
    ...base,
    status: "unresolved",
    path: null,
    accountKey: null,
    accountOnDeclaredRoll: null,
    via: null,
    corroborator: null,
    reason,
    detail,
  };
}

/**
 * The legacy resolution: a county whose prop_id join is not gate-blocked, or
 * any caller that supplies no resolution at all. The builder falls back to
 * exactly this, which is what keeps every pre-P-351 payload byte-identical.
 */
export function ownPropIdResolution(
  nodeKey: string,
  keyspaces: RetirementKeyspaces,
): RetirementResolution {
  return {
    nodeKey: nodeKey.trim(),
    status: "resolved",
    path: "own-prop-id",
    accountKey: nodeKey.trim(),
    accountOnDeclaredRoll: null,
    nodeKeyspace: keyspaces.nodeKeyspace,
    rollKeyspace: keyspaces.rollKeyspace,
    via: null,
    corroborator: null,
    reason: null,
    detail: `the node's own key ${nodeKey.trim()} is the CAD roll's prop_id`,
  };
}

/**
 * Name the two keyspaces, county-agnostically. A gate-blocked county has two
 * published numbering systems and the payload must say which one it compared;
 * a county whose prop_id join is not blocked has one and says so.
 */
export function describeRetirementKeyspaces(
  blocked: boolean,
): RetirementKeyspaces {
  if (blocked) {
    return {
      nodeKeyspace:
        "the county's published parcel index (txgio_parcel.prop_id) -- the served node key",
      rollKeyspace:
        "the county's CAD roll prop_id (cad_property.prop_id, the county's own PropertyID)",
    };
  }
  // ONE keyspace, named ONCE. The node's own key IS the roll's key here, so both
  // fields carry the same sentence rather than two descriptions of one thing: a
  // payload that named one keyspace two different ways would invite a reader --
  // or a later equality check -- to believe there are two.
  const singleKeyspace =
    "the CAD roll prop_id (one keyspace: the node's own key IS the roll's key)";
  return { nodeKeyspace: singleKeyspace, rollKeyspace: singleKeyspace };
}

/**
 * The keyspace a served key's SHAPE puts it in. Used by the writer-(b)
 * blast-radius instrument, never to pick an account.
 */
export function nodeKeyShapeClass(nodeKey: string): "numeric" | "r-account" | "other" {
  const k = nodeKey.trim();
  if (/^[0-9]+$/.test(k)) return "numeric";
  if (/^[A-Za-z][0-9]+$/.test(k)) return "r-account";
  return "other";
}

/** The stem of a CAD account number, re-exported so callers share one rule. */
export { cadAccountNumberStem };
