export type { AtomQueryResult } from "./types.js";
export {
  ABSENCE_CLAIM_PREFIX,
  CONFLICT_CLAIM_PREFIX,
  RESOLUTION_CLAIM_PREFIX,
  conflictClaimTypeFor,
  isAbsenceClaimType,
  isConflictClaimType,
  isWellDefinedCheckScope,
  mapRow,
  type AbsenceClaimType,
  type ConflictAtomRecord,
  type KnowledgeAtomRecord,
} from "./types.js";

export {
  KNOWLEDGE_SOURCE_REGISTRY,
  accessPolicyForSource,
  isRegisteredKnowledgeSource,
  lookupRegisteredSource,
  type RegisteredKnowledgeSource,
} from "./sourceRegistry.js";

export {
  compareSourcePrecedence,
  highestRankedCandidate,
  strictestAccessPolicy,
  type PrecedenceComparison,
} from "./precedenceTaxonomy.js";

export { intervalsOverlap, verifiedAbsenceDedupKey } from "./dedup.js";

export {
  UnregisteredSourceError,
  adminWriteKnowledgeAtom,
  bulkImportKnowledgeAtoms,
  ingestVerifiedAbsence,
  queryCurrentClaim,
  unwrapAtomQueryResult,
  writeKnowledgeAtom,
  writeResolutionAtom,
  type WriteKnowledgeAtomInput,
} from "./store.js";

export {
  maybeEmitVerifiedAbsenceFromAdapter,
  type AdapterEmptyCheckContext,
} from "./adapterHook.js";
