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
 *     propertyUseCode + tax year) plus situsState DERIVED from countyFips
 *     (CTX-situs, 2026-09-08) — cad_property has no situs_state column and
 *     the txgio parcel join's own situs_state is null or wrong often enough
 *     to block every county's publish (BP-CONTENT-01); the county FIPS state
 *     prefix is certain regardless of whether the join hit;
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
 * CELL STATES, NOT NULLS (P-124 CTX-LEAVES, 2026-09-08). "Absent is a state
 * the key carries" was true of the KEY and false of the VALUE: four leaves
 * this bake owns handed a required cell a bare `null` whenever their input was
 * missing, and `BP-CONTENT-01` says a present key holding null is none of
 * `value | absent-verified | not-applicable | refused`. Those four —
 * `baseFacts.situsCity`, `baseFacts.situsZip`, `baseFacts.landUse` and its
 * twin `provenance.landUseSource` — now carry an EARNED absence
 * (`Tier1LeafAbsence`), and `assertRequiredLeafStatesEarned` refuses the write
 * if any of them is ever a bare null again. `provenance.zoningSource` is NOT
 * among them: its state belongs to the zoning rail, which the SERVE earns, and
 * the twin is mirrored there — see the EARNED LEAF STATES block below.
 *
 * A SIXTH LEAF, A MISSED SIBLING (P-124 CTX-LEAVES2, 2026-09-10).
 * `baseFacts.acreage` handed a required cell the same bare `null` under the
 * same missing-input condition and was never added here when the machinery
 * above was built. It now carries an earned absence too, per-parcel decided
 * from whether the parcel-join geometry was genuinely checked — see
 * `buildAcreageAbsence` below the EARNED LEAF STATES block.
 *
 * A SEVENTH LEAF, AND THE ONE NOBODY GRADED (P-124 CTX-B6, 2026-09-10).
 * `baseFacts.situsAddress` is now the sixth entry in
 * `BAKE_OWNED_REQUIRED_LEAF_PATHS`. It got there the long way, and the route
 * is the finding:
 *
 *   - CTX-SITUS-SKIP (2026-09-09) taught this leaf to earn an absence, but
 *     ONLY when `assertSitusNotPunctuationOnly` refused the claim, and left
 *     it out of the owned set on the reasoning that a genuinely blank claim
 *     writing `situsAddress: null` was correct and untouched.
 *   - It was not correct. `null` is none of
 *     `value | absent-verified | not-applicable | refused`, the walk's
 *     BP-CONTENT-01 requires this leaf as a four-state, and Hays failed on
 *     exactly that. 22,805 rows across the six CTX counties carry the bare
 *     null (measured 2026-09-10, staging `place_layer_snapshots`).
 *   - Worse, `PUNCTUATION_ONLY_RE` only ever answered "is EVERY character
 *     punctuation". `", TX 78756"` is not, so it passed the guard and was
 *     served to a paying customer as their address on 146,494 Travis parcels
 *     and 696 McLennan ones, with `facetCoverage.baseFacts` true and a
 *     well-formed `absent-verified` sitting on `situsCity` right beside it.
 *
 * So this leaf now has THREE populations and THREE shapes, decided by the one
 * shared predicate `classifyRawSitusAddress` in `./serveGuards`:
 *
 *   claim carries an address with a street  -> the trimmed string
 *   claim carries nothing                   -> `claimLeafAbsence("situsAddress")`
 *   claim carries something with no street  -> `situsAddressUnusableAbsence`,
 *     which quotes the raw value verbatim and names WHICH way it was
 *     unusable (punctuation-only vs no-street-component), so the two stay
 *     tellable apart in the served payload.
 *
 * `null` is no longer reachable at this path, and
 * `assertRequiredLeafStatesEarned` refuses the write if it ever is again.
 * The one deliberate exception is a RETIRED record, whose situs is read
 * ungated by `situsForRetiredBake` (CTX-RETIRE) and may still be a string
 * with no street: that string is the account's LAST-KNOWN claim and the
 * retirement declaration beside it already says the payload is not current.
 * Caldwell `48055:1` is the regression control for that (CTX-B1 #650).
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
  situsStateFromCountyFips,
  type BaseFacts,
  type Tier1FacetPayload,
} from "./nodeFacetTier1Assemble";
import { cadPropertyFactsFromRow } from "./cadRollValue";
import type { ParcelJoinRow } from "./nodeFacetTier1ParcelJoin";
import { ptadLandUseDescription } from "./ptadLandUse";
import {
  isEarnedRecordRetirement,
  type Tier1RecordRetirement,
} from "./recordRetirement";
import { classifyRawSitusAddress, type SitusAddressUnusableReason } from "./serveGuards";

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
      /** The declared-vintage roll's own situs (CTX-B6). Optional so old callers still type-check. */
      situsAddress?: unknown;
    }
  >;
  declaredTaxYear: number | null;
  consulted: boolean;
}

// ---------------------------------------------------------------------------
// EARNED LEAF STATES (P-124 CTX-LEAVES, 2026-09-08).
//
// `BP-CONTENT-01` requires every REQUIRED tier-1 leaf to classify as one of
// `value | absent-verified | not-applicable | refused`, and states plainly
// that a present key holding null is NONE of those. Until this change four
// leaves this bake owns handed a bare null to a required cell whenever their
// input was missing — `baseFacts.situsCity`, `baseFacts.situsZip`,
// `baseFacts.landUse` and its twin `provenance.landUseSource`. Measured on
// staging 2026-09-08 that is 500,307 of 500,307 Travis parcels for land use
// and 363,797 for situs city; the walk's street-local sweep never sampled a
// jurisdiction where they varied, which is why they were invisible rather
// than new.
//
// The rule this module now follows: a leaf carries a VALUE, or it carries the
// EARNED ABSENCE that says who was asked, in what scope, when, and why THIS
// parcel has nothing. Never a bare null.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO.
//
// It does not decide `provenance.zoningSource`. That leaf is the top-level
// twin of the zoning cell, and the zoning cell's state is not knowable here:
// the bake writes `zoning: null` for an unstamped parcel and the SERVE earns
// the four-state, from the Factory's parcel_record zoningDistrict rail and
// the city-limits containment fact (`attachVerdictLayersToFacets`,
// `zoningVerdictFromCityLimits`). A verdict invented here would be a second
// answer to a question the rail answers later with more information — and on
// Elgin, whose layer is declared incomplete and whose unmatched parcels are
// therefore NOT verifiably unzoned, it would be the exact lie that passes
// every check. The twin is mirrored onto the rail at serve instead.
//
// It does not upgrade `lookup-failed` to `absent-verified`. A land-use
// absence the bake could not measure (gate-blocked county, no join key, roll
// never consulted) becomes `refused` — a positive statement of
// non-determination — and carries its original `lookupVerdict` so the two are
// never collapsed.
// ---------------------------------------------------------------------------

/**
 * The earned cell state of a required leaf that carries no value, in the
 * vocabulary `19_the_instrument_contract.md` requires and the Factory walk
 * grades (`classifyRequiredLeaf`): a verdict, the authority that was asked,
 * the scope it was asked in, an EVALUATION-time `asOf` (the bake clock, never
 * a request clock), and a basis naming THIS parcel — a basis identical across
 * parcels is a ceremony and `gradeAbsentVerifiedBasisDiversity` fails it.
 *
 * `status: "absent"` matches the `LayerAbsenceWire` shape the serve already
 * puts on `zoning` and `livingAreaSqft`, so a reader meets one shape.
 */
