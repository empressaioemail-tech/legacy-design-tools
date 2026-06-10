/**
 * Collect calibration signals from Phase 1 adjudication ledger + Phase 2 outcomes.
 */

import {
  db,
  atomEvents,
  findings,
  submissions,
  engagements,
  reasoningAtoms,
  codeAtoms,
  codeAtomSources,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  canonicalOverlayAtomKey,
  isReasoningOverlayAtomId,
  keyFromEngagement,
} from "@workspace/codes";
import { FINDING_OUTCOME_RECORDED_EVENT_TYPE } from "./findingOutcomeEventType";
import {
  assertedBaselineFromSourceType,
  atomClassFromCodeRef,
} from "./corpusBaseline";
import { isPublicPoolEligible } from "./partition";
import type { CalibrationSignal } from "./types";

const ADJUDICATION_EVENT_TYPES = [
  "finding.accepted",
  "finding.rejected",
  "finding.overridden",
] as const;

const OUTCOME_POSITIVE = new Set([
  "permit-approved",
  "variance-granted",
  "comment-resolved",
]);

type EngagementTenantFields = {
  cortexJurisdictionKey: string | null;
  jurisdictionCity: string | null;
  jurisdictionState: string | null;
  jurisdiction: string | null;
  address: string | null;
};

function resolveJurisdictionTenant(
  engagement: EngagementTenantFields,
): string | null {
  const stored = (engagement.cortexJurisdictionKey ?? "").trim();
  if (stored) return stored;
  return keyFromEngagement(engagement);
}

function isCodeSectionCitation(
  c: unknown,
): c is { kind: "code-section"; atomId: string } {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as { kind?: unknown }).kind === "code-section" &&
    typeof (c as { atomId?: unknown }).atomId === "string" &&
    (c as { atomId: string }).atomId.length > 0
  );
}

function extractCodeCitationAtomIds(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const ids: string[] = [];
  for (const c of citations) {
    if (isCodeSectionCitation(c)) {
      ids.push(canonicalOverlayAtomKey(c.atomId));
    }
  }
  return ids;
}

function parseStatedConfidence(raw: string | null | undefined): number {
  if (raw == null) return 0.65;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0.65;
}

function adjudicationSuccess(eventType: string): number {
  if (eventType === "finding.accepted") return 1;
  if (eventType === "finding.rejected") return 0;
  return 0.5;
}

export type AtomAccessContext = {
  atomId: string;
  accessPolicy: string;
  sharedWithTenants: string[] | null;
  codeRef: string | null;
  edition: string | null;
  sourceSetVersion: number;
  assertedConfidence: number;
};

export async function loadAtomAccessContexts(
  atomIds: string[],
): Promise<Map<string, AtomAccessContext>> {
  const unique = [...new Set(atomIds)];
  const map = new Map<string, AtomAccessContext>();
  if (unique.length === 0) return map;

  const reasoningIds = unique.filter(isReasoningOverlayAtomId);
  const corpusIds = unique.filter((id) => !isReasoningOverlayAtomId(id));

  if (reasoningIds.length > 0) {
    const rows = await db
      .select()
      .from(reasoningAtoms)
      .where(inArray(reasoningAtoms.id, reasoningIds));
    for (const row of rows) {
      map.set(row.id, {
        atomId: row.id,
        accessPolicy: row.accessPolicy,
        sharedWithTenants: null,
        codeRef: row.codeRef,
        edition: row.edition,
        sourceSetVersion: Number(row.sourceSetVersion ?? 1),
        assertedConfidence: Number(row.assertedConfidence),
      });
    }
  }

  for (const corpusKey of corpusIds) {
    if (map.has(corpusKey)) continue;
    const uuidForm = corpusKey.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    if (!uuidForm) continue;
    const [atom] = await db
      .select({
        id: codeAtoms.id,
        sectionNumber: codeAtoms.sectionNumber,
        edition: codeAtoms.edition,
        sourceType: codeAtomSources.sourceType,
      })
      .from(codeAtoms)
      .innerJoin(codeAtomSources, eq(codeAtoms.sourceId, codeAtomSources.id))
      .where(eq(codeAtoms.id, corpusKey))
      .limit(1);
    if (!atom) continue;
    map.set(corpusKey, {
      atomId: corpusKey,
      accessPolicy: "public-free",
      sharedWithTenants: null,
      codeRef: atom.sectionNumber,
      edition: atom.edition,
      sourceSetVersion: 1,
      assertedConfidence: assertedBaselineFromSourceType(atom.sourceType),
    });
  }

  return map;
}

