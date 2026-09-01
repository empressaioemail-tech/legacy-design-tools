/**
 * CAD roll value fields from a `cad-parcel-roll` claim: read, bake, and wire.
 *
 * Dollar fields are three-state: present (v>0), zero (key present, v===0),
 * absent (key missing, no v, with basis). A stored 0 is CAD's claim, never
 * collapsed to absent. livingAreaSqft is not a dollar: positive or absent.
 */

export const CAD_PARCEL_ROLL_SOURCE = "cad-parcel-roll" as const;
export const COUNTY_ASSESSED_VALUE_BASIS = "county-assessed" as const;

/** One field as stored on `baseFacts.cadRoll` after the bake. */
export type CadRollBakedDollar = {
  v: number;
  source: typeof CAD_PARCEL_ROLL_SOURCE;
  vintage: string | null;
  valueBasis: typeof COUNTY_ASSESSED_VALUE_BASIS;
};

export type CadRollBakedSqft = {
  v: number;
  source: typeof CAD_PARCEL_ROLL_SOURCE;
  vintage: string | null;
};

export interface CadRollBaked {
  marketValue: CadRollBakedDollar | null;
  assessedValue: CadRollBakedDollar | null;
  landValue: CadRollBakedDollar | null;
  improvementValue: CadRollBakedDollar | null;
  livingAreaSqft: CadRollBakedSqft | null;
}

export type CadRollPresentWire = {
  state: "present";
  v: number;
  source: typeof CAD_PARCEL_ROLL_SOURCE;
  vintage: string | null;
  valueBasis?: typeof COUNTY_ASSESSED_VALUE_BASIS;
};

export type CadRollZeroWire = {
  state: "zero";
  v: 0;
  source: typeof CAD_PARCEL_ROLL_SOURCE;
  vintage: string | null;
  valueBasis?: typeof COUNTY_ASSESSED_VALUE_BASIS;
  basis?: string;
};

export type CadRollAbsentWire = {
  state: "absent";
  source: typeof CAD_PARCEL_ROLL_SOURCE;
  vintage: string | null;
  basis: string;
};

export type CadRollValueWire =
  | CadRollPresentWire
  | CadRollZeroWire
  | CadRollAbsentWire;

export type CadRollWire = {
  marketValue: CadRollValueWire;
  assessedValue: CadRollValueWire;
  landValue: CadRollValueWire;
  improvementValue: CadRollValueWire;
  livingAreaSqft: CadRollValueWire;
};

function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Non-negative whole dollars. Missing, non-finite, and negative are absent.
 * A stored 0 is 0. Collapsing 0 to null was the planner-introduced defect:
 * Bastrop vacant land carries a real stored improvementValue of 0.
 */
export function nonNegativeDollarOrNull(v: unknown): number | null {
  const n = finiteOrNull(v);
  if (n == null || n < 0) return null;
  return Math.round(n);
}

/**
 * Same contract as nonNegativeDollarOrNull. The prior implementation
 * treated 0 as absent; that collapse is retired for dollar fields.
 */
export function positiveDollarOrNull(v: unknown): number | null {
  return nonNegativeDollarOrNull(v);
}

/** Positive sqft only; null and non-positive are absent, never zero. */
export function positiveSqftOrNull(v: unknown): number | null {
  const n = finiteOrNull(v);
  if (n == null || n <= 0) return null;
  return Math.round(n);
}

function bakedDollar(
  v: unknown,
  vintage: string | null,
): CadRollBakedDollar | null {
  const dollars = nonNegativeDollarOrNull(v);
  if (dollars == null) return null;
  return {
    v: dollars,
    source: CAD_PARCEL_ROLL_SOURCE,
    vintage,
    valueBasis: COUNTY_ASSESSED_VALUE_BASIS,
  };
}

function bakedSqft(v: unknown, vintage: string | null): CadRollBakedSqft | null {
  const sqft = positiveSqftOrNull(v);
  if (sqft == null) return null;
  return { v: sqft, source: CAD_PARCEL_ROLL_SOURCE, vintage };
}

export interface CadRollClaimSlice {
  taxYear: number | null;
  marketValue: unknown;
  assessedValue: unknown;
  landValue: unknown;
  improvementValue: unknown;
  livingAreaSqft: unknown;
}

