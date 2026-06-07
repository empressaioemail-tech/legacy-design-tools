/**
 * Tier 1a — adjudication-to-atom evidence ledger (Arrow two Phase 1).
 *
 * Derived read-model only: joins existing `atom_events` finding-mutation
 * events (`finding.accepted` / `finding.rejected` / `finding.overridden`)
 * to `findings.citations[].atomId`, producing per-atom adjudication tallies
 * partitioned by `jurisdictionTenant`. No schema change, no write path.
 *
 * Backend attribution surface — not exposed to reviewer UI (I7).
 */

import {
  db,
  atomEvents,
  findings,
  submissions,
  engagements,
  findingRuns,
} from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { keyFromEngagement } from "@workspace/codes";
import {
  FINDING_EVENT_TYPES,
  type FindingEventType,
} from "../atoms/finding.atom";

/** Reviewer-mutation event types emitted by `emitFindingMutationEvent`. */
const ADJUDICATION_EVENT_TYPES: readonly FindingEventType[] = [
  FINDING_EVENT_TYPES[1],
  FINDING_EVENT_TYPES[2],
  FINDING_EVENT_TYPES[3],
] as const;

type AdjudicationKind = "accept" | "reject" | "override";

const EVENT_TO_KIND: Record<string, AdjudicationKind> = {
  [FINDING_EVENT_TYPES[1]]: "accept",
  [FINDING_EVENT_TYPES[2]]: "reject",
  [FINDING_EVENT_TYPES[3]]: "override",
};

/** One aggregated ledger row — keyed by tenant + cited code atom. */
export interface AtomAdjudicationEvidenceRow {
  jurisdictionTenant: string;
  citedAtomId: string;
  acceptCount: number;
  rejectCount: number;
  overrideCount: number;
  /** Stated confidence (0..1) from each adjudicated finding citing this atom. */
  statedConfidences: number[];
}

export interface AtomAdjudicationEvidenceLedger {
  rows: AtomAdjudicationEvidenceRow[];
}

export interface InvalidCitationHealth {
  windowDays: number;
  completedRuns: number;
  runsWithInvalidCitations: number;
  totalInvalidCitations: number;
  /** Share of completed runs with at least one stripped citation token. */
  runInvalidRate: number | null;
}

const DEFAULT_HEALTH_WINDOW_DAYS = 60;

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
    if (isCodeSectionCitation(c)) ids.push(c.atomId);
  }
  return ids;
}

function parseStatedConfidence(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

type EngagementTenantFields = {
  cortexJurisdictionKey: string | null;
  jurisdictionCity: string | null;
  jurisdictionState: string | null;
  jurisdiction: string | null;
  address: string | null;
};

/**
 * Resolve the tenant partition key for a ledger row. Prefers the
 * engagement's stored `cortexJurisdictionKey`; falls back to
 * `keyFromEngagement` so legacy rows without the column still partition.
 */
export function resolveJurisdictionTenant(
  engagement: EngagementTenantFields,
): string | null {
  const stored = (engagement.cortexJurisdictionKey ?? "").trim();
  if (stored) return stored;
  return keyFromEngagement({
    jurisdictionCity: engagement.jurisdictionCity,
    jurisdictionState: engagement.jurisdictionState,
    jurisdiction: engagement.jurisdiction,
    address: engagement.address,
  });
}

type LedgerAccumulator = Map<
  string,
  Omit<AtomAdjudicationEvidenceRow, "jurisdictionTenant" | "citedAtomId">
>;

function ledgerKey(tenant: string, atomId: string): string {
  return `${tenant}\0${atomId}`;
}

function bumpAccumulator(
  acc: LedgerAccumulator,
  tenant: string,
  atomId: string,
  kind: AdjudicationKind,
  statedConfidence: number | null,
): void {
  const key = ledgerKey(tenant, atomId);
  let row = acc.get(key);
  if (!row) {
    row = {
      acceptCount: 0,
      rejectCount: 0,
      overrideCount: 0,
      statedConfidences: [],
    };
    acc.set(key, row);
  }
  if (kind === "accept") row.acceptCount += 1;
  else if (kind === "reject") row.rejectCount += 1;
  else row.overrideCount += 1;
  if (statedConfidence != null) {
    row.statedConfidences.push(statedConfidence);
  }
}

/**
 * Build the tier 1a evidence ledger from existing events + finding citations.
 * Optional `jurisdictionTenant` filter scopes to one tenant partition.
 */
export async function buildAtomAdjudicationEvidenceLedger(options?: {
  jurisdictionTenant?: string | null;
}): Promise<AtomAdjudicationEvidenceLedger> {
  const tenantFilter = (options?.jurisdictionTenant ?? "").trim() || null;

  const eventRows = await db
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

  const acc: LedgerAccumulator = new Map();

  for (const row of eventRows) {
    const tenant = resolveJurisdictionTenant(row);
    if (!tenant) continue;
    if (tenantFilter && tenant !== tenantFilter) continue;

    const kind = EVENT_TO_KIND[row.eventType];
    if (!kind) continue;

    const citedAtomIds = extractCodeCitationAtomIds(row.citations);
    if (citedAtomIds.length === 0) continue;

    const statedConfidence = parseStatedConfidence(row.confidence);
    for (const atomId of citedAtomIds) {
      bumpAccumulator(acc, tenant, atomId, kind, statedConfidence);
    }
  }

  const rows: AtomAdjudicationEvidenceRow[] = [];
  for (const [key, tallies] of acc) {
    const sep = key.indexOf("\0");
    rows.push({
      jurisdictionTenant: key.slice(0, sep),
      citedAtomId: key.slice(sep + 1),
      ...tallies,
    });
  }

  rows.sort((a, b) => {
    const tenantCmp = a.jurisdictionTenant.localeCompare(b.jurisdictionTenant);
    if (tenantCmp !== 0) return tenantCmp;
    return a.citedAtomId.localeCompare(b.citedAtomId);
  });

  return { rows };
}

/**
 * Lineage-trust health: `invalidCitationCount` rate across recent completed runs.
 */
export async function computeInvalidCitationHealth(
  windowDays = DEFAULT_HEALTH_WINDOW_DAYS,
): Promise<InvalidCitationHealth> {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [agg] = await db
    .select({
      completedRuns: sql<number>`COUNT(*)::int`,
      runsWithInvalidCitations: sql<number>`SUM(CASE WHEN COALESCE(${findingRuns.invalidCitationCount}, 0) > 0 THEN 1 ELSE 0 END)::int`,
      totalInvalidCitations: sql<number>`COALESCE(SUM(COALESCE(${findingRuns.invalidCitationCount}, 0)), 0)::int`,
    })
    .from(findingRuns)
    .where(
      and(
        eq(findingRuns.state, "completed"),
        gte(findingRuns.startedAt, windowStart),
      ),
    );

  const completedRuns = agg?.completedRuns ?? 0;
  const runsWithInvalidCitations = agg?.runsWithInvalidCitations ?? 0;
  const totalInvalidCitations = agg?.totalInvalidCitations ?? 0;

  return {
    windowDays,
    completedRuns,
    runsWithInvalidCitations,
    totalInvalidCitations,
    runInvalidRate:
      completedRuns > 0 ? runsWithInvalidCitations / completedRuns : null,
  };
}
