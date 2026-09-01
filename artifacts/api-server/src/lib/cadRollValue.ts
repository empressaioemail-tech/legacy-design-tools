/**
 * CAD roll value fields from `cad_property`: read, bake, and wire.
 *
 * NEVER read `cad-parcel-roll` atoms for these fields. Hays / Travis /
 * Williamson atom bodies are hollow; Bastrop atoms invent livingArea,
 * assessed, and improvement-$0 coverage the CAD table does not have.
 *
 * Dollar fields are three-state: present (v>0), zero (key present, v===0),
 * absent (key missing, no v, with basis). A stored 0 is CAD's value, never
 * collapsed to absent. livingAreaSqft is not a dollar: positive or absent.
 */

export const CAD_PROPERTY_SOURCE = "cad_property" as const;
/** @deprecated value is cad_property. The atom name must not be the source. */
export const CAD_PARCEL_ROLL_SOURCE = CAD_PROPERTY_SOURCE;
export const COUNTY_ASSESSED_VALUE_BASIS = "county-assessed" as const;

/** One field as stored on `baseFacts.cadRoll` after the bake. */
export type CadRollBakedDollar = {
  v: number;
  source: typeof CAD_PROPERTY_SOURCE;
  vintage: string | null;
  valueBasis: typeof COUNTY_ASSESSED_VALUE_BASIS;
};

export type CadRollBakedSqft = {
  v: number;
  source: typeof CAD_PROPERTY_SOURCE;
  vintage: string | null;
};

export type CadRollBakedYear = {
  v: number;
  source: typeof CAD_PROPERTY_SOURCE;
  vintage: string | null;
};

export type CadRollBakedText = {
  v: string;
  source: typeof CAD_PROPERTY_SOURCE;
  vintage: string | null;
};

export type CadRollBakedCodes = {
  v: string[];
  source: typeof CAD_PROPERTY_SOURCE;
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
  source: typeof CAD_PROPERTY_SOURCE;
  vintage: string | null;
  valueBasis?: typeof COUNTY_ASSESSED_VALUE_BASIS;
};

export type CadRollZeroWire = {
  state: "zero";
  v: 0;
  source: typeof CAD_PROPERTY_SOURCE;
  vintage: string | null;
  valueBasis?: typeof COUNTY_ASSESSED_VALUE_BASIS;
  basis?: string;
};

export type CadRollAbsentWire = {
  state: "absent";
  source: typeof CAD_PROPERTY_SOURCE;
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
    source: CAD_PROPERTY_SOURCE,
    vintage,
    valueBasis: COUNTY_ASSESSED_VALUE_BASIS,
  };
}

export interface CadPropertyBakedFacts {
  cadRoll: CadRollBaked;
  yearBuilt: CadRollBakedYear | null;
  legalDescription: CadRollBakedText | null;
  exemptionCodes: CadRollBakedCodes | null;
}

/** Stamp CAD facts onto an existing bake payload. Does not touch zoning/envelope. */
export function applyCadPropertyFactsToPayload(
  payload: Record<string, unknown>,
  facts: CadPropertyBakedFacts,
): Record<string, unknown> {
  const base =
    payload.baseFacts && typeof payload.baseFacts === "object" && !Array.isArray(payload.baseFacts)
      ? { ...(payload.baseFacts as Record<string, unknown>) }
      : {};
  return {
    ...payload,
    baseFacts: {
      ...base,
      cadRoll: facts.cadRoll,
      yearBuilt: facts.yearBuilt,
      legalDescription: facts.legalDescription,
      exemptionCodes: facts.exemptionCodes,
    },
  };
}

export function cadPropertyFactsFromRow(
  row: CadPropertyRollSlice | null | undefined,
): CadPropertyBakedFacts {
  if (!row) {
    return {
      cadRoll: emptyCadRoll(),
      yearBuilt: null,
      legalDescription: null,
      exemptionCodes: null,
    };
  }
  const vintage = row.taxYear != null ? String(row.taxYear) : null;
  return {
    cadRoll: cadRollFromCadProperty(row),
    yearBuilt: bakedYear(row.yearBuilt, vintage),
    legalDescription: bakedLegal(row.legalDescription, vintage),
    exemptionCodes: bakedExemptionCodes(row.exemptionCodes, vintage),
  };
}

function bakedSqft(v: unknown, vintage: string | null): CadRollBakedSqft | null {
  const sqft = positiveSqftOrNull(v);
  if (sqft == null) return null;
  return { v: sqft, source: CAD_PROPERTY_SOURCE, vintage };
}

export function bakedYear(v: unknown, vintage: string | null): CadRollBakedYear | null {
  const n = finiteOrNull(v);
  if (n == null || n <= 0) return null;
  return { v: Math.round(n), source: CAD_PROPERTY_SOURCE, vintage };
}

export function bakedLegal(
  v: unknown,
  vintage: string | null,
): CadRollBakedText | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return { v: t, source: CAD_PROPERTY_SOURCE, vintage };
}

export function bakedExemptionCodes(
  v: unknown,
  vintage: string | null,
): CadRollBakedCodes | null {
  if (!Array.isArray(v)) return null;
  const codes = v
    .filter((c): c is string => typeof c === "string" && c.trim() !== "")
    .map((c) => c.trim());
  if (codes.length === 0) return null;
  return { v: codes, source: CAD_PROPERTY_SOURCE, vintage };
}

export interface CadPropertyRollSlice {
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

/** Empty cadRoll: every key present, every value null. Used when CAD was not consulted or the row missed. */
export function emptyCadRoll(): CadRollBaked {
  return {
    marketValue: null,
    assessedValue: null,
    landValue: null,
    improvementValue: null,
    livingAreaSqft: null,
  };
}

/** Map a `cad_property` row to baked `baseFacts.cadRoll`. Never an atom claim. */
export function cadRollFromCadProperty(row: CadPropertyRollSlice): CadRollBaked {
  const vintage = row.taxYear != null ? String(row.taxYear) : null;
  return {
    marketValue: bakedDollar(row.marketValue, vintage),
    assessedValue: bakedDollar(row.assessedValue, vintage),
    landValue: bakedDollar(row.landValue, vintage),
    improvementValue: bakedDollar(row.improvementValue, vintage),
    livingAreaSqft: bakedSqft(row.livingAreaSqft, vintage),
  };
}

/**
 * @deprecated name. Same mapper as cadRollFromCadProperty. The bake must
 * call cadRollFromCadProperty with a cad_property row, never an atom claim.
 */
export function cadRollFromClaim(row: CadPropertyRollSlice): CadRollBaked {
  return cadRollFromCadProperty(row);
}

const LAND_VALUE_ZERO_BASIS_SUFFIX =
  "cad_property.land_value is 0; $0 land looks like missing and is served as zero, not collapsed to absent";

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
    source: CAD_PROPERTY_SOURCE,
    vintage,
    basis: `${parcelNodeId}: cad_property.${fieldName} is absent`,
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
