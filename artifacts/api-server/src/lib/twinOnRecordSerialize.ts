/**
 * WDLL S1 (customer-facing slice): serialize bake-held base facts onto twin
 * surfaces (node brief `onRecord`, draw attrs). Provenance blocks and
 * facetCoverage stay deferred on P4-QUARANTINE.
 */

import type { AcreageMethod } from "./nodeFacetTier1Assemble";
import {
  cadRollToWire,
  gateCadRollWireValuation,
  type CadRollBaked,
  type CadRollValuationRefusal,
  type CadRollValueWire,
  type CadRollWire,
} from "./cadRollValue";

export type TwinOnRecordAcreage = {
  value: number;
  sqft: number;
  method: AcreageMethod;
} | null;

/** Gated wire: the four dollar keys may carry a studio-gated refusal in
 *  place of a value; livingAreaSqft is always the plain wire (not gated). */
export type TwinOnRecordCadRoll = {
  marketValue: CadRollValueWire | CadRollValuationRefusal;
  assessedValue: CadRollValueWire | CadRollValuationRefusal;
  landValue: CadRollValueWire | CadRollValuationRefusal;
  improvementValue: CadRollValueWire | CadRollValuationRefusal;
  livingAreaSqft: CadRollValueWire;
};

export type TwinOnRecordBlock = {
  apn: string | null;
  acreage: TwinOnRecordAcreage;
  countyFips: string | null;
  countyName: string | null;
  situsState: string | null;
  cadRoll: TwinOnRecordCadRoll;
  asOf: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function acreageFromBase(base: Record<string, unknown>): TwinOnRecordAcreage {
  const raw = base.acreage;
  const rec = asRecord(raw);
  if (!rec) return null;
  const value = rec.value;
  const sqft = rec.sqft;
  const method = rec.method;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    typeof sqft !== "number" ||
    !Number.isFinite(sqft) ||
    (method !== "shoelace-wgs84" && method !== "cad-roll-land-acres")
  ) {
    return null;
  }
  return { value, sqft, method };
}

/**
 * Project baked Tier-1 facets onto the twin on-record block. Pure.
 *
 * `grantsCadRollValuation` gates the four dollar rails (OPS-16 A-103 item 5
 * / A-104), same predicate as owner-info (`callerGrantsOwnerFact` /
 * `subscriptionTierGrantsStudio`) — Studio|Team only. A refused caller gets
 * a typed `studio-gated` refusal per dollar field, never a silent omission.
 * `livingAreaSqft` is not a dollar field and is never gated.
 */
export function serializeTwinOnRecord(
  facets: unknown,
  parcelNodeId: string,
  grantsCadRollValuation: boolean,
): TwinOnRecordBlock {
  const root = asRecord(facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  const provenance = asRecord(root.provenance);
  const parcelVintage = strOrNull(provenance?.parcelVintage);
  const bakedAt =
    typeof root.bakedAt === "string" && root.bakedAt.trim()
      ? root.bakedAt.trim()
      : null;
  const cadRoll = asRecord(baseFacts.cadRoll) as CadRollBaked | null;

  return {
    apn: strOrNull(baseFacts.apn),
    acreage: acreageFromBase(baseFacts),
    countyFips: strOrNull(root.countyFips),
    countyName: strOrNull(root.countyName),
    situsState: strOrNull(baseFacts.situsState),
    cadRoll: gateCadRollWireValuation(
      cadRollToWire(cadRoll, parcelNodeId, parcelVintage),
      grantsCadRollValuation,
    ),
    asOf: bakedAt,
  };
}

/** Map on-record CAD fields into draw attrs (same wire shape as node). */
export function cadRollAttrsFromOnRecord(
  onRecord: TwinOnRecordBlock,
): Record<string, CadRollValueWire | CadRollValuationRefusal> {
  return { ...onRecord.cadRoll };
}
