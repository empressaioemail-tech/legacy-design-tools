import type { KnowledgeAtomCheckScope } from "./types.js";
import { ingestVerifiedAbsence } from "./store.js";
import { isRegisteredKnowledgeSource } from "./sourceRegistry.js";
import { isWellDefinedCheckScope } from "./types.js";

export interface AdapterEmptyCheckContext {
  /** parcel_ / subject node id */
  subjectId: string;
  /** absence domain suffix — e.g. lien, permit, violation */
  absenceDomain: string;
  /** adapter registry key — must be registered */
  sourceKey: string;
  whatWasChecked: string;
  checkScope: KnowledgeAtomCheckScope;
  checkMethod: "api_query" | "public_record_pull" | "registry_lookup";
  checkDate?: string;
}

/**
 * Called when an adapter completes a scoped query with zero matching records.
 * Returns null when source is unregistered or scope is incomplete.
 */
export async function maybeEmitVerifiedAbsenceFromAdapter(
  ctx: AdapterEmptyCheckContext,
) {
  if (!isRegisteredKnowledgeSource(ctx.sourceKey)) {
    return null;
  }
  if (!isWellDefinedCheckScope(ctx.checkScope)) {
    return null;
  }
  return ingestVerifiedAbsence({
    subjectId: ctx.subjectId,
    absenceDomain: ctx.absenceDomain,
    sourceKey: ctx.sourceKey,
    whatWasChecked: ctx.whatWasChecked,
    checkScope: ctx.checkScope,
    checkMethod: ctx.checkMethod,
    checkDate: ctx.checkDate,
  });
}
