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
 */

/** The subject a work item carries: the atom body and the node id derived from it. */
export interface AccountKeyedWorkItem {
  body: Record<string, unknown>;
  parcelNodeId: string;
}

export function isAccountKeyedNodeId(
  propId: string,
  txgioPropIds: ReadonlySet<string>,
): boolean {
  const id = propId.trim();
  if (id === "") return false;
  return !txgioPropIds.has(id);
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
): { kept: T[]; excluded: T[] } {
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const item of work) {
    const propId = item.parcelNodeId.split(":")[1] ?? "";
    if (isAccountKeyedNodeId(propId, txgioPropIds)) excluded.push(item);
    else kept.push(item);
  }
  return { kept, excluded };
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
    | "parcelNodeId"
    | "countyFips"
    | "countyName"
    | "propId"
    | "asOf"
    | "lastSeenTaxYear"
  >,
): AccountKeyedRetirementRecord {
  const { parcelNodeId, countyFips, countyName, propId, asOf, lastSeenTaxYear } = input;
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
