/**
 * "Pencils at $X" — user buy-box math over cited inputs (75i task 5).
 *
 * Their math on our cited AVM/rent/insurance/rehab inputs — never our
 * opinion of value (TX non-disclosure / not-an-appraisal).
 */

export interface BuyBoxParams {
  /** Minimum acceptable cap rate (e.g. 0.08 = 8%). */
  capRateFloor: number;
  /** Rehab budget $/sf the user assumes. */
  rehabPerSf: number;
  /** Spread tolerance below market rent (e.g. 0.05 = 5%). */
  rentSpreadTolerance: number;
  /** Annual insurance $ estimate (user-supplied or from replacement-cost cite). */
  annualInsurance?: number | null;
  /** Estimated rentable sqft for rehab calc. */
  rentableSqft?: number | null;
}

export interface PencilsAtInput {
  buyBox: BuyBoxParams;
  /** Cotality-cited AVM midpoint (not labeled "value"). */
  avmMidpoint?: number | null;
  /** Monthly rent estimate from rent AVM cite. */
  monthlyRent?: number | null;
  /** Annual property tax cite. */
  annualTax?: number | null;
  /** Living area sqft for rehab line. */
  livingSqft?: number | null;
}

export interface PencilsAtResult {
  pencilsAtBasis: number | null;
  breakEvenCapRate: number | null;
  citedInputs: Record<string, number | null>;
  method: "buy-box-v1";
  disclaimer: string;
  narrative: string;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function extractPencilsInputsFromLayers(
  layers: Array<{ layerKind: string; status: string; payload?: Record<string, unknown> }>,
): {
  avmMidpoint: number | null;
  monthlyRent: number | null;
  annualTax: number | null;
  livingSqft: number | null;
  annualInsurance: number | null;
} {
  let avmMidpoint: number | null = null;
  let monthlyRent: number | null = null;
  let annualTax: number | null = null;
  let livingSqft: number | null = null;
  let annualInsurance: number | null = null;

  for (const layer of layers) {
    if (layer.status !== "ok" || !layer.payload) continue;
    if (layer.layerKind === "cotality-property") {
      const avm = layer.payload.avm as Record<string, unknown> | null;
      avmMidpoint =
        num(avm?.estimatedValue) ??
        num(avm?.value) ??
        num((avm?.summary as Record<string, unknown> | undefined)?.estimatedValue);
      const detail = layer.payload.propertyDetail as Record<string, unknown> | undefined;
      const buildings = detail?.buildings as Record<string, unknown> | undefined;
      livingSqft =
        num(buildings?.livingArea) ?? num(buildings?.squareFeet) ?? livingSqft;
    }
    if (layer.layerKind === "cotality-rent-avm") {
      const rent = layer.payload.rentAvm as Record<string, unknown> | undefined;
      monthlyRent =
        num(rent?.estimatedRent) ??
        num(rent?.rent) ??
        num((rent?.summary as Record<string, unknown> | undefined)?.estimatedRent);
    }
    if (layer.layerKind === "cotality-liens-mortgage-tax") {
      const tax = layer.payload.taxAssessment as Record<string, unknown> | undefined;
      annualTax =
        num(tax?.totalTaxAmount) ??
        num(tax?.taxAmount) ??
        num((tax?.assessment as Record<string, unknown> | undefined)?.totalTax);
    }
    if (layer.layerKind === "cotality-replacement-cost") {
      const res = layer.payload.residentialReplacementCost as
        | Record<string, unknown>
        | undefined;
      const rcv = num(res?.replacementCost) ?? num(res?.rcv);
      if (rcv != null) annualInsurance = rcv * 0.004;
    }
  }

  return { avmMidpoint, monthlyRent, annualTax, livingSqft, annualInsurance };
}

export function computePencilsAt(input: PencilsAtInput): PencilsAtResult {
  const disclaimer =
    "Informational buy-box math on cited third-party inputs — not an appraisal or opinion of value.";

  const sqft = input.livingSqft ?? input.buyBox.rentableSqft ?? null;
  const rehabTotal =
    sqft != null && input.buyBox.rehabPerSf > 0
      ? sqft * input.buyBox.rehabPerSf
      : null;

  const annualRent =
    input.monthlyRent != null ? input.monthlyRent * 12 : null;
  const insurance = input.buyBox.annualInsurance ?? null;
  const tax = input.annualTax ?? null;

  const citedInputs: Record<string, number | null> = {
    avmMidpoint: input.avmMidpoint ?? null,
    monthlyRent: input.monthlyRent ?? null,
    annualRent,
    annualTax: tax,
    rehabTotal,
    annualInsurance: insurance,
  };

  if (
    annualRent == null ||
    input.buyBox.capRateFloor <= 0 ||
    input.buyBox.capRateFloor >= 1
  ) {
    return {
      pencilsAtBasis: null,
      breakEvenCapRate: null,
      citedInputs,
      method: "buy-box-v1",
      disclaimer,
      narrative:
        "We need a cited rent estimate and your cap-rate floor to pencil a break-even basis.",
    };
  }

  const noi =
    annualRent -
    (tax ?? 0) -
    (insurance ?? 0) -
    annualRent * input.buyBox.rentSpreadTolerance;
  const capDenom = input.buyBox.capRateFloor;
  let pencilsAtBasis = noi / capDenom;
  if (rehabTotal != null) pencilsAtBasis -= rehabTotal;

  const breakEvenCapRate =
    input.avmMidpoint != null && input.avmMidpoint > 0
      ? noi / input.avmMidpoint
      : null;

  const basisRounded = Math.round(pencilsAtBasis);
  const narrative = `At your ${(input.buyBox.capRateFloor * 100).toFixed(1)}% cap floor, cited rent/tax/insurance inputs pencil a break-even basis near $${basisRounded.toLocaleString()} — your math, our cites.`;

  return {
    pencilsAtBasis: basisRounded,
    breakEvenCapRate,
    citedInputs,
    method: "buy-box-v1",
    disclaimer,
    narrative,
  };
}
