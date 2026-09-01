/**
 * Conformant-v1 Tier-1 facet payload: pure builder + the old-versus-new
 * divergence instrument (OPS-19 A-025, CTX card E, 2026-08-28).
 *
 * The publish bake (`../nodeFacetBakeTier1ConformantCli.ts`) reads
 * `cad-parcel-roll` atoms on the conformant shape out of hauska_mcp and
 * writes `place_layer_snapshots` rows under `node-facets:tier1`. Before this
 * module it wrote `facets.base.{apn,parcelNodeId,situsAddress}` and nothing
 * else; the Property Explorer reads `baseFacts`, `zoning`, `envelope`,
 * `facetCoverage` and `provenance` (the shape the old txgio-keyed bake wrote),
 * so every parcel published on the thin shape rendered "not verified here".
 *
 * `buildConformantTier1Payload` projects the FULL old facet set by running
 * the same assembly the old bake runs (`./nodeFacetTier1Assemble.ts`):
 *
 *   - baseFacts: the CAD claim fields mapped by name (apn from the node id,
 *     situsAddress/situsCity from the claim, landUse from the claim's
 *     propertyUseCode + tax year) plus situsState from the parcel join;
 *   - zoning: the same zoning-stamp join keyed by parcel node id
 *     (`txgio_parcel.zoning_district` / `zoning_jurisdiction`), the same
 *     jurisdiction resolution and layer provenance;
 *   - envelope: the same `computeTier1Envelope` (declined, honest);
 *   - acreage: the same shoelace on the parcel ring; the claim's declared
 *     `landAcres` only when there is no ring, under a distinct method;
 *   - facetCoverage / provenance / bakedAt: the same predicates and slots,
 *     plus `provenance.parcelJoin` naming what the join did (joined, no row,
 *     gate-blocked, joined-situs). Absent is a state the key carries, never
 *     an omission.
 *
 * Kept from the conformant shape: `shapeSource`, `baked`, `source`, `access`
 * (canonical pair, A-023), `accessNormalizedFrom` when serve translation
 * applies, `publishRunId`, `facets.base` (read by `refusePayloadAtServe` and
 * the Factory walk), `facetCoverage.tier1`.
 *
 * `facetSchemaVersion` is `node-facets-tier1-conformant-v1`, deliberately NOT
 * the old literal: hauska-factory `src/jobs/verify-walk.mjs` fails
 * BP-CONFORMANT-01 on `facets.facetSchemaVersion === "node-facets-tier1-v1"`
 * as the old-shape baseline.
 *
 * OWNER. The claim carries `ownerName`. This module never reads it, and
 * `assertNoOwnerKey` refuses any owner-shaped key before a write, with the
 * same key predicate the serve strip uses.
 *
 * BODY PLACEMENT (CTX card F, 2026-08-28). The Factory's stage E spreads the
 * six-field candidate into the atom body (hauska-factory
 * `src/stages/write/index.mjs` `stageRows`: `{ ...c, atomId, atomDid, ... }`),
 * so on the production store the claim fields sit at the body ROOT beside
 * `provenance`, `confidence`, `citation`, `time`, `access` and a minted
 * `nodeId` (`nid_...`); there is no `body.claim`. Read 2026-08-28 19:54Z on
 * hauska_mcp: 120 of 120 sampled conformant bodies across the six counties are
 * flat. Until this card `readConformantCadClaim` took `situsCity`, `situsZip`,
 * `landAcres` and `propertyUseCode` from `body.claim` only, so every one of
 * them baked null (1,498,010 conformant rows, 0 with a land use, 0 with a
 * situs city; the golds' stored bodies carry AUSTIN 78756, TAYLOR 76574,
 * KYLE 78640, BASTROP 78602). The reader now resolves the claim record as
 * `body.claim` when present, else the body itself, and reads every field from
 * that one record.
 *
 * DB-free: the CLI owns I/O; tests import this module directly.
 */

import type { AddressLandUseEntry, PropIdLandUseEntry } from "./joinIntegrityGate";
import { resolveAddressLandUse } from "./joinIntegrityGate";
import {
  addressJoinKey,
  landUseJoinKey,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
} from "./joinNormalize";
import {
  assembleTier1Payload,
  COUNTY_NAMES,
  firstRing,
  type BaseFacts,
  type Tier1FacetPayload,
} from "./nodeFacetTier1Assemble";
import { cadPropertyFactsFromRow } from "./cadRollValue";
import type { ParcelJoinRow } from "./nodeFacetTier1ParcelJoin";
import { ptadLandUseDescription } from "./ptadLandUse";

export const CONFORMANT_SHAPE_SOURCE = "conformant-v1";
export const CONFORMANT_TIER1_SOURCE = "conformant-v1-cad-parcel-roll";
export const TIER1_CONFORMANT_FACET_SCHEMA_VERSION =
  "node-facets-tier1-conformant-v1";
/** The literal the Factory walk rejects as the old-shape baseline. */
export const OLD_SHAPE_SCHEMA_VERSION_REJECTED_BY_WALK = "node-facets-tier1-v1";

