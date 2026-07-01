import type { AdapterRunOutcome } from "@workspace/adapters";
import { maybeEmitVerifiedAbsenceFromAdapter } from "@workspace/knowledge-atoms";

/**
 * Process adapter outcomes for verified-absence hints (Wave 1 ingest path).
 * Called from generate-layers after successful adapter runs.
 */
export async function emitVerifiedAbsenceFromAdapterOutcomes(args: {
  outcomes: ReadonlyArray<AdapterRunOutcome>;
  subjectId: string | null | undefined;
}): Promise<number> {
  if (!args.subjectId) return 0;
  let emitted = 0;
  for (const outcome of args.outcomes) {
    if (outcome.status !== "ok" || !outcome.result?.verifiedAbsence) continue;
    const hint = outcome.result.verifiedAbsence;
    const atom = await maybeEmitVerifiedAbsenceFromAdapter({
      subjectId: args.subjectId,
      absenceDomain: hint.absenceDomain,
      sourceKey: outcome.result.adapterKey,
      whatWasChecked: hint.whatWasChecked,
      checkScope: hint.checkScope,
      checkMethod: hint.checkMethod,
      checkDate: hint.checkDate,
    });
    if (atom) emitted += 1;
  }
  return emitted;
}