/** Map claim fields to baked `baseFacts.cadRoll`; every key is present. */
export function cadRollFromClaim(claim: CadRollClaimSlice): CadRollBaked {
  const vintage = claim.taxYear != null ? String(claim.taxYear) : null;
  return {
    marketValue: bakedDollar(claim.marketValue, vintage),
    assessedValue: bakedDollar(claim.assessedValue, vintage),
    landValue: bakedDollar(claim.landValue, vintage),
    improvementValue: bakedDollar(claim.improvementValue, vintage),
    livingAreaSqft: bakedSqft(claim.livingAreaSqft, vintage),
  };
}

const LAND_VALUE_ZERO_BASIS_SUFFIX =
  "claim.landValue is 0 on the cad-parcel-roll atom; $0 land looks like missing and is served as zero, not collapsed to absent";

export function cadRollFieldToWire(
  baked:
    | CadRollBakedDollar
    | CadRollBakedSqft
    | null
    | undefined,
  fieldName: string,
  parcelNodeId: string,
  vintage: string | null,
  withValueBasis: boolean,
): CadRollValueWire {
  const isDollar = withValueBasis;
  if (baked && typeof baked.v === "number" && Number.isFinite(baked.v)) {
    if (baked.v > 0) {
      return {
        state: "present",
        v: baked.v,
        source: baked.source,
        vintage: baked.vintage ?? vintage,
        ...(isDollar && "valueBasis" in baked
          ? { valueBasis: baked.valueBasis }
          : {}),
      };
    }
    if (baked.v === 0 && isDollar) {
      return {
        state: "zero",
        v: 0,
        source: baked.source,
        vintage: baked.vintage ?? vintage,
        ...("valueBasis" in baked ? { valueBasis: baked.valueBasis } : {}),
        ...(fieldName === "landValue"
          ? { basis: `${parcelNodeId}: ${LAND_VALUE_ZERO_BASIS_SUFFIX}` }
          : {}),
      };
    }
  }
  return {
    state: "absent",
    source: CAD_PARCEL_ROLL_SOURCE,
    vintage,
    basis:
      `${parcelNodeId}: claim.${fieldName} is absent on the cad-parcel-roll atom`,
  };
}

export function cadRollToWire(
  cadRoll: CadRollBaked | null | undefined,
  parcelNodeId: string,
  parcelVintage: string | null,
): CadRollWire {
  const vintage =
    parcelVintage ??
    cadRoll?.marketValue?.vintage ??
    cadRoll?.assessedValue?.vintage ??
    cadRoll?.livingAreaSqft?.vintage ??
    null;
  const roll = cadRoll ?? {
    marketValue: null,
    assessedValue: null,
    landValue: null,
    improvementValue: null,
    livingAreaSqft: null,
  };
  return {
    marketValue: cadRollFieldToWire(
      roll.marketValue,
      "marketValue",
      parcelNodeId,
      vintage,
      true,
    ),
    assessedValue: cadRollFieldToWire(
      roll.assessedValue,
      "assessedValue",
      parcelNodeId,
      vintage,
      true,
    ),
    landValue: cadRollFieldToWire(
      roll.landValue,
      "landValue",
      parcelNodeId,
      vintage,
      true,
    ),
    improvementValue: cadRollFieldToWire(
      roll.improvementValue,
      "improvementValue",
      parcelNodeId,
      vintage,
      true,
    ),
    livingAreaSqft: cadRollFieldToWire(
      roll.livingAreaSqft,
      "livingAreaSqft",
      parcelNodeId,
      vintage,
      false,
    ),
  };
}

/** True when any serialized field would be present (v>0). Zero is not present. */
export function cadRollWireHasPresentValue(wire: CadRollWire): boolean {
  return (
    Object.values(wire) as CadRollValueWire[]
  ).some((f) => f.state === "present");
}

/**
 * Three-state honesty check. Replaces cadRollWireNeverUsesZero (retired:
 * that check forbade every v:0, which collapsed vacant-lot truth).
 *
 * - state present must not carry v:0
 * - state absent must not carry v
 * - state zero must have v===0
 * - livingAreaSqft must never be state zero (not a dollar)
 */
export function cadRollWireThreeStatesHold(wire: CadRollWire): boolean {
  if (wire.livingAreaSqft.state === "zero") return false;
  for (const field of Object.values(wire) as CadRollValueWire[]) {
    if (field.state === "present") {
      if (typeof field.v !== "number" || field.v === 0 || field.v <= 0) {
        return false;
      }
    } else if (field.state === "absent") {
      if ("v" in field && (field as { v?: unknown }).v !== undefined) {
        return false;
      }
    } else if (field.state === "zero") {
      if (field.v !== 0) return false;
    } else {
      return false;
    }
  }
  return true;
}