// ---------------------------------------------------------------------------
// LAND USE (2026-08-31). Until this change the ONLY land-use source here was
// `claim.propertyUseCode`, while the old bake joined `cad_property` on the
// gated prop_id key. The flat bodies the Factory stores carry that claim field
// null on production rows, so the bake wrote `baseFacts.landUse: null` and
// `facetCoverage.landUse: false` for parcels whose CAD roll carries A1 —
// verified live on 48021:34137, 48021:8720522 and two Travis parcels. A
// coverage flag that reads false where the value exists is not a rendering
// bug: every consumer of the facet body (get_smart_site, the walk, reports,
// any surface built later) reads the same null, and anything scoring coverage
// from that flag under-counts land use across six counties.
//
// The bake now resolves land use in this order, and NEVER defaults it:
//   1. the claim's own `propertyUseCode` (no join, no collision risk);
//   2. the county CAD roll on the prop_id key (CAD-to-CAD, same
//      `cad_property` read the old bake used, passed in by the CLI).
//      Seed does NOT apply to this join. Seed risk was TxGIO-to-CAD.
//      48209 and 48491 are clear. Do not re-impose the seed. Join key
//      stays prop_id, never seed.
//   3. on a prop_id-gate-blocked county only, the owner-gated situs-address
//      recovery that was already here (that gate is TxGIO-to-CAD).
// Where none of the three resolves, the bake writes an EARNED absence
// (`provenance.landUseAbsence`: verdict, authority, scopeSearched, an
// evaluation-time asOf and a per-parcel basis) rather than a bare null, and
// `assertLandUseAbsenceEarned` REFUSES the write if a null ever reaches a
// payload without one. The land-use ATOM is not read here: the bake projects
// from its claim and its roll, and the atom is a separate surface.

const SQFT_PER_ACRE = 43_560;

// ---------------------------------------------------------------------------
// Claim reading (by name, never defaulted, never the owner).
// ---------------------------------------------------------------------------

/**
 * The claim record of a stored body: `body.claim` when the body nests it, else
 * the body itself (the Factory's flat six-field placement). Exported so a
 * caller can see which placement a body used.
 */
export function conformantClaimRecord(
  body: Record<string, unknown>,
): { claim: Record<string, unknown>; placement: "nested" | "flat" } {
  const nested = asRecord(body.claim);
  return nested ? { claim: nested, placement: "nested" } : { claim: body, placement: "flat" };
}

