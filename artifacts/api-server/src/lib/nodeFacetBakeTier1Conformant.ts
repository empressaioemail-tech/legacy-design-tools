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
 *     gate-blocked). Absent is a state the key carries, never an omission.
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

import {
  assembleTier1Payload,
  COUNTY_NAMES,
  firstRing,
  type BaseFacts,
  type Tier1FacetPayload,
} from "./nodeFacetTier1Assemble";
import type { ParcelJoinRow } from "./nodeFacetTier1ParcelJoin";
import { ptadLandUseDescription } from "./ptadLandUse";

export const CONFORMANT_SHAPE_SOURCE = "conformant-v1";
export const CONFORMANT_TIER1_SOURCE = "conformant-v1-cad-parcel-roll";
export const TIER1_CONFORMANT_FACET_SCHEMA_VERSION =
  "node-facets-tier1-conformant-v1";
/** The literal the Factory walk rejects as the old-shape baseline. */
export const OLD_SHAPE_SCHEMA_VERSION_REJECTED_BY_WALK = "node-facets-tier1-v1";

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
  | { table: string; state: "no-row"; basis: string }
  | { table: string; state: "gate-blocked"; basis: string };

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
  provenance: Tier1FacetPayload["provenance"] & { parcelJoin: ParcelJoinRecord };
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
    /** The joined row, or null when none matched. Ignored when gate-blocked. */
    row: ParcelJoinRow | null;
    /** True when the county's prop_id join is gate-blocked (never joined). */
    gateBlocked: boolean;
  };
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
 * FAIL CLOSED on the gate: a row offered for a gate-blocked county is not
 * used (zoning null, envelope null, acreage from the claim), because in a
 * blocked county the `(county_fips, prop_id)` match is a numbering collision
 * that would attach another parcel's stamp and ring.
 */
export function buildConformantTier1Payload(
  input: ConformantTier1BuildInput,
): ConformantTier1Payload {
  const { parcelNodeId, countyFips, nowIso } = input;
  const claim = readConformantCadClaim(input.body);
  const apn = parcelNodeId.split(":")[1] ?? null;
  const countyName = input.countyName ?? COUNTY_NAMES[countyFips] ?? countyFips;

  const gateBlocked = input.parcelJoin.gateBlocked;
  const row = gateBlocked ? null : input.parcelJoin.row;
  const ring = row ? firstRing(row.geometry) : null;

  const code = claim.propertyUseCode;
  const landUse: BaseFacts["landUse"] = code
    ? {
        code,
        description: ptadLandUseDescription(code) ?? null,
        source: "cad-roll",
        vintage: claim.taxYear != null ? String(claim.taxYear) : null,
      }
    : null;

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
    landUseAddressRecovered: false,
    // The land-use is the claim's own field, not a join; the join gate is
    // recorded on provenance.parcelJoin instead.
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
  const parcelJoin: ParcelJoinRecord = gateBlocked
    ? {
        table,
        state: "gate-blocked",
        basis:
          `prop_id join is gate-blocked for county ${countyFips} (coverage ` +
          `ledger block verdict or LANDUSE_JOIN_DISABLED_FIPS_SEED): a CAD ` +
          `prop_id joined into a divergent TxGIO numbering attaches another ` +
          `parcel's zoning stamp and geometry, so zoning and geometry are ` +
          `unmeasured here, not verified absent`,
      }
    : row
      ? {
          table,
          state: "joined",
          basis: `${table} row feature_index ${row.feature_index} matched (county_fips, prop_id)`,
          featureIndex: row.feature_index,
          sourceVintage:
            typeof row.source_vintage === "string" && row.source_vintage.trim()
              ? row.source_vintage.trim()
              : null,
        }
      : {
          table,
          state: "no-row",
          basis: `no ${table} row for (county_fips ${countyFips}, prop_id ${apn ?? "?"}); zoning stamp and geometry unavailable`,
        };

  const { facetCoverage, provenance, ...rest } = tier1;
  return {
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
    provenance: { ...provenance, parcelJoin },
  };
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