export interface Tier1LeafAbsence {
  status: "absent";
  verdict: "absent-verified" | "not-applicable" | "refused";
  authority: string;
  scopeSearched: string;
  asOf: string;
  basis: string;
  /**
   * Set when this cell's state is COPIED from another cell rather than
   * decided here, naming the cell it copies. A mirrored leaf cannot disagree
   * with the leaf it mirrors, which is the whole point of mirroring it.
   */
  mirrors?: string;
  /**
   * The un-collapsed upstream verdict when that verdict is not itself one of
   * the four states. Only `lookup-failed` reaches this today, on a `refused`
   * cell: we could not look, and that is not the same as looking and finding
   * nothing.
   */
  lookupVerdict?: "lookup-failed";
}

const LEAF_ABSENCE_VERDICTS: ReadonlySet<string> = new Set([
  "absent-verified",
  "not-applicable",
  "refused",
]);

/**
 * True for a WELL-FORMED earned absence. Every field is checked, because this
 * predicate is what the divergence instrument trusts when it accepts a leaf
 * that used to be a null — a half-built object must not buy that tolerance.
 */
export function isEarnedLeafAbsence(value: unknown): value is Tier1LeafAbsence {
  const rec = asRecord(value);
  if (!rec) return false;
  if (rec.status !== "absent") return false;
  if (typeof rec.verdict !== "string" || !LEAF_ABSENCE_VERDICTS.has(rec.verdict)) {
    return false;
  }
  for (const field of ["authority", "scopeSearched", "asOf", "basis"] as const) {
    const v = rec[field];
    if (typeof v !== "string" || v.trim() === "") return false;
  }
  return true;
}

/**
 * A land use that actually RESOLVED, as opposed to the earned absence that now
 * shares that key. Every consumer of `baseFacts.landUse` must narrow through
 * this rather than through `!= null`, which no longer means "has a land use".
 */
export function isResolvedLandUseFacet(
  value: unknown,
): value is NonNullable<BaseFacts["landUse"]> {
  const rec = asRecord(value);
  return !!rec && typeof rec.code === "string" && rec.code.trim() !== "";
}

/**
 * An acreage that actually RESOLVED (shoelace or claimed), as opposed to the
 * earned absence that now shares that key. Same narrowing discipline
 * `isResolvedLandUseFacet` established: `!= null` no longer means "has an
 * acreage" once `baseFacts.acreage` can also carry a `Tier1LeafAbsence`.
 */
export function isResolvedAcreageFacet(
  value: unknown,
): value is NonNullable<BaseFacts["acreage"]> {
  const rec = asRecord(value);
  return (
    !!rec &&
    typeof rec.value === "number" &&
    Number.isFinite(rec.value) &&
    typeof rec.sqft === "number" &&
    Number.isFinite(rec.sqft) &&
    typeof rec.method === "string"
  );
}

/**
 * A SIXTH LEAF (P-124 CTX-LEAVES2, 2026-09-10). `baseFacts.acreage` is a
 * MISSED SIBLING of the four above: it handed a required cell a bare null
 * under the exact same condition (input genuinely missing) and was never
 * added to `BAKE_OWNED_REQUIRED_LEAF_PATHS` when CTX-LEAVES built this
 * machinery. Measured live 2026-09-09/10: 291,231 of 1,516,110 baked cells
 * across the six CTX counties.
 *
 * Two independent sources feed acreage: the parcel-join geometry (the same
 * `row`/`provenance.parcelJoin` the ring comes from) and the claim's own
 * `landAcres` (read directly off the atom body — not a join that can miss,
 * same as `claimLeafAbsence`'s situsCity/situsZip). CTX-ACREAGE proposed
 * `absent-verified` on the reasoning that both were genuinely checked and
 * found unusable. That reasoning is only honest when the RING half was
 * actually checked: `firstRing(row.geometry)` returning null on a REAL row
 * is a genuine check; `row` itself being null (`no-row`, `gate-blocked`, or
 * `joined-situs` with no matched row) means geometry was never looked up at
 * all — the parcel join's own basis text says so verbatim ("geometry
 * unavailable" / "zoning stamp and geometry unavailable"), the same
 * lookup-failed shape `buildLandUseAbsence` already recognizes for a
 * gate-blocked or unconsulted land-use join.
 *
 * `buildAcreageAbsence` below decides this PER PARCEL from the real join
 * state, never by a blanket rule. Live-verified 2026-09-10 (read-only,
 * CORTEX_DATABASE_URL): every one of today's 291,231 null-acreage cells
 * carries `provenance.parcelJoin.state` of `no-row` or `gate-blocked` —
 * Bastrop/Caldwell/Travis 100% `no-row` (15,542 / 23,660 / 119,389), Hays/
 * Williamson 100% `gate-blocked` (41,619 / 91,021), McLennan zero. Zero rows
 * anywhere carry `joined`/`joined-situs` with a genuinely degenerate ring.
 * The verified-absence pair CTX-ACREAGE proposed is therefore NOT present for
 * a single row in today's population: `refused` is the honest state for all
 * 291,231, not because the code says so unconditionally, but because the
 * per-parcel check it runs never finds the ring-checked branch in real data.
 * A future row that DOES reach a real `joined` row with unusable geometry
 * still earns `absent-verified` correctly — proven able to fire in
 * `../nodeFacetBakeTier1Conformant.test.ts`.
 */
function buildAcreageAbsence(input: {
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  placement: "nested" | "flat";
  access: { discoverability: string; entitlement: string };
  /** True when a parcel-join row existed to examine (state `joined`/`joined-situs` with a matched row). */
  ringRowAvailable: boolean;
  claimLandAcres: number | null;
  nowIso: string;
}): Tier1LeafAbsence {
  const {
    parcelNodeId,
    countyFips,
    countyName,
    placement,
    ringRowAvailable,
    claimLandAcres,
    nowIso,
  } = input;
  const entitlement = `${input.access.discoverability}/${input.access.entitlement}`;
  const authority =
    `${countyName} County parcel-join geometry (see provenance.parcelJoin) and the ` +
    `conformant-v1 cad-parcel-roll claim for county_fips ${countyFips}`;
  const scopeSearched =
    `parcel-join geometry for ${parcelNodeId} (see provenance.parcelJoin); ` +
    `claim.landAcres on the cad-parcel-roll atom body (${placement} claim placement); ` +
    `entitlement bound ${entitlement}`;
  const claimText =
    claimLandAcres == null
      ? "the claim carries no landAcres"
      : `the claim's landAcres (${claimLandAcres}) is not a usable positive number`;

  if (!ringRowAvailable) {
    return {
      status: "absent",
      verdict: "refused",
      authority,
      scopeSearched,
      asOf: nowIso,
      basis:
        `${parcelNodeId}: no parcel-join row resolved (see provenance.parcelJoin.state), so ` +
        `geometry was never looked up for this parcel — unmeasured, not verified absent — and ` +
        claimText,
      lookupVerdict: "lookup-failed",
    };
  }

  return {
    status: "absent",
    verdict: "absent-verified",
    authority,
    scopeSearched,
    asOf: nowIso,
    basis:
      `${parcelNodeId}: the parcel-join row's geometry did not yield a usable ring, and ` +
      `${claimText} — both the ring and the claim were genuinely checked and carry nothing`,
  };
}

