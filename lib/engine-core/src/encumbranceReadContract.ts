/**
 * F4 — derive encumbrance read-contract from extract-model scalar confidence.
 * Raw scalar stays in ledger; wire surfaces receive widthed read-contract.
 */

import type { ReadContract } from "@hauska/atom-contract/read-contract";
import {
  createReadContract,
  createThreeAxisConfidence,
  createWidthedConfidence,
} from "@hauska/atom-contract/read-contract";
import {
  intervalWidthFromSignalCount,
  routineConsequenceAxis,
} from "./readContractDerive.js";

export function readContractFromExtractConfidence(
  confidence: number,
  args?: {
    n?: number;
    humanVerified?: boolean;
    assembledAt?: string;
  },
): ReadContract {
  const assembledAt = args?.assembledAt ?? new Date().toISOString();
  const n = args?.humanVerified ? Math.max(args.n ?? 0, 1) : (args?.n ?? 0);
  const estimate = Math.max(0, Math.min(1, confidence));
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
