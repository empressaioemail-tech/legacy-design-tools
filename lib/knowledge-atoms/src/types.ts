import type {
  ConflictAtomPayload,
  KnowledgeAtomCheckScope,
  ResolutionAtomPayload,
  VerifiedAbsencePayload,
} from "@workspace/db";

export type {
  ConflictAtomPayload,
  KnowledgeAtomCheckScope,
  ResolutionAtomPayload,
  VerifiedAbsencePayload,
};

export const ABSENCE_CLAIM_PREFIX = "absence." as const;
export const CONFLICT_CLAIM_PREFIX = "conflict." as const;
export const RESOLUTION_CLAIM_PREFIX = "resolution." as const;

export type AbsenceClaimType = `absence.${string}`;
export type ConflictClaimType = `conflict.${string}`;

export interface KnowledgeAtomRecord {
  id: string;
  subjectId: string;
  claimType: string;
  sourceKey: string;
  payload: Record<string, unknown> | VerifiedAbsencePayload | ConflictAtomPayload | ResolutionAtomPayload;
  accessPolicy: string;
  confidence: number;
  validFrom: Date;
  validTo: Date | null;
  knowledgeAt: Date;
  dedupKey: string | null;
  createdAt: Date;
}

export interface ConflictAtomRecord extends Omit<KnowledgeAtomRecord, "claimType" | "payload"> {
  claimType: ConflictClaimType;
  payload: ConflictAtomPayload;
}

/** Discriminated union for current-value queries (Wave 2 breaking change). */
export type AtomQueryResult<T extends KnowledgeAtomRecord = KnowledgeAtomRecord> =
  | { kind: "single"; atom: T; conflict_disclosure?: boolean }
  | { kind: "conflicted"; conflict: ConflictAtomRecord; candidates: T[] }
  | { kind: "empty" };

export function isAbsenceClaimType(claimType: string): claimType is AbsenceClaimType {
  return claimType.startsWith(ABSENCE_CLAIM_PREFIX);
}

export function isConflictClaimType(
  claimType: string,
): claimType is ConflictClaimType {
  return claimType.startsWith(CONFLICT_CLAIM_PREFIX);
}

export function conflictClaimTypeFor(originalClaimType: string): ConflictClaimType {
  return `${CONFLICT_CLAIM_PREFIX}${originalClaimType}` as ConflictClaimType;
}

export function isWellDefinedCheckScope(
  scope: Partial<KnowledgeAtomCheckScope> | null | undefined,
): scope is KnowledgeAtomCheckScope {
  if (!scope) return false;
  return (
    typeof scope.jurisdiction === "string" &&
    scope.jurisdiction.length > 0 &&
    typeof scope.record_type === "string" &&
    scope.record_type.length > 0 &&
    typeof scope.date_range_start === "string" &&
    scope.date_range_start.length > 0 &&
    typeof scope.date_range_end === "string" &&
    scope.date_range_end.length > 0
  );
}

export function mapRow(row: {
  id: string;
  subjectId: string;
  claimType: string;
  sourceKey: string;
  payload: unknown;
  accessPolicy: string;
  confidence: string | number;
  validFrom: Date;
  validTo: Date | null;
  knowledgeAt: Date;
  dedupKey: string | null;
  createdAt: Date;
}): KnowledgeAtomRecord {
  return {
    id: row.id,
    subjectId: row.subjectId,
    claimType: row.claimType,
    sourceKey: row.sourceKey,
    payload: (row.payload as Record<string, unknown>) ?? {},
    accessPolicy: row.accessPolicy,
    confidence: Number(row.confidence),
    validFrom: row.validFrom,
    validTo: row.validTo,
    knowledgeAt: row.knowledgeAt,
    dedupKey: row.dedupKey,
    createdAt: row.createdAt,
  };
}
