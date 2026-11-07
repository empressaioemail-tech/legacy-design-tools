/**
 * Owner co-gate for the map-data surfaces (parcel layers served by bbox).
 *
 * THE DEFECT THIS CLOSES. `POST /api/brokerage/v1/map-data/gis-layer` with
 * `layer: "parcels"` returned every parcel feature in the viewport with its
 * `owner` property populated — to ANY caller that cleared the Max package
 * gate, including the hauska-map same-origin proxy (`api/spine.ts`), which
 * attaches the cortex service key to every anonymous browser request and so
 * resolves to Max. Everywhere else in the product owner name, owner mailing
 * address, exemptions and the CAD tax-assessed dollar values are co-gated:
 * Studio|Team, or an active Property Unlock on THAT parcel. A bbox request
 * made the owner name scriptable for any viewport.
 *
 * THE GATE IS NOT RE-DERIVED HERE. The caller is resolved by
 * `resolveOwnerFactCaller` (the caller half of `callerGrantsOwnerFact`, the
 * owner-fact gate in brokerageNodeFacets.ts) and each parcel is decided by
 * `grantsOwnerCoGatedFields` (peEntitlement.ts) — the same predicate that
 * gates `ownerFact`. Plan entitlement (Studio|Team) covers every parcel in
 * the response; a Property Unlock covers only its own `parcel_node_id`.
 *
 * DEFAULT DENY. Anonymous, free, Solo, identified-only and service/operator
 * key callers (no identified brokerage user) get NO co-gated key at all:
 * the key is omitted, never sent as null.
 */

import type { PeSubscriptionTier } from "@workspace/db";
import { parcelNodeId as buildParcelNodeId } from "./parcelNodeId";

/** Mirrors the shape `resolveOwnerFactCaller` returns; `null` = no identified user. */
export type OwnerCoGateCaller = {
  userId: string | null;
  subscriptionTier: PeSubscriptionTier | null;
} | null;

/** Signature of `grantsOwnerCoGatedFields` (peEntitlement.ts). */
export type OwnerCoGrant = (
  userId: string | null,
  subscriptionTier: PeSubscriptionTier | null,
  parcelNodeId: string,
) => Promise<boolean>;

const DOLLAR_VALUE_BARE = /^(market|assessed|appraised)([_-]?(val|value|values|amt|amount))?$/i;
const DOLLAR_VALUE_SUFFIXED =
  /^(land|improvement|improvements|imprv|impr|taxable|total[_-]?market|total[_-]?appraised|total[_-]?assessed|cad[_-]?market|cad[_-]?assessed)[_-]?(val|value|values|amt|amount)$/i;

/**
 * Is this property key an owner co-gated field? Owner name / owner address
 * (`owner`, `ownerName`, `owner_name`, `OWNER_ADDR`, `cadOwner`, ...), any
 * mailing address, exemption flags, and the CAD tax-assessed dollar values
 * (market / assessed / land / improvement).
 *
 * The owner-name half mirrors `isOwnerIshKey` in brokerageNodeFacets.ts
 * (`owner` followed by a non-letter or an uppercase/underscore boundary, so
 * `ownership` is not an owner key).
 */
export function isOwnerCoGatedKey(key: string): boolean {
  if (/^owner(?![a-z])/i.test(key) || /^owner[_A-Z]/.test(key)) return true;
  if (/^(cad|gis|txgio)[_-]?owner/i.test(key)) return true;
  if (/mail/i.test(key)) return true;
  if (/exempt/i.test(key)) return true;
  if (DOLLAR_VALUE_BARE.test(key)) return true;
  if (DOLLAR_VALUE_SUFFIXED.test(key)) return true;
  return false;
}

/** Recursively drop every owner co-gated key. Pure; never mutates input. */
export function stripOwnerCoGatedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripOwnerCoGatedKeys(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isOwnerCoGatedKey(k)) continue;
      out[k] = stripOwnerCoGatedKeys(v);
    }
    return out;
  }
  return value;
}

/** True when any owner co-gated key survives anywhere in `value`. */
export function hasOwnerCoGatedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => hasOwnerCoGatedKey(v));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isOwnerCoGatedKey(k)) return true;
      if (hasOwnerCoGatedKey(v)) return true;
    }
  }
  return false;
}

type FeatureLike = { type: "Feature"; properties?: unknown };

function isFeature(value: unknown): value is FeatureLike {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "Feature"
  );
}

/**
 * The parcel a feature describes: its stamped `parcel_node_id`, else one
 * built from `countyFips` + `apn` (the composite layers carry those). `null`
 * when the feature cannot be tied to one parcel — such a feature can only be
 * granted by plan, never by a per-parcel unlock.
 */
export function featureParcelNodeId(properties: unknown): string | null {
  if (!properties || typeof properties !== "object") return null;
  const p = properties as Record<string, unknown>;
  if (typeof p.parcel_node_id === "string" && p.parcel_node_id.trim()) {
    return p.parcel_node_id.trim();
  }
  const fips = typeof p.countyFips === "string" ? p.countyFips : null;
  const apn =
    typeof p.apn === "string"
      ? p.apn
      : typeof p.apn === "number"
        ? String(p.apn)
        : null;
  return buildParcelNodeId(fips, apn);
}

function collectFeatureNodeIds(value: unknown, into: Set<string | null>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectFeatureNodeIds(v, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isFeature(value)) {
    into.add(featureParcelNodeId(value.properties));
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectFeatureNodeIds(v, into);
  }
}

/**
 * Gate every owner co-gated key in a map-data response.
 *
 * - Each GeoJSON Feature (at any depth) keeps its co-gated properties only
 *   when `grant(caller, thatFeature'sParcelNodeId)` is true.
 * - Keys OUTSIDE any Feature are kept only when `contextParcelNodeId` is
 *   granted (the single-parcel `POST /map-data` assemble); with no context
 *   parcel, only a plan grant keeps them.
 * - `caller === null` grants nothing and performs no lookup.
 *
 * A feature with no resolvable parcel id is decided with `userId: null`, so
 * only the plan half of the predicate can grant it — an unlock is per parcel
 * and an unidentified feature is no parcel's.
 */
export async function gateOwnerCoGatedFields<T>(
  value: T,
  opts: {
    caller: OwnerCoGateCaller;
    grant: OwnerCoGrant;
    contextParcelNodeId?: string | null;
  },
): Promise<T> {
  const { caller, grant } = opts;
  const decide = async (nodeId: string | null): Promise<boolean> => {
    if (caller == null) return false;
    return nodeId
      ? grant(caller.userId, caller.subscriptionTier, nodeId)
      : grant(null, caller.subscriptionTier, "");
  };

  const nodeIds = new Set<string | null>();
  collectFeatureNodeIds(value, nodeIds);
  const decisions = new Map<string | null, boolean>();
  await Promise.all(
    [...nodeIds].map(async (id) => {
      decisions.set(id, await decide(id));
    }),
  );
  const contextGranted = await decide(opts.contextParcelNodeId ?? null);

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    if (isFeature(v)) {
      const granted = decisions.get(featureParcelNodeId(v.properties)) === true;
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        if (k === "properties") {
          out[k] = granted ? inner : stripOwnerCoGatedKeys(inner);
        } else {
          out[k] = inner;
        }
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      if (!contextGranted && isOwnerCoGatedKey(k)) continue;
      out[k] = walk(inner);
    }
    return out;
  };

  return walk(value) as T;
}
