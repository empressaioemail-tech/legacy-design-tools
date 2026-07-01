import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  knowledgeAtoms,
  type KnowledgeAtomCheckScope,
  type VerifiedAbsencePayload,
} from "@workspace/db";
import { intervalsOverlap, verifiedAbsenceDedupKey } from "./dedup.js";
import {
  compareSourcePrecedence,
  highestRankedCandidate,
  strictestAccessPolicy,
} from "./precedenceTaxonomy.js";
import {
  accessPolicyForSource,
  isRegisteredKnowledgeSource,
  lookupRegisteredSource,
} from "./sourceRegistry.js";
import {
  conflictClaimTypeFor,
  isAbsenceClaimType,
  isConflictClaimType,
  mapRow,
  type AtomQueryResult,
  type ConflictAtomPayload,
  type ConflictAtomRecord,
  type KnowledgeAtomRecord,
  type ResolutionAtomPayload,
  isWellDefinedCheckScope,
} from "./types.js";

export class UnregisteredSourceError extends Error {
  readonly sourceKey: string;
  constructor(sourceKey: string) {
    super(
      `Source "${sourceKey}" is not in the knowledge source registry — verified-absence atoms are rejected.`,
    );
    this.name = "UnregisteredSourceError";
    this.sourceKey = sourceKey;
  }
}

export interface WriteKnowledgeAtomInput {
  subjectId: string;
  claimType: string;
  sourceKey: string;
  payload: Record<string, unknown>;
  validFrom: Date;
  validTo?: Date | null;
  knowledgeAt?: Date;
  dedupKey?: string | null;
}

/** Central write path — all ingest, bulk import, and admin writes must use this. */
export async function writeKnowledgeAtom(
  input: WriteKnowledgeAtomInput,
): Promise<KnowledgeAtomRecord> {
  const source = lookupRegisteredSource(input.sourceKey);
  const accessPolicy =
    source?.accessPolicy ??
    (isConflictClaimType(input.claimType)
      ? strictestAccessPolicy(await accessPolicyForConflictCandidates(input))
      : "platform-internal");
  const confidence = source?.reliabilityScore ?? 0.5;
  const knowledgeAt = input.knowledgeAt ?? new Date();

  if (input.dedupKey) {
    const existing = await db
      .select()
      .from(knowledgeAtoms)
      .where(eq(knowledgeAtoms.dedupKey, input.dedupKey))
      .limit(1);
    if (existing[0]) {
      return mapRow(existing[0]);
    }
  }

  const [row] = await db
    .insert(knowledgeAtoms)
    .values({
      subjectId: input.subjectId,
      claimType: input.claimType,
      sourceKey: input.sourceKey,
      payload: input.payload,
      accessPolicy,
      confidence: String(confidence),
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      knowledgeAt,
      dedupKey: input.dedupKey ?? null,
    })
    .returning();

  const written = mapRow(row!);

  if (!isConflictClaimType(input.claimType) && !input.claimType.startsWith("resolution.")) {
    await detectAndEmitConflict(written);
  }

  return written;
}

async function accessPolicyForConflictCandidates(
  input: WriteKnowledgeAtomInput,
): Promise<string[]> {
  const payload = input.payload as Partial<ConflictAtomPayload>;
  const ids = payload.conflicting_atom_ids ?? [];
  if (ids.length === 0) return ["tenant-private"];
  const rows = await db
    .select({ accessPolicy: knowledgeAtoms.accessPolicy })
    .from(knowledgeAtoms)
    .where(inArray(knowledgeAtoms.id, ids));
  return rows.map((r) => r.accessPolicy);
}

export async function ingestVerifiedAbsence(args: {
  subjectId: string;
  absenceDomain: string;
  sourceKey: string;
  whatWasChecked: string;
  checkScope: KnowledgeAtomCheckScope;
  checkMethod: VerifiedAbsencePayload["check_method"];
  checkDate?: string;
  validFrom?: Date;
  validTo?: Date | null;
}): Promise<KnowledgeAtomRecord | null> {
  if (!isRegisteredKnowledgeSource(args.sourceKey)) {
    throw new UnregisteredSourceError(args.sourceKey);
  }
  if (!isWellDefinedCheckScope(args.checkScope)) {
    return null;
  }

  const source = lookupRegisteredSource(args.sourceKey)!;
  const claimType = `absence.${args.absenceDomain}`;
  const checkDate = args.checkDate ?? new Date().toISOString();
  const payload: VerifiedAbsencePayload = {
    what_was_checked: args.whatWasChecked,
    checked_by: args.sourceKey,
    check_scope: args.checkScope,
    check_method: args.checkMethod,
    result: "verified_absent",
  };
  const dedupKey = verifiedAbsenceDedupKey({
    subjectId: args.subjectId,
    claimType,
    sourceKey: args.sourceKey,
    checkScope: args.checkScope,
    checkDate,
  });

  return writeKnowledgeAtom({
    subjectId: args.subjectId,
    claimType,
    sourceKey: args.sourceKey,
    payload: payload as unknown as Record<string, unknown>,
    validFrom: args.validFrom ?? new Date(checkDate),
    validTo: args.validTo ?? null,
    knowledgeAt: new Date(checkDate),
    dedupKey,
  });
}