/** The subset of a `cad-parcel-roll` claim the bake maps. No owner field. */
export interface ConformantCadClaim {
  countyFips: string | null;
  propId: string | null;
  taxYear: number | null;
  situsAddress: string | null;
  situsCity: string | null;
  situsZip: string | null;
  landAcres: number | null;
  propertyUseCode: string | null;
  marketValue: number | null;
  assessedValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  livingAreaSqft: number | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read the claim fields the bake maps from the claim record (`body.claim`
 * when nested, else the flat body the Factory actually stores; see BODY
 * PLACEMENT above). Every field is the claim's value or null; nothing is
 * defaulted, and `ownerName` is never read.
 */
export function readConformantCadClaim(
  body: Record<string, unknown>,
): ConformantCadClaim {
  const { claim } = conformantClaimRecord(body);
  const src = asRecord(claim.sourceIdentifiers) ?? {};
  return {
    countyFips: strOrNull(claim.countyFips),
    propId: strOrNull(src.prop_id),
    taxYear: finiteOrNull(src.taxYear),
    situsAddress: strOrNull(claim.situsAddress),
    situsCity: strOrNull(claim.situsCity),
    situsZip: strOrNull(claim.situsZip),
    landAcres: finiteOrNull(claim.landAcres),
    propertyUseCode: strOrNull(claim.propertyUseCode),
    marketValue: finiteOrNull(claim.marketValue),
    assessedValue: finiteOrNull(claim.assessedValue),
    landValue: finiteOrNull(claim.landValue),
    improvementValue: finiteOrNull(claim.improvementValue),
    livingAreaSqft: finiteOrNull(claim.livingAreaSqft),
  };
}

/**
 * Parcel node id for an atom body: the Factory's `nodeId` when present, else
 * `${county}:${prop_id}` from the source identifiers. Null when neither
 * exists (the CLI counts it as skipped; an id is never invented).
 */
export function parcelNodeIdFromBody(
  body: Record<string, unknown>,
  countyFips: string,
): string | null {
  const nodeId = body?.nodeId ?? asRecord(body?.claim)?.nodeId;
  if (typeof nodeId === "string" && nodeId.includes(":")) return nodeId;
  const src =
    asRecord(body?.sourceIdentifiers) ??
    asRecord(asRecord(body?.claim)?.sourceIdentifiers);
  const propId = src?.prop_id;
  if (typeof propId === "string" && propId.trim() !== "") {
    return `${countyFips}:${propId.trim()}`;
  }
  if (typeof propId === "number" && Number.isFinite(propId)) {
    return `${countyFips}:${propId}`;
  }
  return null;
}

/** Declared CAD acreage, carried ONLY when the bake holds no ring. */
export function conformantAcreageFromClaim(
  landAcres: number | null,
): BaseFacts["acreage"] {
  if (landAcres == null || !Number.isFinite(landAcres) || landAcres <= 0) {
    return null;
  }
  return {
    value: Math.round(landAcres * 10_000) / 10_000,
    sqft: Math.round(landAcres * SQFT_PER_ACRE),
    method: "cad-roll-land-acres",
  };
}

// ---------------------------------------------------------------------------
// Payload.
// ---------------------------------------------------------------------------

/** What the parcel (zoning stamp + geometry) join did for this parcel. */
export type ParcelJoinRecord =
  | {
      table: string;
      state: "joined";
      basis: string;
      featureIndex: number;
      /** The parcel table's own vintage (e.g. stratmap25-...). */
      sourceVintage: string | null;
    }
  | {
      table: string;
      state: "joined-situs";
      basis: string;
      featureIndex: number | null;
      sourceVintage: string | null;
    }
  | { table: string; state: "no-row"; basis: string }
  | { table: string; state: "gate-blocked"; basis: string };

export type { PropIdLandUseEntry };

/**
 * WHICH upstream supplied a projected land use. `source` on the facet stays
 * the two-value `LandUseSource` the ledger and card already read; this names
 * the derivation so a claim-carried value and a roll-joined one are tellable
 * apart without changing that enum.
 */
export type LandUseOrigin =
  | "claim"
  | "cad-property-prop-id-join"
  | "cad-roll-address-join";

/**
 * An EARNED absence for the land-use facet, in the shape
 * `19_the_instrument_contract.md` requires of a layer that is absent.
 *
 * `absent-verified` means the authority WAS consulted in the stated scope and
 * the parcel genuinely carries no land use. `lookup-failed` means we could
 * not look — an undeclared CAD vintage, an absent `cad_property`, a roll the
 * caller never read, or a gate-blocked county whose situs recovery did not
 * accept — and must never be reported as the former. `asOf` is the bake's own
 * evaluation clock (the instant this decision was made), never a request
 * clock. `basis` names THIS parcel; a basis identical across parcels is a
 * ceremony, not a justification, and the guard below refuses it.
 */
export interface LandUseAbsence {
  verdict: "absent-verified" | "lookup-failed";
  authority: string;
  scopeSearched: string;
  asOf: string;
  basis: string;
}

/**
 * The county CAD roll the bake may consult for land use, as
 * `fetchCountyLandUseRoll` returns it. `consulted: false` means the read did
 * not happen (no declared vintage / no `cad_property`): an empty map is not
 * evidence of absence, and this bake will not treat it as one.
 */
export interface ConformantLandUseRoll {
  byPropId: ReadonlyMap<string, PropIdLandUseEntry>;
  declaredTaxYear: number | null;
  consulted: boolean;
}

/**
 * Declared-vintage `cad_property` rows keyed by CAD prop_id. Dollar / living
 * / year / legal / exemption fields read ONLY from here. Seed does not
 * apply. A missing input means the caller did not consult CAD and every
 * cadRoll field bakes null (honest), never an atom claim.
 */
export interface ConformantCadPropertyRoll {
  byPropId: ReadonlyMap<
    string,
    {
      taxYear: number | null;
      marketValue: unknown;
      assessedValue: unknown;
      landValue: unknown;
      improvementValue: unknown;
      livingAreaSqft: unknown;
      yearBuilt?: unknown;
      legalDescription?: unknown;
      exemptionCodes?: unknown;
    }
  >;
  declaredTaxYear: number | null;
  consulted: boolean;
}

export interface ConformantTier1Payload extends Omit<
  Tier1FacetPayload,
  "facetCoverage" | "provenance"
> {
  shapeSource: typeof CONFORMANT_SHAPE_SOURCE;
  baked: true;
  source: typeof CONFORMANT_TIER1_SOURCE;
  access: { discoverability: string; entitlement: string };
  accessNormalizedFrom?: string;
  publishRunId?: string;
  facets: {
    base: { parcelNodeId: string; situsAddress: string | null; apn: string | null };
  };
  facetCoverage: Tier1FacetPayload["facetCoverage"] & { tier1: "populated" };
  provenance: Tier1FacetPayload["provenance"] & {
    parcelJoin: ParcelJoinRecord;
    /** Which upstream supplied the land use; null when none did. */
    landUseOrigin: LandUseOrigin | null;
    /** The earned absence when no land use was projected; null when one was. */
    landUseAbsence: LandUseAbsence | null;
  };
}

export interface ConformantTier1BuildInput {
  /** The atom body (`claim`, `nodeId`, `access`, ...). */
  body: Record<string, unknown>;
  parcelNodeId: string;
  countyFips: string;
  countyName?: string;
  /** Situs already passed `assertSitusNotPunctuationOnly` (null when absent). */
  situsAddress: string | null;
  access: { discoverability: string; entitlement: string };
  accessNormalizedFrom: string | null;
  publishRunId: string | undefined;
  parcelJoin: {
    /** Table the join was (or would have been) read from. */
    table: string;
    /** Prop_id-keyed row. Ignored when gate-blocked (a numbering collision). */
    row: ParcelJoinRow | null;
    /** True when the county's prop_id join is gate-blocked (never joined). */
    gateBlocked: boolean;
    /**
     * Situs-keyed recovered row. Used only when gate-blocked AND the owner
     * gate accepts. A prop_id-keyed row in `row` is still ignored.
     */
    situsRow?: ParcelJoinRow | null;
  };
  /**
   * Owner-gated situs recovery for a gate-blocked county. When present,
   * land-use is resolved via `addressJoinKey` + `resolveAddressLandUse`
   * (never the claim's propertyUseCode, never a prop_id join). The TxGIO
   * owner is used only for the gate and is never copied into the payload.
   */
  situsRecovery?: {
    addressLandUse: ReadonlyMap<string, AddressLandUseEntry>;
    txgioOwner?: string | null;
    blockedFips?: ReadonlySet<string>;
  };
  /**
   * The county CAD roll on the prop_id key (`fetchCountyLandUseRoll`) — the
   * SAME `cad_property` upstream the old bake joined. Consulted only when the
   * claim carries no `propertyUseCode` AND the county prop_id join is not
   * gate-blocked. OMITTING it means the caller did not read the roll, and the
   * resulting absence is `lookup-failed`, never `absent-verified`.
   */
  landUseRoll?: ConformantLandUseRoll;
  /**
   * Declared-vintage `cad_property` for dollar / living / year / legal /
   * exemption. ALWAYS consulted when the CLI read the table. Seed does not
   * apply (CAD-to-CAD on the parcel node's own CAD prop_id). OMITTING it
   * bakes null cadRoll fields, never the atom claim.
   */
  cadPropertyRoll?: ConformantCadPropertyRoll;
  /**
   * Optional block set threaded into `landUseJoinKey` for key normalization.
   * Seed does NOT apply to the CAD-to-CAD landUse prop_id roll join (both
   * sides CAD; seed risk was TxGIO-to-CAD). 48209 and 48491 are clear on
   * that join. Do not re-impose LANDUSE_JOIN_DISABLED_FIPS_SEED here. The
   * join key is prop_id, never seed. Ledger `block` verdicts still apply
   * to the TxGIO-to-CAD parcel join and situs recovery, not to this roll.
   */
  blockedFips?: ReadonlySet<string>;
  nowIso: string;
  onSitusFallback?: (info: {
    cityKey: string;
    situsCity: string;
    countyFips: string;
  }) => void;
}

/**
 * Build the conformant Tier-1 payload. Pure. Runs the old bake's assembly on
 * the claim + the parcel join; where a facet has no source the key is present
 * with an explicit absence in the shape the reader expects.
 *
 * FAIL CLOSED on the gate: a prop_id-keyed row offered for a gate-blocked
 * county is not used (a numbering collision would attach another parcel's
 * stamp and ring). For those counties the owner-gated situs recovery may
 * still fire: `addressJoinKey` + `resolveAddressLandUse` / `ownersAgree`.
 * A recovered land-use carries `source: cad-roll-address-join`. A recovered
 * situs-keyed row may write ring, centroid, and zoning stamp.
 * `parcelJoin.state` is `joined-situs` on recovery, `gate-blocked` when
 * recovery fails, `joined` on a legal prop_id join, `no-row` when the legal
 * join finds nothing.
 */
export function buildConformantTier1Payload(
  input: ConformantTier1BuildInput,
): ConformantTier1Payload {
  const { parcelNodeId, countyFips, nowIso } = input;
  const claim = readConformantCadClaim(input.body);
  const apn = parcelNodeId.split(":")[1] ?? null;
  const countyName = input.countyName ?? COUNTY_NAMES[countyFips] ?? countyFips;

  const gateBlocked = input.parcelJoin.gateBlocked;
  // Prop_id row is never used on a blocked county (the collision).
  let row: ParcelJoinRow | null = gateBlocked ? null : input.parcelJoin.row;
  let landUseAddressRecovered = false;
  let situsRecoveryAccepted = false;

  const code = claim.propertyUseCode;
  let landUseOrigin: LandUseOrigin | null = code ? "claim" : null;
  let landUse: BaseFacts["landUse"] = code
    ? {
        code,
        description: ptadLandUseDescription(code) ?? null,
        source: "cad-roll",
        vintage: claim.taxYear != null ? String(claim.taxYear) : null,
      }
    : null;

  // The CAD roll on the prop_id key (CAD-to-CAD; the old bake's upstream).
  // Seed does NOT apply to this join. Seed risk was TxGIO-to-CAD. 48209 and
  // 48491 are clear. Do not re-impose the seed. Join key stays prop_id.
  // Runs only when the claim carried nothing AND the county is not
  // gate-blocked on the TxGIO parcel join (that county recovers on situs
  // address below instead).
  const effectiveBlocked = input.blockedFips ?? LANDUSE_JOIN_DISABLED_FIPS_SEED;
  const rollJoinKey =
    !code && !gateBlocked ? landUseJoinKey(countyFips, apn, effectiveBlocked) : null;
  const rollConsulted = input.landUseRoll?.consulted === true;
  if (rollJoinKey != null && rollConsulted) {
    const hit = input.landUseRoll?.byPropId.get(rollJoinKey) ?? null;
    if (hit) {
      landUse = {
        code: hit.landUseCode,
        description: ptadLandUseDescription(hit.landUseCode) ?? null,
        source: "cad-roll",
        vintage: hit.landUseVintage,
      };
      landUseOrigin = "cad-property-prop-id-join";
    }
  }

  if (gateBlocked && input.situsRecovery) {
    const blocked =
      input.situsRecovery.blockedFips ?? LANDUSE_JOIN_DISABLED_FIPS_SEED;
    const addrKey = addressJoinKey(countyFips, input.situsAddress, blocked);
    const txgioOwner =
      input.situsRecovery.txgioOwner ??
      input.parcelJoin.situsRow?.txgio_owner_for_gate ??
      null;
    const hit = resolveAddressLandUse(
      addrKey,
      txgioOwner,
      input.situsRecovery.addressLandUse,
    );
    if (hit) {
      landUse = {
        code: hit.code,
        description: ptadLandUseDescription(hit.code) ?? null,
        source: "cad-roll-address-join",
        vintage: hit.vintage,
      };
      landUseAddressRecovered = true;
      landUseOrigin = "cad-roll-address-join";
      situsRecoveryAccepted = true;
      row = input.parcelJoin.situsRow ?? null;
    } else {
      // Recovery attempted and refused (disagree, blank owner, blank situs,
      // or no address match): honest null, never the claim code as a silent
      // fallback, never the offered prop_id row.
      landUse = null;
      landUseOrigin = null;
      landUseAddressRecovered = false;
      row = null;
    }
  }

  const landUseAbsence: LandUseAbsence | null = landUse
    ? null
    : buildLandUseAbsence({
        parcelNodeId,
        countyFips,
        countyName,
        apn,
        access: input.access,
        gateBlocked,
        situsRecoveryOffered: input.situsRecovery != null,
        roll: input.landUseRoll,
        rollJoinKey,
        nowIso,
      });

  const ring = row ? firstRing(row.geometry) : null;

  // CAD-to-CAD on the parcel node's own prop_id. landUseJoinKey is the
  // TxGIO-to-CAD gate and returns null for Hays/Williamson — using it here
  // would starve the two hollow-atom counties this card exists to fill.
  const cadPropConsulted = input.cadPropertyRoll?.consulted === true;
  const cadPropRow =
    apn && cadPropConsulted
      ? (input.cadPropertyRoll?.byPropId.get(apn) ?? null)
      : null;
  const cadFacts = cadPropertyFactsFromRow(cadPropRow);

  const tier1 = assembleTier1Payload({
    nodeId: parcelNodeId,
    countyFips,
    countyName,
    facetSchemaVersion: TIER1_CONFORMANT_FACET_SCHEMA_VERSION,
    apn,
    situsAddress: input.situsAddress,
    situsCity: claim.situsCity,
    situsState: row?.situs_state ?? null,
    situsZip: claim.situsZip,
    landUse,
    cadRoll: cadFacts.cadRoll,
    yearBuilt: cadFacts.yearBuilt,
    legalDescription: cadFacts.legalDescription,
    exemptionCodes: cadFacts.exemptionCodes,
    landUseAddressRecovered,
    // The land-use is the claim's own field or a recovered address join;
    // the prop_id join gate is recorded on provenance.parcelJoin instead.
    landUseGateBlocked: false,
    ring,
    acreageWithoutRing: conformantAcreageFromClaim(claim.landAcres),
    zoningDistrictRaw: row?.zoning_district ?? null,
    zoningJurisdictionRaw: row?.zoning_jurisdiction ?? null,
    parcelSource: CONFORMANT_TIER1_SOURCE,
    parcelVintage: claim.taxYear != null ? String(claim.taxYear) : null,
    nowIso,
    onSitusFallback: input.onSitusFallback,
  });

  const table = input.parcelJoin.table;
  const sourceVintageOf = (r: ParcelJoinRow): string | null =>
    typeof r.source_vintage === "string" && r.source_vintage.trim()
      ? r.source_vintage.trim()
      : null;
  const parcelJoin: ParcelJoinRecord = gateBlocked
    ? situsRecoveryAccepted
      ? {
          table,
          state: "joined-situs",
          basis: row
            ? `${table} row feature_index ${row.feature_index} matched on normalizeSitusAddress (situs-address recovery for county ${countyFips})`
            : `situs-address recovery accepted for county ${countyFips} on normalizeSitusAddress; no ${table} row matched (zoning stamp and geometry unavailable)`,
          featureIndex: row ? row.feature_index : null,
          sourceVintage: row ? sourceVintageOf(row) : null,
        }
      : {
          table,
          state: "gate-blocked",
          basis:
            `prop_id join is gate-blocked for county ${countyFips} (coverage ` +
            `ledger block verdict or LANDUSE_JOIN_DISABLED_FIPS_SEED): a CAD ` +
            `prop_id joined into a divergent TxGIO numbering attaches another ` +
            `parcel's zoning stamp and geometry, so zoning and geometry are ` +
            `unmeasured here, not verified absent` +
            (input.situsRecovery
              ? "; situs-address recovery did not accept (owners disagree, blank owner, blank situs, or no address match)"
              : ""),
        }
    : row
      ? {
          table,
          state: "joined",
          basis: `${table} row feature_index ${row.feature_index} matched (county_fips, prop_id)`,
          featureIndex: row.feature_index,
          sourceVintage: sourceVintageOf(row),
        }
      : {
          table,
          state: "no-row",
          basis: `no ${table} row for (county_fips ${countyFips}, prop_id ${apn ?? "?"}); zoning stamp and geometry unavailable`,
        };

  const { facetCoverage, provenance, ...rest } = tier1;
  const payload: ConformantTier1Payload = {
    shapeSource: CONFORMANT_SHAPE_SOURCE,
    baked: true,
    source: CONFORMANT_TIER1_SOURCE,
    access: input.access,
    ...(input.accessNormalizedFrom
      ? { accessNormalizedFrom: input.accessNormalizedFrom }
      : {}),
    ...(input.publishRunId ? { publishRunId: input.publishRunId } : {}),
    facets: {
      base: {
        parcelNodeId,
        situsAddress: input.situsAddress,
        apn,
      },
    },
    ...rest,
    facetCoverage: { ...facetCoverage, tier1: "populated" },
    provenance: { ...provenance, parcelJoin, landUseOrigin, landUseAbsence },
  };
  // Fail closed at the builder as well as at the write: a null land use that
  // reaches a payload without an earned absence never leaves this function.
  assertLandUseAbsenceEarned(payload);
  return payload;
}

// ---------------------------------------------------------------------------
// Earned land-use absence.
// ---------------------------------------------------------------------------

interface LandUseAbsenceInput {
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  apn: string | null;
  access: { discoverability: string; entitlement: string };
  gateBlocked: boolean;
  situsRecoveryOffered: boolean;
  roll: ConformantLandUseRoll | undefined;
  rollJoinKey: string | null;
  nowIso: string;
}

/**
 * Build the absence block for a parcel with no land use. Every branch states
 * what was asked, where we looked, and why THIS parcel has nothing — and only
 * the branch that actually consulted the roll may say `absent-verified`.
 */
function buildLandUseAbsence(input: LandUseAbsenceInput): LandUseAbsence {
  const { parcelNodeId, countyFips, countyName, apn, roll, rollJoinKey, nowIso } = input;
  const year = roll?.declaredTaxYear ?? null;
  const entitlement = `${input.access.discoverability}/${input.access.entitlement}`;
  const authority =
    `${countyName} County CAD roll (cad_property) for county_fips ${countyFips}` +
    (year != null ? ` at declared tax_year ${year}` : " (no declared CAD tax year)");

  if (input.gateBlocked) {
    return {
      verdict: "lookup-failed",
      authority,
      scopeSearched:
        `conformant-v1 cad-parcel-roll claim.propertyUseCode; cad_property ` +
        `prop_id join REFUSED for county_fips ${countyFips} by the owner-match ` +
        `integrity gate; situs-address recovery ` +
        (input.situsRecoveryOffered ? "attempted" : "not supplied") +
        `; entitlement bound ${entitlement}`,
      asOf: nowIso,
      basis:
        `${parcelNodeId}: the prop_id land-use join is gate-blocked for county ` +
        `${countyFips}, and situs-address recovery ` +
        (input.situsRecoveryOffered
          ? "did not accept (owners disagree, blank owner, blank situs, or no address match)"
          : "was not supplied to the bake") +
        "; land use is unmeasured here, not verified absent",
    };
  }

  const scopeSearched =
    `conformant-v1 cad-parcel-roll claim.propertyUseCode; cad_property prop_id ` +
    `join key ${rollJoinKey ?? "unavailable"} at county_fips ${countyFips}` +
    (year != null ? ` tax_year ${year}` : "") +
    `; entitlement bound ${entitlement}`;

  if (rollJoinKey == null) {
    return {
      verdict: "lookup-failed",
      authority,
      scopeSearched,
      asOf: nowIso,
      basis:
        `${parcelNodeId}: claim.propertyUseCode is absent and no cad_property ` +
        `join key could be formed for apn ${apn ?? "unresolved"}, so the CAD ` +
        "roll was never consulted for this parcel",
    };
  }

  if (roll == null || !roll.consulted) {
    return {
      verdict: "lookup-failed",
      authority,
      scopeSearched,
      asOf: nowIso,
      basis:
        `${parcelNodeId}: claim.propertyUseCode is absent and the CAD roll for ` +
        `county ${countyFips} was not consulted (` +
        (roll == null
          ? "no roll was supplied to the bake"
          : "the county declares no CAD vintage, or cad_property is absent from this database") +
        `), so join key ${rollJoinKey} was never looked up`,
    };
  }

  return {
    verdict: "absent-verified",
    authority,
    scopeSearched,
    asOf: nowIso,
    basis:
      `${parcelNodeId}: claim.propertyUseCode is absent and the ${countyName} ` +
      `CAD roll${year != null ? ` at tax_year ${year}` : ""} carries no coded ` +
      `row for prop_id join key ${rollJoinKey} (${roll.byPropId.size} coded rows ` +
      `read for county_fips ${countyFips})`,
  };
}

const LAND_USE_ABSENCE_FIELDS = [
  "verdict",
  "authority",
  "scopeSearched",
  "asOf",
  "basis",
] as const;

const LAND_USE_ABSENCE_VERDICTS: ReadonlySet<string> = new Set([
  "absent-verified",
  "lookup-failed",
]);

/**
 * Refuse (throw, code LANDUSE_ABSENCE_UNEARNED) a payload whose land-use facet
 * and coverage flag do not agree, or whose null land use carries no earned
 * absence. This is the control that makes `landUse: null` +
 * `facetCoverage.landUse: false` — the live shape — a write refusal rather
 * than a silently under-counted facet. Verified by violation in
 * `../nodeFacetBakeTier1ConformantLandUse.test.ts`.
 */
export function assertLandUseAbsenceEarned(payload: unknown): void {
  const refuse = (why: string): never => {
    throw Object.assign(new Error(`land-use facet: ${why}`), {
      code: "LANDUSE_ABSENCE_UNEARNED",
    });
  };
  const rec = asRecord(payload);
  if (!rec) return refuse("payload is not an object");
  const baseFacts = asRecord(rec.baseFacts);
  const facetCoverage = asRecord(rec.facetCoverage);
  const provenance = asRecord(rec.provenance);
  if (!baseFacts || !facetCoverage || !provenance) {
    return refuse("baseFacts, facetCoverage and provenance are all required");
  }
  const parcelNodeId = typeof rec.parcelNodeId === "string" ? rec.parcelNodeId.trim() : "";
  if (!parcelNodeId) return refuse("parcelNodeId is required to check a per-parcel basis");
  const covered = facetCoverage.landUse;
  if (typeof covered !== "boolean") return refuse("facetCoverage.landUse must be a boolean");

  if (baseFacts.landUse != null) {
    if (covered !== true) {
      return refuse(`${parcelNodeId} projects a land use but scores facetCoverage.landUse false`);
    }
    if (provenance.landUseAbsence != null) {
      return refuse(`${parcelNodeId} projects a land use AND carries an absence record`);
    }
    return;
  }

  if (covered !== false) {
    return refuse(`${parcelNodeId} has a null land use but scores facetCoverage.landUse true`);
  }
  const absence = asRecord(provenance.landUseAbsence);
  if (!absence) {
    return refuse(
      `${parcelNodeId} has landUse null and facetCoverage.landUse false with no earned ` +
        "absence at provenance.landUseAbsence; a bare null is not an absent-verified",
    );
  }
  for (const field of LAND_USE_ABSENCE_FIELDS) {
    const v = absence[field];
    if (typeof v !== "string" || v.trim() === "") {
      return refuse(`provenance.landUseAbsence.${field} is missing or blank for ${parcelNodeId}`);
    }
  }
  if (!LAND_USE_ABSENCE_VERDICTS.has(absence.verdict as string)) {
    return refuse(
      `provenance.landUseAbsence.verdict is ${String(absence.verdict)}, not absent-verified or lookup-failed`,
    );
  }
  if (!(absence.basis as string).includes(parcelNodeId)) {
    return refuse(
      `provenance.landUseAbsence.basis does not name ${parcelNodeId}; a basis identical ` +
        "across parcels is a ceremony, not a justification",
    );
  }
}

// ---------------------------------------------------------------------------
// Owner guard (same predicate as the serve strip in brokerageNodeFacets).
// ---------------------------------------------------------------------------

function isOwnerIshKey(key: string): boolean {
  if (/^owner(?![a-z])/i.test(key) || /^owner[_A-Z]/.test(key)) return true;
  return /^(cad|gis|txgio)[_-]?owner/i.test(key);
}

function findOwnerKeyPath(value: unknown, prefix: string): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findOwnerKeyPath(value[i], `${prefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  const rec = asRecord(value);
  if (!rec) return null;
  for (const [k, v] of Object.entries(rec)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isOwnerIshKey(k)) return path;
    const hit = findOwnerKeyPath(v, path);
    if (hit) return hit;
  }
  return null;
}

/** Refuse (throw, code OWNER_KEY_IN_PAYLOAD) when any owner-shaped key exists at any depth. */
export function assertNoOwnerKey(payload: unknown): void {
  const hit = findOwnerKeyPath(payload, "");
  if (hit) {
    throw Object.assign(
      new Error(`owner-shaped key in baked payload at ${hit}; owner is never baked`),
      { code: "OWNER_KEY_IN_PAYLOAD" },
    );
  }
}

// ---------------------------------------------------------------------------
// Divergence instrument: old shape versus new shape as KEY PATHS.
// ---------------------------------------------------------------------------

/**
 * Leaf key paths of a JSON value. An object contributes its members' paths;
 * null and primitives are leaves; an array is one leaf (`path[]`); an empty
 * object is one leaf (`path{}`). `zoning: null` is therefore the path
 * `zoning`, and a stamped parcel's zoning is `zoning.district`, ... — so two
 * payloads built from the SAME inputs must produce the same set.
 */
export function leafKeyPaths(value: unknown, prefix = ""): Set<string> {
  const acc = new Set<string>();
  const visit = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      acc.add(`${p}[]`);
      return;
    }
    const rec = asRecord(v);
    if (rec) {
      const keys = Object.keys(rec);
      if (keys.length === 0) {
        acc.add(`${p}{}`);
        return;
      }
      for (const k of keys) visit(rec[k], p ? `${p}.${k}` : k);
      return;
    }
    acc.add(p);
  };
  visit(value, prefix);
  return acc;
}

/** Root keys the new shape carries that the old never did (named by the card). */
export const DIVERGENCE_IGNORE_NEW_SHAPE_KEYS: readonly string[] = [
  "shapeSource",
  "baked",
  "source",
  "access",
  "accessNormalizedFrom",
  "publishRunId",
];

/** Key-path prefixes the new shape deliberately ADDS (allowlist). */
export const DIVERGENCE_ALLOWLIST_NEW_SHAPE_PREFIXES: readonly string[] = [
  "facets.base",
  "facetCoverage.tier1",
  "provenance.parcelJoin",
  "provenance.landUseOrigin",
  "provenance.landUseAbsence",
  "baseFacts.cadRoll",
  "baseFacts.yearBuilt",
  "baseFacts.legalDescription",
  "baseFacts.exemptionCodes",
];

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`) || path.startsWith(`${prefix}{`);
}