/**
 * The six leaves this bake owns the cell state of. `zoning`/`zoningSource`
 * are the serve's.
 *
 * `baseFacts.situsAddress` joined this list in CTX-B6 (2026-09-10). Read the
 * SEVENTH LEAF block at the top of this file for why it was out of it and
 * what admitting it costs: the bare-null population it makes unwritable is
 * 22,805 rows, which is why the blank-claim branch of `situsAddressLeaf` had
 * to be built in the same change. Adding a path here without giving its null
 * population a shape turns this control into a bake-wide refusal.
 *
 * THE GAP THIS LIST SITS IN, and it is bigger than any one leaf. Three lists
 * govern tier-1 content and only one of them fails a write:
 *
 *   `REQUIRED_TIER1_FACET_PATHS` (this file, 36 paths) -- PRESENCE predicate.
 *      Does the key exist. A key holding null satisfies it.
 *   hauska-factory `verify-walk.mjs` `REQUIRED_TIER1_FACET_PATHS` (28 paths)
 *      -- a HAND-COPIED mirror of the above, eight paths short, applying a
 *      FOUR-STATE predicate to the SERVED payload on a ~180-parcel sample.
 *   this list (6 paths) -- the FOUR-STATE predicate applied AT THE WRITE.
 *
 * Every leaf in the walk's list and not in this one is required by the grader
 * and owned by nobody at bake time; that difference is the mechanism behind
 * `situsCity`, `situsZip`, `landUse`, `landUseSource`, `acreage` and now
 * `situsAddress` each being found, one at a time, by a sampled walk. Growing
 * this list one leaf per lane is the symptom, not the cure; the cure is a
 * single source of truth the two repos both read, which this repo cannot
 * build alone. Filed as a leave-behind, not silently left.
 */
export const BAKE_OWNED_REQUIRED_LEAF_PATHS: readonly string[] = [
  "baseFacts.situsCity",
  "baseFacts.situsZip",
  "baseFacts.landUse",
  "provenance.landUseSource",
  "baseFacts.acreage",
  "baseFacts.situsAddress",
];

// ---------------------------------------------------------------------------
// RECORD RETIREMENT (P-124 CTX-RETIRE, 2026-09-09). An account absent from the
// county's CURRENT declared-vintage cad_property roll -- split, merged,
// renumbered or removed -- must serve a declared retirement that names why,
// never the prior vintage's snapshot presented as though it were current, and
// never a silent skip that leaves an even-older payload in place untouched.
//
// This is the SAME family as Tier1LeafAbsence one level up: a leaf says one
// field has no value and why; this says the WHOLE record is no longer on the
// roll and why. The predicate is built ONLY from `cadPropertyRoll` -- the
// same declared-vintage `cad_property` read this bake already does for the
// dollar facets, ALL rows at that vintage, not filtered to a use code -- so a
// prop_id present in the current roll can never earn this state. It does not
// depend on situs shape, acreage, or any other heuristic.
// ---------------------------------------------------------------------------

/**
 * A RECORD-LEVEL retirement declaration. `null` for a record that IS on the
 * current declared-vintage roll; a well-formed `Tier1RecordRetirement` for
 * one that is not. Present on every conformant payload (never an omitted
 * key) so a reader following an old link gets an answer, not a void -- the
 * rest of the payload still carries the account's LAST-KNOWN claim content,
 * unmodified; this field is the thing that says it is not current.
 *
 * Defined in `./recordRetirement` (CTX-B1) so a light consumer like
 * serveGuards.ts does not have to pull in this module's heavy import chain;
 * re-exported here unchanged so every existing importer of this module is
 * unaffected.
 */
export { isEarnedRecordRetirement, type Tier1RecordRetirement } from "./recordRetirement";

/**
 * Build the retirement declaration. The basis names THIS parcel, the county,
 * the declared vintage that was checked, and the last vintage the record's
 * own claim carried -- never a basis identical across parcels (that is a
 * ceremony, not a justification, the same rule `buildLandUseAbsence` follows).
 * It deliberately says NO successor is named: this mission's own successor
 * search (crosswalk + geometry) came back negative, and fabricating one would
 * be worse than naming none.
 */
function buildRecordRetirement(input: {
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  apn: string;
  declaredTaxYear: number | null;
  lastSeenTaxYear: number | null;
  nowIso: string;
}): Tier1RecordRetirement {
  const {
    parcelNodeId,
    countyFips,
    countyName,
    apn,
    declaredTaxYear,
    lastSeenTaxYear,
    nowIso,
  } = input;
  return {
    status: "retired",
    verdict: "absent-verified",
    authority:
      `${countyName} County CAD roll (cad_property) for county_fips ${countyFips}` +
      (declaredTaxYear != null
        ? ` at declared tax_year ${declaredTaxYear}`
        : " (no declared CAD tax year)"),
    scopeSearched:
      `cad_property, ALL rows (not filtered to a use code), county_fips ${countyFips}` +
      (declaredTaxYear != null ? ` tax_year ${declaredTaxYear}` : ""),
    asOf: nowIso,
    basis:
      `${parcelNodeId}: prop_id ${apn} carries no row in the ${countyName} County ` +
      `CAD roll's declared tax_year ${declaredTaxYear ?? "unknown"}` +
      (lastSeenTaxYear != null
        ? `; this record's own claim last carried tax_year ${lastSeenTaxYear}`
        : "") +
      `. This account is not on the current roll -- split, merged, renumbered ` +
      `or removed; no successor account has been verified. The facts elsewhere ` +
      `on this payload are the LAST-KNOWN claim, not current.`,
    lastSeenTaxYear,
  };
}

export interface ConformantBaseFacts
  extends Omit<
    BaseFacts,
    "situsCity" | "situsZip" | "landUse" | "situsAddress" | "acreage"
  > {
  situsCity: string | Tier1LeafAbsence;
  situsZip: string | Tier1LeafAbsence;
  landUse: NonNullable<BaseFacts["landUse"]> | Tier1LeafAbsence;
  /** A resolved acreage, or the earned absence (CTX-LEAVES2) when neither the ring nor the claim carries one. */
  acreage: NonNullable<BaseFacts["acreage"]> | Tier1LeafAbsence;
  /**
   * `string` when the claim carries an address with a street component (and,
   * for a RETIRED record only, whatever the last-known claim carried, read
   * ungated by `situsForRetiredBake`); otherwise an EARNED absence.
   *
   * `null` is NOT in this union any more (CTX-B6, 2026-09-10). Both null
   * populations now earn an absence: a claim carrying nothing gets
   * `claimLeafAbsence("situsAddress")`, and a claim carrying something with
   * no street gets `situsAddressUnusableAbsence` with the raw value quoted.
   * `assertRequiredLeafStatesEarned` refuses the write on a bare null here.
   */
  situsAddress: string | Tier1LeafAbsence;
}

export interface ConformantTier1Payload extends Omit<
  Tier1FacetPayload,
  "facetCoverage" | "provenance" | "baseFacts"