export async function bulkImportKnowledgeAtoms(
  rows: ReadonlyArray<WriteKnowledgeAtomInput>,
): Promise<KnowledgeAtomRecord[]> {
  const out: KnowledgeAtomRecord[] = [];
  for (const row of rows) {
    out.push(await writeKnowledgeAtom(row));
  }
  return out;
}

export async function adminWriteKnowledgeAtom(
  input: WriteKnowledgeAtomInput,
): Promise<KnowledgeAtomRecord> {
  return writeKnowledgeAtom(input);
}

async function detectAndEmitConflict(
  incoming: KnowledgeAtomRecord,
): Promise<ConflictAtomRecord | null> {
  const overlapping = await db
    .select()
    .from(knowledgeAtoms)
    .where(
      and(
        eq(knowledgeAtoms.subjectId, incoming.subjectId),
        eq(knowledgeAtoms.claimType, incoming.claimType),
        sql`${knowledgeAtoms.id} <> ${incoming.id}`,
      ),
    );

  const peers = overlapping
    .map(mapRow)
    .filter(
      (row) =>
        row.sourceKey !== incoming.sourceKey &&
        intervalsOverlap(row, incoming) &&
        !isConflictClaimType(row.claimType) &&
        !row.claimType.startsWith("resolution."),
    );

  if (peers.length === 0) return null;

  const conflictingIds = [incoming.id, ...peers.map((p) => p.id)];
  const conflictClaimType = conflictClaimTypeFor(incoming.claimType);
  const detectedAt = incoming.knowledgeAt.toISOString();

  const resolution = resolveConflictByPrecedence([incoming, ...peers]);

  const conflictPayload: ConflictAtomPayload = {
    original_claim_type: incoming.claimType,
    conflicting_atom_ids: conflictingIds,
    detected_at: detectedAt,
    resolution,
  };

  const policies = [incoming.accessPolicy, ...peers.map((p) => p.accessPolicy)];
  const accessPolicy = strictestAccessPolicy(policies);

  const [row] = await db
    .insert(knowledgeAtoms)
    .values({
      subjectId: incoming.subjectId,
      claimType: conflictClaimType,
      sourceKey: "system:conflict-detector",
      payload: conflictPayload,
      accessPolicy,
      confidence: resolution.resolved
        ? String(resolution.confidence ?? 0.75)
        : "0.5",
      validFrom: incoming.validFrom,
      validTo: incoming.validTo,
      knowledgeAt: incoming.knowledgeAt,
      dedupKey: null,
    })
    .returning();

  return mapRow(row!) as unknown as ConflictAtomRecord;
}

function resolveConflictByPrecedence(
  candidates: KnowledgeAtomRecord[],
): ConflictAtomPayload["resolution"] {
  if (candidates.length < 2) {
    return { resolved: false, resolution_basis: null };
  }
  let winner = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const next = candidates[i]!;
    const cmp = compareSourcePrecedence(winner.sourceKey, next.sourceKey);
    if (!cmp.ordered) {
      return { resolved: false, resolution_basis: null };
    }
    winner = cmp.winner.sourceKey === winner.sourceKey ? winner : next;
  }
  const runnerUp = candidates.find((c) => c.id !== winner.id);
  if (!runnerUp) {
    return { resolved: false, resolution_basis: null };
  }
  const cmp = compareSourcePrecedence(winner.sourceKey, runnerUp.sourceKey);
  if (!cmp.ordered) {
    return { resolved: false, resolution_basis: null };
  }
  return {
    resolved: true,
    winning_atom_id: winner.id,
    resolution_basis: "precedence_taxonomy",
    confidence: winner.confidence,
  };
}