/**
 * A new-shape path is tolerated when its root is ignored, when it sits under
 * an allowlisted prefix, or when it is itself an ANCESTOR of an allowlisted
 * prefix (the root `facets` exists only to hold `facets.base`). The strict
 * leaf diff still reports any leaf outside the prefix (e.g. `facets.other`).
 */
export function isIgnoredOrAllowedNewPath(path: string): boolean {
  const root = path.split(/[.[{]/)[0] ?? path;
  if (DIVERGENCE_IGNORE_NEW_SHAPE_KEYS.includes(root)) return true;
  return DIVERGENCE_ALLOWLIST_NEW_SHAPE_PREFIXES.some(
    (p) => underPrefix(path, p) || underPrefix(p, path),
  );
}

export interface KeyPathDiff {
  /** Old leaves absent from the new payload: the failure set. */
  missing: string[];
  /** New leaves neither in the old payload nor ignored/allowlisted. */
  unexpected: string[];
  oldLeafCount: number;
  newLeafCount: number;
}

/**
 * Strict leaf-level comparison for two payloads built from the same inputs
 * (the old CLI's `buildTier1Payload` and `buildConformantTier1Payload`).
 * Fails on any missing old leaf. Ignore/allowlist applies to the NEW side only.
 */
export function diffTier1KeyPaths(oldPayload: unknown, newPayload: unknown): KeyPathDiff {
  const oldLeaves = leafKeyPaths(oldPayload);
  const newLeaves = leafKeyPaths(newPayload);
  const missing = [...oldLeaves].filter((p) => !newLeaves.has(p)).sort();
  const unexpected = [...newLeaves]
    .filter((p) => !oldLeaves.has(p) && !isIgnoredOrAllowedNewPath(p))
    .sort();
  return {
    missing,
    unexpected,
    oldLeafCount: oldLeaves.size,
    newLeafCount: newLeaves.size,
  };
}

/**
 * The FACET-LEVEL contract for a served/stored Tier-1 row: every key path the
 * old bake carried for a parcel with NO stamp, NO ring and NO land-use, i.e.
 * the set where each facet is present as an explicit null. A real row
 * satisfies a path when the key EXISTS on its parent (value may be null or an
 * object). `nodeFacetBakeTier1Conformant.test.ts` asserts this list equals
 * the old CLI's leaf set on exactly that fixture, so it cannot drift from
 * the code.
 */
export const REQUIRED_TIER1_FACET_PATHS: readonly string[] = [
  "facetSchemaVersion",
  "tier",
  "parcelNodeId",
  "countyFips",
  "countyName",
  "baseFacts.apn",
  "baseFacts.situsAddress",
  "baseFacts.situsCity",
  "baseFacts.situsState",
  "baseFacts.situsZip",
  "baseFacts.landUse",
  "baseFacts.acreage",
  "baseFacts.cadRoll.marketValue",
  "baseFacts.cadRoll.assessedValue",
  "baseFacts.cadRoll.landValue",
  "baseFacts.cadRoll.improvementValue",
  "baseFacts.cadRoll.livingAreaSqft",
  "baseFacts.yearBuilt",
  "baseFacts.legalDescription",
  "baseFacts.exemptionCodes",
  "zoning",
  "envelope",
  "facetCoverage.baseFacts",
  "facetCoverage.landUse",
  "facetCoverage.acreage",
  "facetCoverage.zoning",
  "facetCoverage.envelope",
  "provenance.parcelSource",
  "provenance.parcelVintage",
  "provenance.landUseSource",
  "provenance.landUseAddressRecovered",
  "provenance.roadsPending",
  "provenance.tierNote",
  "provenance.landUseGateBlocked",
  "provenance.zoningSource",
  "bakedAt",
];

/** True when the dotted path's final key EXISTS on its parent object. */
export function hasKeyPath(value: unknown, path: string): boolean {
  const parts = path.split(".");
  let cur: unknown = value;
  for (let i = 0; i < parts.length; i++) {
    const rec = asRecord(cur);
    if (!rec || !Object.prototype.hasOwnProperty.call(rec, parts[i]!)) return false;
    cur = rec[parts[i]!];
  }
  return true;
}

export interface RequiredFacetDiff {
  missing: string[];
  present: number;
  required: number;
  /** Top-level keys not required, not ignored, not allowlisted. */
  unexpectedRoots: string[];
}

/** Facet-level check for a LIVE row (old rows differ per parcel, so leaves cannot be compared). */
export function diffAgainstRequiredFacetPaths(payload: unknown): RequiredFacetDiff {
  const missing = REQUIRED_TIER1_FACET_PATHS.filter((p) => !hasKeyPath(payload, p));
  const requiredRoots = new Set(REQUIRED_TIER1_FACET_PATHS.map((p) => p.split(".")[0]!));
  const rec = asRecord(payload) ?? {};
  const unexpectedRoots = Object.keys(rec)
    .filter((k) => !requiredRoots.has(k) && !isIgnoredOrAllowedNewPath(k))
    .sort();
  return {
    missing,
    present: REQUIRED_TIER1_FACET_PATHS.length - missing.length,
    required: REQUIRED_TIER1_FACET_PATHS.length,
    unexpectedRoots,
  };
}