> {
  baseFacts: ConformantBaseFacts;
  shapeSource: typeof CONFORMANT_SHAPE_SOURCE;
  baked: true;
  source: typeof CONFORMANT_TIER1_SOURCE;
  access: { discoverability: string; entitlement: string };
  accessNormalizedFrom?: string;
  publishRunId?: string;
  /** Record-level declared retirement; see the RECORD RETIREMENT block above. */
  recordRetirement: Tier1RecordRetirement | null;
  facets: {
    base: { parcelNodeId: string; situsAddress: string | null; apn: string | null };
  };
  facetCoverage: Tier1FacetPayload["facetCoverage"] & { tier1: "populated" };
  provenance: Omit<Tier1FacetPayload["provenance"], "landUseSource"> & {
    /**
     * The source enum when a land use resolved; otherwise a VERBATIM mirror of
     * `baseFacts.landUse`'s earned absence. Never a bare null: the two are one
     * cell asked twice and must not be able to answer differently.
     */
    landUseSource: Tier1FacetPayload["provenance"]["landUseSource"] | Tier1LeafAbsence;
    parcelJoin: ParcelJoinRecord;
    /** Which upstream supplied the land use; null when none did. */
    landUseOrigin: LandUseOrigin | null;
    /**
     * Which upstream supplied `baseFacts.situsAddress` (CTX-B6). Never null:
     * `"none"` is the state when the leaf holds an earned absence. This exists
     * because the payload used to mix vintages across leaves silently -- the
     * dollars at the declared vintage, the situs at the claim's -- and nothing
     * in the payload said which leaf came from where.
     */
    situsAddressSource: SitusAddressOrigin;
    /**
     * The claim's situs that the declared roll overrode, when the two differed;
     * null otherwise. Makes the upgrade auditable rather than invisible after a
     * re-bake.
     */
    situsAddressSupersededClaim: string | null;
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
  /**
   * The situs the rest of the payload is built from: a claim address that
   * `classifyRawSitusAddress` returned `usable`, or a retired record's
   * ungated last-known value. `null` whenever the claim was blank or
   * unusable -- it must never reach `facets.base.situsAddress`, the address
   * join key, or the serve guard.
   */
  situsAddress: string | null;
  /**
   * Set ONLY when the on-roll claim carried SOMETHING that
   * `classifyRawSitusAddress` refused. `raw` is verbatim (quoted in the
   * absence basis, never paraphrased) and `reason` says which way it was
   * unusable.
   *
   * CTX-SITUS-SKIP (2026-09-09) introduced this as
   * `situsAddressPunctuationOnlyRaw`, a bare string carrying one reason
   * implicitly in its name. CTX-B6 (2026-09-10) widened the population to
   * street-less strings, so the reason had to become a value rather than a
   * field name -- otherwise the served basis could not say which of the two
   * shapes a given parcel hit. `undefined`/`null` for a usable address AND
   * for a claim carrying nothing at all: those two must stay tellable apart
   * from each other and from this one, which is why this is a distinct field
   * rather than a sentinel on `situsAddress`.
   */
  situsAddressUnusable?: { raw: string; reason: SitusAddressUnusableReason } | null;
  /**
   * WHERE `situsAddress` came from (CTX-B6 reopened, 2026-09-10). Written
   * verbatim to `provenance.situsAddressSource`. Defaults to `"claim"` when a
   * caller omits it, which is what every pre-CTX-B6 caller meant.
   */
  situsAddressOrigin?: SitusAddressOrigin;
  /**
   * The claim value the declared roll overrode, when they differ. Written to
   * `provenance.situsAddressSupersededClaim`. Null on every other origin.
   */
  situsAddressSupersededClaim?: string | null;
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
   *
   * CTX-RETIRE (2026-09-09): this is also the ONLY input `recordRetirement`
   * reads. `byPropId` holds ALL rows at the declared vintage (not filtered to
   * a use code), so a miss here is a positive statement that the prop_id is
   * absent from the county's current roll, not merely lacking one field.
   * OMITTING this input (or an undeclared/unconsulted county) means
   * `recordRetirement` stays null -- no positive determination, no
   * retirement, same "empty is not an absence" discipline as everywhere else
   * in this module.
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

  // RECORD RETIREMENT: the declared-vintage cad_property roll was consulted
  // (not merely absent/undeclared) AND carries no row at all for this prop_id
  // -- not "no coded row", ALL rows, the same table the dollar facets already
  // read. A prop_id present in the current roll can never reach this branch.
  const recordRetirement: Tier1RecordRetirement | null =
    apn != null && cadPropConsulted && cadPropRow == null
      ? buildRecordRetirement({
          parcelNodeId,
          countyFips,
          countyName,
          apn,
          declaredTaxYear: input.cadPropertyRoll?.declaredTaxYear ?? null,
          lastSeenTaxYear: claim.taxYear,
          nowIso,
        })
      : null;

  const tier1 = assembleTier1Payload({
    nodeId: parcelNodeId,
    countyFips,
    countyName,
    facetSchemaVersion: TIER1_CONFORMANT_FACET_SCHEMA_VERSION,
    apn,
    situsAddress: input.situsAddress,
    situsCity: claim.situsCity,
    situsState: situsStateFromCountyFips(countyFips),
    situsStateSource: "derived-county-fips",
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
    // READ THIS BEFORE USING IT AS A VINTAGE. `provenance.parcelVintage` is
    // the CLAIM's taxYear and nothing else. It is NOT the county's declared
    // CAD vintage (that is `tryResolveDeclaredCadVintage`, and it is what the
    // cadRoll dollars, yearBuilt, legalDescription and exemptionCodes report),
    // and it is NOT the TxGIO parcel-join vintage (that is
    // `provenance.parcelJoin.sourceVintage`). On Travis the claim says 2025
    // while the declared vintage is 2026, and CTX-B6's first pass misread this
    // field as the declared vintage and concluded from it that the stale situs
    // was correct-by-declaration. It was not; 139,256 Travis parcels had a
    // real street in the declared roll. Three different vintages live on this
    // payload and this key names only one of them.
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

  // --- Earned cell states for the four leaves this bake owns ---------------
  // AFTER assembly, never before: `assembleTier1Payload` reads
  // `baseFacts.situsCity` internally for `resolveZoningJurisdiction` and
  // `computeTier1Envelope`, and both must keep seeing a plain string-or-null.
  // The shared assembler, and therefore the legacy bake that also calls it,
  // are untouched by this.
  const { placement } = conformantClaimRecord(input.body);
  const claimAbsence = (field: ClaimAbsenceField): Tier1LeafAbsence =>
    claimLeafAbsence({
      parcelNodeId,
      countyFips,
      countyName,
      field,
      placement,
      access: input.access,
      nowIso,
    });
  const landUseLeaf: ConformantBaseFacts["landUse"] =
    tier1.baseFacts.landUse ??
    leafAbsenceFromLandUseAbsence(landUseAbsence as LandUseAbsence, parcelNodeId);
  const landUseSourceLeaf =
    tier1.baseFacts.landUse != null
      ? tier1.provenance.landUseSource
      : // VERBATIM mirror, basis byte-identical, so the twin cannot state
        // anything the leaf it mirrors does not state.
        { ...(landUseLeaf as Tier1LeafAbsence), mirrors: "baseFacts.landUse" };
  // `assembleTier1Payload` was called with `input.situsAddress`, which is
  // already null for BOTH null populations (see the call above), so
  // `tier1.baseFacts.situsAddress` cannot tell them apart on its own.
  // `input.situsAddressUnusable` is the discriminator the CLI threads through:
  // set means the claim carried something and it was refused; unset means the
  // claim carried nothing.
  //
  // CTX-B6 (2026-09-10): the second branch is NEW. Until this change it was
  // `: null`, and that bare null was the state 22,805 rows in the six CTX
  // counties served -- required by BP-CONTENT-01 as a four-state, owned by
  // nobody at bake time, and the exact thing Hays's walk failed on. There is
  // no third outcome now: every path out of this expression is a string or a
  // well-formed `Tier1LeafAbsence`.
  const situsAddressLeaf: ConformantBaseFacts["situsAddress"] =
    tier1.baseFacts.situsAddress ??
    (input.situsAddressUnusable != null
      ? situsAddressUnusableAbsence({
          parcelNodeId,
          countyFips,
          countyName,
          placement,
          access: input.access,
          rawValue: input.situsAddressUnusable.raw,
          reason: input.situsAddressUnusable.reason,
          nowIso,
        })
      : claimAbsence("situsAddress"));
  // CTX-LEAVES2: `row` reflects whether a parcel-join geometry source was
  // actually available (non-null on `joined`/accepted `joined-situs`, null on
  // `no-row`/`gate-blocked`/an unmatched situs recovery) -- the same variable
  // `ring` above is derived from, so this asks exactly "was the ring genuinely
  // checked" rather than re-deriving that from `parcelJoin.state` text.
  const acreageLeaf: ConformantBaseFacts["acreage"] =
    tier1.baseFacts.acreage ??
    buildAcreageAbsence({
      parcelNodeId,
      countyFips,
      countyName,
      placement,
      access: input.access,
      ringRowAvailable: row != null,
      claimLandAcres: claim.landAcres,
      nowIso,
    });

  const { facetCoverage, provenance, baseFacts: assembledBaseFacts, ...rest } = tier1;
  const baseFacts: ConformantBaseFacts = {
    ...assembledBaseFacts,
    situsAddress: situsAddressLeaf,
    situsCity: assembledBaseFacts.situsCity ?? claimAbsence("situsCity"),
    situsZip: assembledBaseFacts.situsZip ?? claimAbsence("situsZip"),
    landUse: landUseLeaf,
    acreage: acreageLeaf,
  };
  const payload: ConformantTier1Payload = {
    shapeSource: CONFORMANT_SHAPE_SOURCE,
    baked: true,
    source: CONFORMANT_TIER1_SOURCE,
    access: input.access,
    recordRetirement,
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
    baseFacts,
    facetCoverage: { ...facetCoverage, tier1: "populated" },
    provenance: {
      ...provenance,
      situsAddressSource: input.situsAddressOrigin ?? "claim",
      situsAddressSupersededClaim: input.situsAddressSupersededClaim ?? null,
      landUseSource: landUseSourceLeaf,
      parcelJoin,
      landUseOrigin,
      landUseAbsence,
    },
  };
  // Fail closed at the builder as well as at the write: a null land use that
  // reaches a payload without an earned absence never leaves this function.
  assertLandUseAbsenceEarned(payload);
  // ... and neither does a bare null at any leaf this bake owns the state of.
  assertRequiredLeafStatesEarned(payload);
  // CTX-SITUS-SKIP: nor does a punctuation-only situs refusal reach a payload
  // as anything but a well-formed earned absence.
  assertSitusAddressAbsenceEarned(payload);
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

/**
 * The land-use LEAF state from the absence record the bake already earned.
 *
 * This mints no new claim: `buildLandUseAbsence` above decided the verdict,
 * named the authority, the scope and the per-parcel basis, and stamped the
 * bake clock. All this does is put that earned record at the cell whose state
 * it describes, instead of leaving the cell a bare null with the explanation
 * filed one level away in `provenance`.
 *
 * `lookup-failed` is NOT one of the four states and is not quietly turned
 * into one: it becomes `refused` — we could not determine this — and keeps
 * `lookupVerdict` so a reader can still tell "could not look" from "looked
 * and found nothing". It is never `absent-verified`, which is the upgrade
 * `assertNoVerdictUpgrade` forbids everywhere else in this codebase.
 */
export function leafAbsenceFromLandUseAbsence(
  absence: LandUseAbsence,
  parcelNodeId: string,
): Tier1LeafAbsence {
  const common = {
    status: "absent" as const,
    authority: absence.authority,
    scopeSearched: absence.scopeSearched,
    asOf: absence.asOf,
    basis: absence.basis,
  };
  if (absence.verdict === "absent-verified") {
    return { ...common, verdict: "absent-verified" };
  }
  return { ...common, verdict: "refused", lookupVerdict: "lookup-failed" };
}

/** Human label for a claim field, used only inside a basis string. */
/** The claim-carried situs fields whose blank case earns an absence here. */
export type ClaimAbsenceField = "situsCity" | "situsZip" | "situsAddress";

const CLAIM_FIELD_LABEL: Record<ClaimAbsenceField, string> = {
  situsCity: "situs city",
  situsZip: "situs ZIP",
  // CTX-B6: the label a reader sees on the served absence. "street address"
  // rather than "address", because `situsZip` on the same parcel may well be
  // populated and this leaf must not read as a claim that the parcel has no
  // location on record.
  situsAddress: "situs street address",
};

/**
 * The earned absence for a situs field the CAD claim carries.
 *
 * `absent-verified` is honest here and needs no `lookup-failed` counterpart,
 * because the claim is not a JOIN that can miss — it is the atom body this
 * bake is projecting FROM, so it is always read, for every parcel, by
 * construction.
 *
 * THE PRECISION THAT MATTERS. This asserts an absence of the CAD-CARRIED
 * field, not an absence of the fact. The leaf's own contract (see
 * `BaseFacts.situsZip`) is "as the source carries it" — a postal fact, never
 * read as incorporation, which the serve derives from city-limits
 * containment instead. So the scope names `claim.<field>` and the basis says
 * in words that the parcel is not being claimed to have no city. Travis
 * leaves `situs_city` null on most of its roll; those parcels are in Austin,
 * and nothing here says otherwise.
 */
export function claimLeafAbsence(input: {
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  field: ClaimAbsenceField;
  placement: "nested" | "flat";
  access: { discoverability: string; entitlement: string };
  nowIso: string;
}): Tier1LeafAbsence {
  const { parcelNodeId, countyFips, countyName, field, placement, nowIso } = input;
  const label = CLAIM_FIELD_LABEL[field];
  return {
    status: "absent",
    verdict: "absent-verified",
    authority:
      `${countyName} County CAD roll as published in the conformant-v1 ` +
      `cad-parcel-roll claim for county_fips ${countyFips}`,
    scopeSearched:
      `claim.${field} on the cad-parcel-roll atom body for ${parcelNodeId} ` +
      `(${placement} claim placement); entitlement bound ` +
      `${input.access.discoverability}/${input.access.entitlement}`,
    asOf: nowIso,
    basis:
      `${parcelNodeId}: the cad-parcel-roll claim for this parcel was read and ` +
      `carries no ${field}. This is a verified absence of the CAD-carried ` +
      `${label}, not a finding that the parcel has none`,
  };
}

// ---------------------------------------------------------------------------
// SITUS ADDRESS, punctuation-only (P-124 CTX-SITUS-SKIP, 2026-09-09).
//
// CTX-PROV located the mechanism: an on-roll account whose CAD claim's raw
// situsAddress is punctuation-only (matches serveGuards.ts's
// PUNCTUATION_ONLY_RE, e.g. `", ,"`) was silently skipped by the bake's
// per-row loop -- `continue` fired before any write, so the row stayed frozen
// on whatever pre-conformant snapshot it last held, forever. 18,037 rows
// across Bastrop/Hays/McLennan, live-counted 2026-09-09.
//
// LINEAGE (verified live against staging cad_property 2026-09-09, read-only,
// declared-vintage rows only, matching what this bake actually reads): the
// defect is 100% confined to rows whose source_file is a StratMap
// land-parcels drop (`stratmap*-landparcels_*_lp.zip`). Bastrop's declared
// vintage (tax_year 2025) blends 62,257 StratMap-sourced rows with 15,542
// genuine-CAD-export rows in the SAME table/year; every one of its 16,104
// punctuation-only rows is StratMap-sourced, and every one of its 15,542
// genuine-CAD-export rows carries a usable situs (0 punctuation-only). Travis
// and Williamson sit at exactly zero because their declared-vintage tables
// carry NO StratMap rows at all -- not because PACS/Orion format differs
// (Bastrop and Travis are both `pacs`; only Bastrop carries the StratMap
// admixture). McLennan's declared tier is `stratmap-roll` outright (its whole
// table is StratMap-sourced) and still measures only 1.02% punctuation-only,
// so StratMap sourcing is necessary but not sufficient -- most StratMap rows
// DO carry a usable situs; a minority do not. `situs_city`/`situs_zip` are
// ALSO null for 100% of the punctuation-only rows sampled (0 of 16,104 in
// Bastrop, 0 of 1,165 in McLennan carry either) -- they are not
// independently available for this population, so no absence written here
// claims otherwise; `claimAbsence("situsCity"/"situsZip")` above already
// earns their own absence from the same null claim fields, unrelated to this
// function. This is a finding about the upstream StratMap ingest, not a
// defect in this guard or this bake; no fix to the ingest is made here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHICH SOURCE THE SITUS COMES FROM (P-124 CTX-B6, 2026-09-10, reopened).
//
// THE DEFECT IS IN THE READ, NOT IN AN ASSEMBLER. Nothing in this repo
// composes an address string -- that finding stands. What was missed is that
// ONE PAYLOAD CARRIES TWO VINTAGES. The dollar facets come from
// `cadPropertyRoll`, which `fetchCountyCadPropertyRoll` filters to
// `tax_year = <declared>`. The situs came from the cad-parcel-roll ATOM
// CLAIM, which carries whatever vintage the Factory staged. For Travis those
// are different years and the claim is the stale one.
//
// Live, 48453:224793, one stored row, read 2026-09-10:
//     marketValue   { v: 1238899, vintage: "2026", valueBasis: "county-assessed" }
//     landUse       vintage 2026 preliminary appraisal export
//     situsAddress  ", TX 78756"          <- the 2025 StratMap drop
//     provenance.parcelVintage "2025"     <- and this is the CLAIM's taxYear
//                                            (see the assembleTier1Payload call
//                                            below), so the payload was already
//                                            SAYING its situs was a year behind
//                                            its dollars. Nobody read it.
// `cad_property` for that prop_id at the declared 2026 vintage carries
// "4709 SHOALWOOD AVE".
//
// MEASURED PAYOFF, full scan of the staging store 2026-09-10, per county
// against each county's OWN declared vintage (48021 and 48309 are declared
// 2025; 48055, 48209, 48453 and 48491 are declared 2026):
//
//     county           served street-less   recoverable from declared roll
//     48453 Travis            146,494              139,256   (95.1%)
//     48309 McLennan              696                    0
//     48021 Bastrop                 9                    0
//     48055 Caldwell               63                    0   (all 63 retired)
//     48209 Hays                  768                    0   (all 768 retired)
//   and in the BARE-NULL population, which the same rule covers:
//     48209 Hays                2,973                   27
//
// So 139,283 of the 170,835 defective cells hold a real street in the roll
// this payload's dollars already came from. Writing an earned absence over
// them is exactly what ruling A1 forbids -- converting usable data into an
// absence -- and it would have been done at scale by a control built to be
// honest. The remaining 31,552 are genuinely absent and the absence machinery
// below is right for them.
//
// THE RULE. Prefer the declared-vintage roll, then the claim, then earn an
// absence. The roll wins even over a usable claim, because the roll is the
// vintage this payload's dollars, land use, year built, legal description and
// exemption codes already report; a payload that mixes vintages across leaves
// is the defect, and preferring the roll is what makes it single-vintage.
//
// The one exception is a RETIRED record, which by CTX-RETIRE has no row in
// the declared roll at all and must keep serving its last-known claim
// ungated. That branch is reached first and is untouched.
// ---------------------------------------------------------------------------

/** Where `baseFacts.situsAddress` came from. Recorded on `provenance.situsAddressSource`. */
export type SitusAddressOrigin =
  /** `cad_property` at the county's declared tax_year -- the same row the dollars come from. */
  | "declared-roll"
  /** The cad-parcel-roll atom claim, because the declared roll carried nothing usable. */
  | "claim"
  /** A roll-absent (retired) record's last-known claim, read ungated per CTX-RETIRE. */
  | "retired-claim"
  /** Neither source carried a usable address; the leaf holds an earned absence. */
  | "none";

export interface ResolvedSitusAddress {
  /** The value the payload is built from. Null whenever the leaf earns an absence. */
  situs: string | null;
  origin: SitusAddressOrigin;
  /** Set only when something was READ and REFUSED, so the absence can quote it. */
  unusable: { raw: string; reason: SitusAddressUnusableReason } | null;
  /**
   * The claim value the declared roll overrode, when the two differ. Non-null
   * ONLY on `declared-roll`. It is what makes the upgrade auditable: a reader
   * can see that this parcel used to serve a different string and which source
   * replaced it, rather than the change being invisible after a re-bake.
   */
  supersededClaimValue: string | null;
}

/**
 * Decide the situs and say where it came from. PURE -- the caller supplies the
 * declared-roll row it ALREADY loaded for the dollar facets, so this adds no
 * query; only one column had to be added to that existing SELECT
 * (`joinIntegrityGate.ts` `fetchCountyCadPropertyRoll`).
 *
 * Every branch is proven in `../nodeFacetBakeTier1Conformant.test.ts`,
 * including that the retired branch is reached BEFORE any preference logic.
 */
export function resolveConformantSitusAddress(input: {
  /** `claim.situsAddress`, verbatim and untrimmed. */
  claimRaw: string | null | undefined;
  /** `cad_property.situs_address` at the county's DECLARED tax_year, or null when no row. */
  rollRaw: string | null | undefined;
  /** True when the prop_id has no row at all in the declared roll (CTX-RETIRE). */
  rollAbsent: boolean;
}): ResolvedSitusAddress {
  // RETIRED FIRST, and unconditionally. A retirement declaration must not be
  // gated by data quality (CTX-RETIRE), and by construction there is no
  // declared-roll row to prefer.
  if (input.rollAbsent) {
    const raw = input.claimRaw == null ? null : String(input.claimRaw).trim();
    return {
      situs: raw === "" ? null : raw,
      origin: "retired-claim",
      unusable: null,
      supersededClaimValue: null,
    };
  }

  const roll = classifyRawSitusAddress(input.rollRaw);
  const claim = classifyRawSitusAddress(input.claimRaw);

  if (roll.kind === "usable") {
    return {
      situs: roll.value,
      origin: "declared-roll",
      unusable: null,
      // Only when the claim actually said something ELSE. A claim that agreed,
      // or carried nothing, supersedes nothing and records nothing.
      supersededClaimValue:
        claim.kind === "usable" && claim.value !== roll.value
          ? claim.value
          : claim.kind === "unusable"
            ? claim.raw
            : null,
    };
  }

  if (claim.kind === "usable") {
    return {
      situs: claim.value,
      origin: "claim",
      unusable: null,
      supersededClaimValue: null,
    };
  }

  // Neither carried a usable address. Quote whichever source carried
  // SOMETHING, preferring the declared roll: it is the authority this payload
  // otherwise reports, so its refusal is the one worth showing.
  const unusable =
    roll.kind === "unusable"
      ? { raw: roll.raw, reason: roll.reason }
      : claim.kind === "unusable"
        ? { raw: claim.raw, reason: claim.reason }
        : null;
  return { situs: null, origin: "none", unusable, supersededClaimValue: null };
}

/**
 * The earned absence for an on-roll claim's situsAddress when
 * `classifyRawSitusAddress` refused the raw value. Unlike `claimLeafAbsence`
 * above (which fires whenever the claim carries NOTHING), this fires only for
 * a claim that carried SOMETHING and it was refused as unusable -- so the raw
 * offending value is quoted verbatim in the basis rather than paraphrased,
 * and the scope names the predicate by its exact rule so a reader can
 * reproduce the refusal.
 *
 * `reason` is carried, not flattened. `punctuation-only` and
 * `no-street-component` are two different upstream facts -- a claim of `", ,"`
 * says the roll row is a placeholder, a claim of `", TX 78756"` says the roll
 * row has a real ZIP and lost its street -- and a served basis that could not
 * distinguish them would be a ceremony. CTX-B6 added the second; CTX-SITUS-SKIP
 * (2026-09-09) shipped the first as `situsAddressPunctuationOnlyAbsence`,
 * which this replaces.
 *
 * `absent-verified` for the same reason `claimLeafAbsence` uses it: the claim
 * is not a join that can miss, it is the record this bake projects from, read
 * for every parcel by construction. Never fabricated, never inferred from
 * geometry or a neighbour -- the raw value is quoted, not replaced, and no
 * sibling leaf is touched (ruling A1: a ZIP that is really on record stays on
 * `baseFacts.situsZip`).
 */
export function situsAddressUnusableAbsence(input: {
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  placement: "nested" | "flat";
  access: { discoverability: string; entitlement: string };
  rawValue: string;
  reason: SitusAddressUnusableReason;
  nowIso: string;
}): Tier1LeafAbsence {
  const { parcelNodeId, countyFips, countyName, placement, rawValue, reason, nowIso } =
    input;
  const rule =
    reason === "punctuation-only"
      ? "assertSitusNotPunctuationOnly (serveGuards.ts PUNCTUATION_ONLY_RE)"
      : "situsCarriesStreetComponent (serveGuards.ts: the segment before the " +
        "first comma holds no alphanumeric character)";
  const finding =
    reason === "punctuation-only"
      ? `is punctuation-only (${JSON.stringify(rawValue)}) and carries no usable address content`
      : `carries no street component (${JSON.stringify(rawValue)}): everything ` +
        "before its first comma is empty or punctuation, so what remains is a " +
        "locality, state or ZIP fragment and not an address";
  return {
    status: "absent",
    verdict: "absent-verified",
    authority:
      `${countyName} County CAD roll as published in the conformant-v1 ` +
      `cad-parcel-roll claim for county_fips ${countyFips}`,
    scopeSearched:
      `claim.situsAddress on the cad-parcel-roll atom body for ${parcelNodeId} ` +
      `(${placement} claim placement), classified by classifyRawSitusAddress ` +
      `and refused by ${rule}; entitlement bound ` +
      `${input.access.discoverability}/${input.access.entitlement}`,
    asOf: nowIso,
    basis:
      `${parcelNodeId}: the cad-parcel-roll claim's situsAddress ${finding}. ` +
      "The claim field was read and is present, not blank -- this is a " +
      "verified absence of a USABLE CAD-carried address, not a finding that " +
      "the parcel has no address, and any situs city or ZIP this parcel does " +
      "carry is unaffected and stays on its own leaf",
  };
}

/**
 * Refuse (throw, code REQUIRED_LEAF_BARE_NULL) a conformant payload where any
 * leaf this bake owns the cell state of is a bare null.
 *
 * This is the control that makes the defect a WRITE REFUSAL rather than
 * something a verify walk discovers on a served row days later — which is
 * exactly how these four leaves survived: they were only measurable once the
 * walk gained a jurisdiction-stratified cohort. Proven able to FIRE in
 * `../nodeFacetBakeTier1Conformant.test.ts`; a check observed only passing
 * has not been observed working.
 *
 * `zoning` and `provenance.zoningSource` are deliberately NOT in scope here.
 * Their state is earned at serve, from the rail, and asserting a four-state
 * on them at bake time would demand something the bake cannot know.
 */
export function assertRequiredLeafStatesEarned(payload: unknown): void {
  const refuse = (why: string): never => {
    throw Object.assign(new Error(`required tier-1 leaf: ${why}`), {
      code: "REQUIRED_LEAF_BARE_NULL",
    });
  };
  const rec = asRecord(payload);
  if (!rec) return refuse("payload is not an object");
  const parcelNodeId =
    typeof rec.parcelNodeId === "string" ? rec.parcelNodeId.trim() : "";
  if (!parcelNodeId) return refuse("parcelNodeId is required to name the parcel");
  for (const path of BAKE_OWNED_REQUIRED_LEAF_PATHS) {
    const [parentKey, leafKey] = path.split(".") as [string, string];
    const parent = asRecord(rec[parentKey]);
    if (!parent || !Object.prototype.hasOwnProperty.call(parent, leafKey)) {
      return refuse(`${parcelNodeId} is missing the key ${path} entirely`);
    }
    const value = parent[leafKey];
    if (value === null || value === undefined) {
      return refuse(
        `${parcelNodeId} carries a bare null at ${path}; null is not ` +
          "value|absent-verified|not-applicable|refused (BP-CONTENT-01)",
      );
    }
    const rendered = asRecord(value);
    if (
      rendered &&
      !isEarnedLeafAbsence(value) &&
      !isResolvedLandUseFacet(value) &&
      !isResolvedAcreageFacet(value)
    ) {
      return refuse(
        `${parcelNodeId} carries an object at ${path} that is neither a ` +
          "resolved value nor a well-formed earned absence",
      );
    }
  }
}

/**
 * Refuse (throw, code SITUS_ADDRESS_ABSENCE_UNEARNED) a payload whose
 * `baseFacts.situsAddress` is an object that is not a well-formed earned
 * absence, or whose basis does not name the parcel.
 *
 * It is the PER-PARCEL half of the contract that `assertRequiredLeafStatesEarned`
 * cannot express: that list refuses a bare null and a malformed object at any
 * owned path, but it does not check that an absence names the parcel it is
 * about, and a basis identical across parcels is a ceremony rather than a
 * justification.
 *
 * CTX-B6 (2026-09-10): this used to state, in words, that a bare null at this
 * path is legitimate and passes. It is not and it does not -- 22,805 rows
 * proved it, and the leaf is now in `BAKE_OWNED_REQUIRED_LEAF_PATHS`. Both
 * asserts now refuse a null here, which is deliberate redundancy at one call
 * site rather than two implementations of one rule in two places: they are
 * invoked back to back on the same payload in the bake CLI, so they cannot
 * drift apart unobserved, and each names a different reason in its error.
 */
export function assertSitusAddressAbsenceEarned(payload: unknown): void {
  const refuse = (why: string): never => {
    throw Object.assign(new Error(`situs address facet: ${why}`), {
      code: "SITUS_ADDRESS_ABSENCE_UNEARNED",
    });
  };
  const rec = asRecord(payload);
  if (!rec) return refuse("payload is not an object");
  const baseFacts = asRecord(rec.baseFacts);
  if (!baseFacts) return refuse("baseFacts is required");
  const parcelNodeId = typeof rec.parcelNodeId === "string" ? rec.parcelNodeId.trim() : "";
  if (!parcelNodeId) return refuse("parcelNodeId is required to check a per-parcel basis");
  if (!Object.prototype.hasOwnProperty.call(baseFacts, "situsAddress")) {
    return refuse(`${parcelNodeId} is missing the key baseFacts.situsAddress entirely`);
  }
  const value = baseFacts.situsAddress;
  if (value === null || value === undefined) {
    return refuse(
      `${parcelNodeId} carries a bare null at baseFacts.situsAddress; null is ` +
        "not value|absent-verified|not-applicable|refused (BP-CONTENT-01). A " +
        "claim carrying no situsAddress earns claimLeafAbsence; a claim " +
        "carrying an unusable one earns situsAddressUnusableAbsence",
    );
  }
  if (typeof value === "string") return;
  if (!isEarnedLeafAbsence(value)) {
    return refuse(
      `${parcelNodeId} carries an object at baseFacts.situsAddress that is ` +
        "neither a string, null, nor a well-formed earned absence",
    );
  }
  if (!value.basis.includes(parcelNodeId)) {
    return refuse(
      `${parcelNodeId} baseFacts.situsAddress.basis does not name the parcel; ` +
        "a basis identical across parcels is a ceremony, not a justification",
    );
  }
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

  // CTX-LEAVES: `baseFacts.landUse` now carries EITHER a resolved land use OR
  // the earned absence itself, so "not null" no longer means "has a land
  // use". A wire at that key is an absence wearing the cell it describes, and
  // must be treated as the absent branch, not the present one.
  const leafIsEarnedAbsence = isEarnedLeafAbsence(baseFacts.landUse);
  if (baseFacts.landUse != null && !leafIsEarnedAbsence) {
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

  // One fact now has two copies — the leaf state at `baseFacts.landUse` and
  // the record at `provenance.landUseAbsence`. Two implementations of one rule
  // is the CTRL-1 shape, and the divergence check IS the control (DEV_PROCESS
  // 2.4): they must correspond, or the payload is refused.
  if (leafIsEarnedAbsence) {
    const leaf = asRecord(baseFacts.landUse)!;
    const expected = absence.verdict === "absent-verified" ? "absent-verified" : "refused";
    if (leaf.verdict !== expected) {
      return refuse(
        `${parcelNodeId} baseFacts.landUse verdict is ${String(leaf.verdict)} while ` +
          `provenance.landUseAbsence verdict is ${String(absence.verdict)}; the leaf state ` +
          `and its absence record must correspond (${absence.verdict} maps to ${expected})`,
      );
    }
    if (expected === "refused" && leaf.lookupVerdict !== "lookup-failed") {
      return refuse(
        `${parcelNodeId} baseFacts.landUse is refused but does not carry ` +
          "lookupVerdict 'lookup-failed'; could-not-look must stay tellable from found-nothing",
      );
    }
    if (leaf.basis !== absence.basis) {
      return refuse(
        `${parcelNodeId} baseFacts.landUse basis differs from provenance.landUseAbsence basis; ` +
          "the leaf carries the earned record, it does not paraphrase it",
      );
    }
    const source = asRecord(provenance.landUseSource);
    if (!source || source.mirrors !== "baseFacts.landUse" || source.basis !== absence.basis) {
      return refuse(
        `${parcelNodeId} has an absent land use but provenance.landUseSource is not a verbatim ` +
          "mirror of baseFacts.landUse; the twin must not be able to answer differently",
      );
    }
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
  // CTX-RETIRE (2026-09-09): record-level retirement declaration, new-shape
  // only, same treatment as the keys above.
  "recordRetirement",
];

/** Key-path prefixes the new shape deliberately ADDS (allowlist). */
export const DIVERGENCE_ALLOWLIST_NEW_SHAPE_PREFIXES: readonly string[] = [
  "facets.base",
  "facetCoverage.tier1",
  "provenance.parcelJoin",
  "provenance.landUseOrigin",
  "provenance.landUseAbsence",
  // CTX-situs (2026-09-08): situsState is now derived, not join-sourced;
  // this marks that provenance. New-shape-only, same treatment as
  // landUseOrigin/landUseAbsence above.
  "provenance.situsStateSource",
  // CTX-B6 (2026-09-10): which upstream supplied the situs, and the claim the
  // declared roll overrode. New-shape-only, same treatment as landUseOrigin.
  // These are NOT a widening of what the instrument tolerates in the leaves it
  // already watches -- they are two new provenance keys the old bake had no
  // concept of, because the old bake had only one situs source.
  "provenance.situsAddressSource",
  "provenance.situsAddressSupersededClaim",
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
  // CTX-LEAVES: an old NULL leaf whose new counterpart is a well-formed EARNED
  // ABSENCE at the same path is ANSWERED, not dropped. The old bake writes
  // `baseFacts.situsCity: null` (one leaf); the conformant bake writes the
  // verdict/authority/scope/asOf/basis that says why (five). Same cell, richer
  // state — reporting that as a missing leaf would make the instrument fight
  // the fix.
  //
  // This is a SHAPE rule, not a path allowlist, and it cannot launder a
  // genuinely dropped leaf: the new payload has to carry a complete absence
  // wire at that exact path to earn the tolerance, and `isEarnedLeafAbsence`
  // checks every field. `DIVERGENCE_ALLOWLIST_NEW_SHAPE_PREFIXES` is
  // deliberately not widened for this.
  const answered = new Set<string>();
  for (const p of oldLeaves) {
    if (newLeaves.has(p)) continue;
    if (isEarnedLeafAbsence(keyPathValue(newPayload, p))) answered.add(p);
  }
  const underAnswered = (path: string): boolean =>
    [...answered].some((a) => path.startsWith(`${a}.`));
  const missing = [...oldLeaves]
    .filter((p) => !newLeaves.has(p) && !answered.has(p))
    .sort();
  const unexpected = [...newLeaves]
    .filter((p) => !oldLeaves.has(p) && !isIgnoredOrAllowedNewPath(p) && !underAnswered(p))
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

/** The value at a dotted path, or undefined when any segment is missing. */
export function keyPathValue(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    const rec = asRecord(cur);
    if (!rec || !Object.prototype.hasOwnProperty.call(rec, part)) return undefined;
    cur = rec[part];
  }
  return cur;
}

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