export async function writeResolutionAtom(args: {
  subjectId: string;
  conflictAtomId: string;
  resolvedByAtomId: string;
  resolutionType: ResolutionAtomPayload["resolution_type"];
  resolvedAt?: string;
}): Promise<KnowledgeAtomRecord> {
  const payload: ResolutionAtomPayload = {
    conflict_atom_id: args.conflictAtomId,
    resolved_by: args.resolvedByAtomId,
    resolution_type: args.resolutionType,
    resolved_at: args.resolvedAt ?? new Date().toISOString(),
  };
  return writeKnowledgeAtom({
    subjectId: args.subjectId,
    claimType: "resolution.source_correction",
    sourceKey: "system:conflict-resolver",
    payload: payload as unknown as Record<string, unknown>,
    validFrom: new Date(payload.resolved_at),
    knowledgeAt: new Date(payload.resolved_at),
  });
}

export async function queryCurrentClaim(args: {
  subjectId: string;
  claimType: string;
  asOf?: Date;
}): Promise<AtomQueryResult> {
  const asOf = args.asOf ?? new Date();
  const positiveType = args.claimType;
  const absenceType = isAbsenceClaimType(positiveType)
    ? positiveType
    : (`absence.${positiveType.replace(/^claim\./, "")}` as const);

  const positiveRows = await db
    .select()
    .from(knowledgeAtoms)
    .where(
      and(
        eq(knowledgeAtoms.subjectId, args.subjectId),
        eq(knowledgeAtoms.claimType, positiveType),
        sql`${knowledgeAtoms.validFrom} <= ${asOf}`,
        or(isNull(knowledgeAtoms.validTo), sql`${knowledgeAtoms.validTo} >= ${asOf}`),
      ),
    )
    .orderBy(desc(knowledgeAtoms.knowledgeAt));

  if (positiveRows.length > 0) {
    const current = mapRow(positiveRows[0]!);
    const conflict = await findActiveConflict(args.subjectId, positiveType, asOf);
    if (conflict) {
      if (conflict.payload.resolution.resolved && conflict.payload.resolution.winning_atom_id) {
        const winner = positiveRows
          .map(mapRow)
          .find((r) => r.id === conflict.payload.resolution.winning_atom_id);
        if (winner) return { kind: "single", atom: winner };
      }
      const candidates = positiveRows.map(mapRow);
      const unresolved = !conflict.payload.resolution.resolved;
      if (unresolved) {
        const ranked = highestRankedCandidate(candidates);
        if (ranked) {
          return {
            kind: "single",
            atom: ranked,
            conflict_disclosure: true,
          };
        }
        return {
          kind: "conflicted",
          conflict: conflict as ConflictAtomRecord,
          candidates,
        };
      }
    }
    return { kind: "single", atom: current };
  }

  const absenceRows = await db
    .select()
    .from(knowledgeAtoms)
    .where(
      and(
        eq(knowledgeAtoms.subjectId, args.subjectId),
        eq(knowledgeAtoms.claimType, absenceType),
        sql`${knowledgeAtoms.validFrom} <= ${asOf}`,
        or(isNull(knowledgeAtoms.validTo), sql`${knowledgeAtoms.validTo} >= ${asOf}`),
      ),
    )
    .orderBy(desc(knowledgeAtoms.knowledgeAt))
    .limit(1);

  if (absenceRows[0]) {
    return { kind: "single", atom: mapRow(absenceRows[0]) };
  }

  return { kind: "empty" };
}

async function findActiveConflict(
  subjectId: string,
  originalClaimType: string,
  asOf: Date,
): Promise<ConflictAtomRecord | null> {
  const conflictType = conflictClaimTypeFor(originalClaimType);
  const rows = await db
    .select()
    .from(knowledgeAtoms)
    .where(
      and(
        eq(knowledgeAtoms.subjectId, subjectId),
        eq(knowledgeAtoms.claimType, conflictType),
        sql`${knowledgeAtoms.validFrom} <= ${asOf}`,
        or(isNull(knowledgeAtoms.validTo), sql`${knowledgeAtoms.validTo} >= ${asOf}`),
      ),
    )
    .orderBy(desc(knowledgeAtoms.knowledgeAt))
    .limit(1);
  if (!rows[0]) return null;
  return mapRow(rows[0]) as unknown as ConflictAtomRecord;
}

/** UI-safe unwrap — never silently drops unresolved conflicts without disclosure flag. */
export function unwrapAtomQueryResult<T extends KnowledgeAtomRecord>(
  result: AtomQueryResult<T>,
): T | null {
  if (result.kind === "empty") return null;
  if (result.kind === "single") return result.atom;
  const ranked = highestRankedCandidate(result.candidates);
  return ranked;
}

export { accessPolicyForSource, isRegisteredKnowledgeSource, lookupRegisteredSource };