export async function collectCalibrationSignals(): Promise<CalibrationSignal[]> {
  const signals: CalibrationSignal[] = [];

  const adjudicationRows = await db
    .select({
      eventType: atomEvents.eventType,
      citations: findings.citations,
      confidence: findings.confidence,
      cortexJurisdictionKey: engagements.cortexJurisdictionKey,
      jurisdictionCity: engagements.jurisdictionCity,
      jurisdictionState: engagements.jurisdictionState,
      jurisdiction: engagements.jurisdiction,
      address: engagements.address,
    })
    .from(atomEvents)
    .innerJoin(findings, eq(findings.atomId, atomEvents.entityId))
    .innerJoin(submissions, eq(submissions.id, findings.submissionId))
    .innerJoin(engagements, eq(engagements.id, submissions.engagementId))
    .where(
      and(
        eq(atomEvents.entityType, "finding"),
        inArray(atomEvents.eventType, [...ADJUDICATION_EVENT_TYPES]),
      ),
    );

  const allAtomIds = new Set<string>();
  for (const row of adjudicationRows) {
    for (const id of extractCodeCitationAtomIds(row.citations)) {
      allAtomIds.add(id);
    }
  }

  const outcomeRows = await db
    .select({
      entityId: atomEvents.entityId,
      payload: atomEvents.payload,
      citations: findings.citations,
      confidence: findings.confidence,
      cortexJurisdictionKey: engagements.cortexJurisdictionKey,
      jurisdictionCity: engagements.jurisdictionCity,
      jurisdictionState: engagements.jurisdictionState,
      jurisdiction: engagements.jurisdiction,
      address: engagements.address,
    })
    .from(atomEvents)
    .innerJoin(findings, eq(findings.atomId, atomEvents.entityId))
    .innerJoin(submissions, eq(submissions.id, findings.submissionId))
    .innerJoin(engagements, eq(engagements.id, submissions.engagementId))
    .where(eq(atomEvents.eventType, FINDING_OUTCOME_RECORDED_EVENT_TYPE));

  for (const row of outcomeRows) {
    for (const id of extractCodeCitationAtomIds(row.citations)) {
      allAtomIds.add(id);
    }
  }

  const contexts = await loadAtomAccessContexts([...allAtomIds]);

  for (const row of adjudicationRows) {
    const tenant = resolveJurisdictionTenant(row);
    if (!tenant) continue;
    const citedAtomIds = extractCodeCitationAtomIds(row.citations);
    const stated = parseStatedConfidence(row.confidence);
    const success = adjudicationSuccess(row.eventType);
    for (const atomId of citedAtomIds) {
      const ctx = contexts.get(atomId);
      if (!ctx) continue;
      signals.push(
        buildSignal({
          atomId,
          tenant,
          ctx,
          stated,
          success,
        }),
      );
    }
  }

  for (const row of outcomeRows) {
    const tenant = resolveJurisdictionTenant(row);
    if (!tenant) continue;
    const payload = row.payload as Record<string, unknown> | null;
    const outcomeKind =
      payload && typeof payload.outcomeKind === "string"
        ? payload.outcomeKind
        : null;
    if (!outcomeKind) continue;
    const success = OUTCOME_POSITIVE.has(outcomeKind) ? 1 : 0;
    const citedAtomIds = extractCodeCitationAtomIds(row.citations);
    const stated = parseStatedConfidence(row.confidence);
    for (const atomId of citedAtomIds) {
      const ctx = contexts.get(atomId);
      if (!ctx) continue;
      signals.push(
        buildSignal({
          atomId,
          tenant,
          ctx,
          stated,
          success,
        }),
      );
    }
  }

  return signals;
}

/** Tenant adjudications never pool into public; only anonymous/public-tier does. */
function buildSignal(args: {
  atomId: string;
  tenant: string;
  ctx: AtomAccessContext;
  stated: number;
  success: number;
}): CalibrationSignal {
  const isAnonymousPublic = args.tenant === "__anonymous__";
  if (isAnonymousPublic && isPublicPoolEligible(args.ctx.accessPolicy)) {
    return {
      atomId: args.atomId,
      jurisdictionTenant: args.tenant,
      partitionKind: "public",
      accessPolicy: "public-free",
      sharedWithTenants: null,
      atomClass: atomClassFromCodeRef(args.ctx.codeRef),
      stamp: {
        codeRef: args.ctx.codeRef ?? "",
        edition: args.ctx.edition ?? "",
        sourceSetVersion: args.ctx.sourceSetVersion,
      },
      statedConfidence: args.stated,
      observedSuccess: args.success,
    };
  }
  if (args.ctx.accessPolicy === "tenant-shared") {
    return {
      atomId: args.atomId,
      jurisdictionTenant: args.tenant,
      partitionKind: "tenant-shared",
      accessPolicy: "tenant-shared",
      sharedWithTenants: args.ctx.sharedWithTenants,
      atomClass: atomClassFromCodeRef(args.ctx.codeRef),
      stamp: {
        codeRef: args.ctx.codeRef ?? "",
        edition: args.ctx.edition ?? "",
        sourceSetVersion: args.ctx.sourceSetVersion,
      },
      statedConfidence: args.stated,
      observedSuccess: args.success,
    };
  }
  return {
    atomId: args.atomId,
    jurisdictionTenant: args.tenant,
    partitionKind: "tenant-private",
    accessPolicy: "tenant-private",
    sharedWithTenants: null,
    atomClass: atomClassFromCodeRef(args.ctx.codeRef),
    stamp: {
      codeRef: args.ctx.codeRef ?? "",
      edition: args.ctx.edition ?? "",
      sourceSetVersion: args.ctx.sourceSetVersion,
    },
    statedConfidence: args.stated,
    observedSuccess: args.success,
  };
}
