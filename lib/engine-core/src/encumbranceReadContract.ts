/**
 * F4 — derive encumbrance read-contract from extract-model scalar confidence.
 * Raw scalar stays in ledger; wire surfaces receive widthed read-contract.
 */

import type {
  ReadContract,
  WidthedConfidence,
} from "@hauska/atom-contract/read-contract";
import {
  createReadContract,
  createThreeAxisConfidence,
  createWidthedConfidence,
} from "@hauska/atom-contract/read-contract";
import {
  intervalWidthFromSignalCount,
  routineConsequenceAxis,
} from "./readContractDerive.js";

export function widthedConfidenceScalar(
  confidence: number | WidthedConfidence,
): number {
  return typeof confidence === "number" ? confidence : (confidence.estimate as number);
}

/** Build asserted widthed confidence from a DB/extract scalar. */
export function assertedExtractConfidence(
  estimate: number,
  n = 0,
): WidthedConfidence {
  const bounded = Math.max(0, Math.min(1, estimate));
  return createWidthedConfidence({
    estimate: bounded,
    n,
    intervalWidth: intervalWidthFromSignalCount(n),
    provenance: "asserted",
  });
}

export function readContractFromExtractConfidence(
  confidence: number | WidthedConfidence,
  args?: {
    n?: number;
    humanVerified?: boolean;
    assembledAt?: string;
  },
): ReadContract {
  const assembledAt = args?.assembledAt ?? new Date().toISOString();
  const n = args?.humanVerified ? Math.max(args.n ?? 0, 1) : (args?.n ?? 0);
  const estimate = Math.max(0, Math.min(1, widthedConfidenceScalar(confidence)));
  const width = intervalWidthFromSignalCount(n);

  const asserted = createWidthedConfidence({
    estimate,
    n,
    intervalWidth: width,
    provenance: "asserted",
  });

  return createReadContract({
    axes: createThreeAxisConfidence({
      calibratedConfidence: asserted,
      assertedConfidence: asserted,
      consequence: routineConsequenceAxis(assembledAt),
    }),
    assembledAt,
  });
}
