/**
 * Wire-time conformance assembly for mutable atom families (Track A).
 * readContract + accessPolicy on every atom emission; no derived numbers persisted.
 */

import type { ReadContract } from "@hauska/atom-contract/read-contract";
import {
  accessPolicyForFamily,
  buildAssertedFallbackReadContract,
  readContractForWire,
  type MutableAtomFamily,
} from "@workspace/engine-core";

export type AtomFamilyWireEnvelope = {
  accessPolicy: ReturnType<typeof accessPolicyForFamily>;
  readContract: ReadContract;
};

export function wireAtomFamilyConformance(args: {
  family: MutableAtomFamily;
  /** Raw scalar confidence — ledger/input feature only. */
  rawConfidence?: number | null;
  n?: number;
  accessPolicyRaw?: string | null;
  assembledAt?: string;
}): AtomFamilyWireEnvelope {
  const readContract = readContractForWire(
    buildAssertedFallbackReadContract({
      estimate:
        args.rawConfidence != null && Number.isFinite(args.rawConfidence)
          ? args.rawConfidence
          : undefined,
      n: args.n,
      assembledAt: args.assembledAt,
    }),
  );
  return {
    accessPolicy: accessPolicyForFamily(args.family, args.accessPolicyRaw),
    readContract,
  };
}
