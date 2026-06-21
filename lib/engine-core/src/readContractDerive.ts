/**
 * F4 — read-contract derivation and legacy EngineEnvelope migration.
 *
 * Decision 5: atom_calibration_overlay is an optional cache; primary
 * derivation uses raw ledger signals via collectCalibrationSignals.
 */

import {
  createConsequenceAxis,
  createReadContract,
  createThreeAxisConfidence,
  createWidthedConfidence,
  type ModelAttributionStamp,
  type ReadContract,
  type LegacyEngineEnvelopeConfidence,
} from "@hauska/atom-contract/read-contract";
import type { EngineHonesty } from "./envelope.js";
import { MIN_DENSE_SIGNAL } from "./constants.js";

/** Map interval width from signal count — wide when thin. */
export function intervalWidthFromSignalCount(n: number): number {
  if (n <= 0) return 0.35;
  if (n >= MIN_DENSE_SIGNAL) return 0.12;
  return 0.35 - (0.23 * n) / MIN_DENSE_SIGNAL;
}

export function routineConsequenceAxis(assembledAt: string) {
  return createConsequenceAxis({
    derivation: {
      source: "asce7-risk-category",
      asce7RiskCategory: "II",
    },
    stratum: "routine",
    assertedAt: assembledAt,
  });
}

export function legacyHonestyToReadContract(
  honesty: EngineHonesty,
  args?: {
    n?: number;
    modelAttribution?: ModelAttributionStamp;
    assembledAt?: string;
  },
): ReadContract {
  const assembledAt = args?.assembledAt ?? new Date().toISOString();
  const n = args?.n ?? 0;
  const width = intervalWidthFromSignalCount(n);
  const estimate = honesty.confidence.value;
  const provenance =
    honesty.confidence.kind === "calibrated" ? ("live" as const) : ("asserted" as const);

  const asserted = createWidthedConfidence({
    estimate,
    n,
    intervalWidth: width,
    provenance,
  });

  const calibrated = createWidthedConfidence({
    estimate:
      honesty.confidence.kind === "calibrated" ? estimate : Math.min(estimate, 0.85),
    n,
    intervalWidth: width,
    provenance: honesty.confidence.kind === "calibrated" ? "live" : "asserted",
  });

  return createReadContract({
    axes: createThreeAxisConfidence({
      calibratedConfidence: calibrated,
      assertedConfidence: asserted,
      consequence: routineConsequenceAxis(assembledAt),
    }),
    assembledAt,
    modelAttribution: args?.modelAttribution,
  });
}

export function legacyEnvelopeConfidenceToReadContract(
  confidence: LegacyEngineEnvelopeConfidence,
  args?: {
    n?: number;
    modelAttribution?: ModelAttributionStamp;
    assembledAt?: string;
  },
): ReadContract {
  return legacyHonestyToReadContract(
    {
      confidence,
      dataVintage: null,
      coverage: { degraded: false },
      source: { adapter: "legacy-envelope" },
    },
    args,
  );
}

export function readContractToEngineHonesty(
  contract: ReadContract,
): EngineHonesty {
  const primary = contract.axes.calibratedConfidence;
  const kind =
    primary.provenance === "live" || primary.provenance === "backtest"
      ? ("calibrated" as const)
      : ("asserted" as const);
  return {
    confidence: { value: primary.estimate as number, kind },
    dataVintage: null,
    coverage: { degraded: primary.n < MIN_DENSE_SIGNAL, reason: primary.n < MIN_DENSE_SIGNAL ? "thin-signal" : undefined },
    source: { adapter: "read-contract" },
  };
}

/** JSON-safe wire shape (branded estimate serializes as number). */
export function readContractForWire(contract: ReadContract): ReadContract {
  return JSON.parse(JSON.stringify(contract)) as ReadContract;
}

export function isLowConfidenceReadContract(contract: ReadContract): boolean {
  const c = contract.axes.calibratedConfidence;
  return (c.estimate as number) < 0.6 || c.intervalWidth > 0.25;
}
