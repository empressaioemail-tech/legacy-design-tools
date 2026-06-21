/**
 * F9 — derive plan-review finding read-contract from raw adjudication loop.
 *
 * The LLM-emitted number stays in the ledger as rawModelConfidence only.
 * Wire surfaces receive this derived read-contract object.
 */

import type { ModelAttributionStamp, ReadContract } from "@hauska/atom-contract/read-contract";
import {
  createReadContract,
  createThreeAxisConfidence,
  createWidthedConfidence,
} from "@hauska/atom-contract/read-contract";
import { canonicalOverlayAtomKey } from "@workspace/codes";
import { collectCalibrationSignals } from "./signals.js";
import { computePartitionCalibration } from "./compute.js";
import { resolveOverlayCalibration } from "./overlay.js";
import {
  intervalWidthFromSignalCount,
  routineConsequenceAxis,
} from "./readContractDerive.js";

function extractCodeCitationAtomIds(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const ids: string[] = [];
  for (const c of citations) {
    if (
      c &&
      typeof c === "object" &&
      (c as { kind?: string }).kind === "code-section" &&
      typeof (c as { atomId?: string }).atomId === "string"
    ) {
      ids.push(canonicalOverlayAtomKey((c as { atomId: string }).atomId));
    }
  }
  return ids;
}

export interface DeriveFindingReadContractInput {
  citations: unknown;
  jurisdictionTenant: string | null;
  /** Raw LLM confidence from findings row — ledger signal, not wire output. */
  rawModelConfidence: number;
  modelAttribution?: ModelAttributionStamp;
  assembledAt?: string;
}

/**
 * Raw-adjudication loop at read time: join ledger signals + optional
 * overlay cache (Decision 5 — cache accelerates, signals are truth).
 */
export async function deriveFindingReadContract(
  input: DeriveFindingReadContractInput,
): Promise<ReadContract> {
  const assembledAt = input.assembledAt ?? new Date().toISOString();
  const citedAtomIds = extractCodeCitationAtomIds(input.citations);
  const tenant = input.jurisdictionTenant ?? "__public__";

  let signalCount = 0;
  let observedRate: number | null = null;
  let assertedBaseline = Number.isFinite(input.rawModelConfidence)
    ? Math.max(0, Math.min(1, input.rawModelConfidence))
    : 0.65;

  if (citedAtomIds.length > 0) {
    const allSignals = await collectCalibrationSignals();
    const citedSet = new Set(citedAtomIds);
    const signals = allSignals.filter(
      (s) =>
        citedSet.has(s.atomId) &&
        (s.jurisdictionTenant === tenant ||
          s.jurisdictionTenant === "__public__"),
    );
    const atomSignals = signals.filter((s) => citedSet.has(s.atomId));
    const citedClasses = new Set(atomSignals.map((s) => s.atomClass));
    const classSignals = signals.filter((s) => citedClasses.has(s.atomClass));
    const computed = computePartitionCalibration(atomSignals, classSignals);
    signalCount = computed.signalCount;
    assertedBaseline = computed.assertedConfidence;
    if (computed.calibratedConfidence != null) {
      observedRate = computed.calibratedConfidence;
    }

    // Overlay cache read (optional accelerator — not source of truth)
    for (const atomId of citedAtomIds.slice(0, 3)) {
      const cached = await resolveOverlayCalibration({
        atomId,
        jurisdictionTenant: tenant,
      });
      if (cached && cached.calibratedConfidence != null && !cached.calibrationStale) {
        observedRate = cached.calibratedConfidence;
        signalCount = Math.max(signalCount, cached.signalCount);
        break;
      }
    }
  }

  const width = intervalWidthFromSignalCount(signalCount);
  const calibratedEstimate =
    observedRate != null
      ? observedRate
      : assertedBaseline;

  const calibratedProvenance =
    observedRate != null && signalCount >= 1 ? ("live" as const) : ("asserted" as const);

  const asserted = createWidthedConfidence({
    estimate: assertedBaseline,
    n: signalCount,
    intervalWidth: width,
    provenance: "asserted",
  });

  const calibrated = createWidthedConfidence({
    estimate: calibratedEstimate,
    n: signalCount,
    intervalWidth: width,
    provenance: calibratedProvenance,
  });

  return createReadContract({
    axes: createThreeAxisConfidence({
      calibratedConfidence: calibrated,
      assertedConfidence: asserted,
      consequence: routineConsequenceAxis(assembledAt),
    }),
    assembledAt,
    modelAttribution: input.modelAttribution,
  });
}
