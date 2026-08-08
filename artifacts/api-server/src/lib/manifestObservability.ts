/**
 * County Manifest observability writers (feat/manifest-observability-tables).
 *
 * Recording substrate for four deferred Sprint-1 capabilities:
 *   1. rail_state_history — append-only cell snapshots (regression detection)
 *   2. rail_verification — sample-vs-sweep audit trail per cell
 *   3. manifest_run + slot tables — queryable LIVE / queue state
 *   4. manifest_jurisdiction_cost — dual commitment vs lifetime cost counters
 *
 * PARALLELISM LANE COORDINATION (2026-08-08):
 * `_inbox/2026-08-08_PARALLELISM_design_proposal.md` did not exist at build
 * time. Slot semantics use an extensible `resourceKey` string
 * (`DEFAULT_HEAVY_SCAN_RESOURCE = 'heavy-scan-atoms-neon'`) on reservation +
 * queue rows. A future Neon pg_advisory_lock layer can wrap these writers
 * without schema changes — the DB rows remain the operator-visible source of
 * truth; advisory locks would guard concurrent acquire attempts only.
 *
 * HISTORY CADENCE RECOMMENDATION (on-change primary, nightly supplementary):
 * Append immediately on any material cell change so regressions are visible
 * the moment they happen. Nightly snapshots (`appendNightlyRailStateHeartbeats`)
 * fill time-series gaps for unchanged cells so 60-day sparklines stay regular
 * without duplicating same-day change snapshots.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db as prodDb,
  railStateHistory,
  railVerification,
  manifestRun,
  manifestSlotReservation,
  manifestSlotQueue,
  manifestJurisdictionCost,
  type RailStateHistoryInsert,
  type RailVerificationInsert,
  type ManifestRunInsert,
} from "@workspace/db";

type Db = typeof prodDb;

export const DEFAULT_HEAVY_SCAN_RESOURCE = "heavy-scan-atoms-neon";

export type RailSnapshotReason = "cell-change" | "nightly" | "manual";
export type VerificationMethod =
  | "sweep"
  | "sample"
  | "probe"
  | "derived"
  | "roster-load"
  | "unverified";
export type VerificationOutcome =
  | "confirmed-present"
  | "confirmed-absent"
  | "inconclusive"
  | "method-only";
export type ManifestRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type ManifestRunClass =
  | "acquisition"
  | "rewarm"
  | "verify"
  | "score"
  | "other";

export interface RailStateSnapshotInput {
  countyFips: string;
  railKey: string;
  railState: string | null;
  honestCoveragePct: string | number | null;
  thresholdPct: string | number | null;
  verifiedAt: Date | null;
  runId?: string | null;
  snapshotReason: RailSnapshotReason;
}

export interface RailVerificationInput {
  countyFips: string;
  railKey: string;
  verifiedAt: Date;
  verifiedByInstrument: string;
  verificationMethod: VerificationMethod;
  verificationOutcome: VerificationOutcome;
  artifactPath?: string | null;
  runId?: string | null;
  notes?: string | null;
}

export interface StartManifestRunInput {
  lane: string;
  job: string;
  stage: string;
  targetFips?: string | null;
  targetCity?: string | null;
  cohort?: string | null;
  scopeLabel?: string | null;
  itemsTotal?: number | null;
  holdsHeavySlot?: boolean;
  runClass?: ManifestRunClass;
  artifactPath?: string | null;
  notes?: string | null;
}

export interface ManifestRunProgressInput {
  runId: string;
  stage: string;
  itemsDone?: number | null;
  itemsTotal?: number | null;
  artifactPath?: string | null;
  notes?: string | null;
}

export interface ManifestRunCostInput {
  computeSeconds?: number | null;
  dbSeconds?: number | null;
  egressBytes?: number | null;
  externalApiCalls?: number | null;
  humanMinutes?: number | null;
  costUsd?: number | null;
}

function numStr(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? v.toFixed(2) : v;
}

function snapshotsMateriallyEqual(
  prev: {
    railState: string | null;
    honestCoveragePct: string | null;
    thresholdPct: string | null;
    verifiedAt: Date | null;
  },
  next: RailStateSnapshotInput,
): boolean {
  return (
    prev.railState === next.railState &&
    prev.honestCoveragePct === numStr(next.honestCoveragePct) &&
    prev.thresholdPct === numStr(next.thresholdPct) &&
    (prev.verifiedAt?.getTime() ?? null) ===
      (next.verifiedAt?.getTime() ?? null)
  );
}

/** Append a rail_state_history row unconditionally. */
export async function appendRailStateSnapshot(
  input: RailStateSnapshotInput,
  db: Db = prodDb,
): Promise<string> {
  const row: RailStateHistoryInsert = {
    countyFips: input.countyFips,
    railKey: input.railKey,
    railState: input.railState,
    honestCoveragePct: numStr(input.honestCoveragePct),
    thresholdPct: numStr(input.thresholdPct),
    verifiedAt: input.verifiedAt,
    runId: input.runId ?? null,
    snapshotReason: input.snapshotReason,
  };
  const [inserted] = await db
    .insert(railStateHistory)
    .values(row)
    .returning({ id: railStateHistory.id });
  return inserted.id;
}

/**
 * Append only when the snapshot differs from the latest history row for this
 * cell. Returns null when skipped (no material change).
 */
export async function appendRailStateSnapshotIfChanged(
  input: RailStateSnapshotInput,
  db: Db = prodDb,
): Promise<string | null> {
  const [latest] = await db
    .select({
      railState: railStateHistory.railState,
      honestCoveragePct: railStateHistory.honestCoveragePct,
      thresholdPct: railStateHistory.thresholdPct,
      verifiedAt: railStateHistory.verifiedAt,
    })
    .from(railStateHistory)
    .where(
      and(
        eq(railStateHistory.countyFips, input.countyFips),
        eq(railStateHistory.railKey, input.railKey),
      ),
    )
    .orderBy(desc(railStateHistory.recordedAt))
    .limit(1);

  if (latest && snapshotsMateriallyEqual(latest, input)) {
    return null;
  }

  return appendRailStateSnapshot(
    { ...input, snapshotReason: input.snapshotReason ?? "cell-change" },
    db,
  );
}

/**
 * Nightly heartbeats: one snapshot per cell that has NO snapshot yet today
 * (UTC). Does not duplicate cells already written by on-change writers.
 */
export async function appendNightlyRailStateHeartbeats(
  cells: RailStateSnapshotInput[],
  db: Db = prodDb,
): Promise<number> {
  let written = 0;
  for (const cell of cells) {
    const [existingToday] = await db
      .select({ id: railStateHistory.id })
      .from(railStateHistory)
      .where(
        and(
          eq(railStateHistory.countyFips, cell.countyFips),
          eq(railStateHistory.railKey, cell.railKey),
          sql`${railStateHistory.recordedAt} >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
        ),
      )
      .limit(1);

    if (existingToday) continue;

    await appendRailStateSnapshot(
      { ...cell, snapshotReason: "nightly" },
      db,
    );
    written += 1;
  }
  return written;
}

/** Record a verification event. No row prior = never verified (honest). */
export async function recordRailVerification(
  input: RailVerificationInput,
  db: Db = prodDb,
): Promise<string> {
  const row: RailVerificationInsert = {
    countyFips: input.countyFips,
    railKey: input.railKey,
    verifiedAt: input.verifiedAt,
    verifiedByInstrument: input.verifiedByInstrument,
    verificationMethod: input.verificationMethod,
    verificationOutcome: input.verificationOutcome,
    artifactPath: input.artifactPath ?? null,
    runId: input.runId ?? null,
    notes: input.notes ?? null,
  };
  const [inserted] = await db
    .insert(railVerification)
    .values(row)
    .returning({ id: railVerification.id });
  return inserted.id;
}

/** Latest verification for a cell, or null if never verified. */
export async function getLatestRailVerification(
  countyFips: string,
  railKey: string,
  db: Db = prodDb,
) {
  const [row] = await db
    .select()
    .from(railVerification)
    .where(
      and(
        eq(railVerification.countyFips, countyFips),
        eq(railVerification.railKey, railKey),
      ),
    )
    .orderBy(desc(railVerification.verifiedAt))
    .limit(1);
  return row ?? null;
}

export async function startManifestRun(
  input: StartManifestRunInput,
  db: Db = prodDb,
): Promise<string> {
  const row: ManifestRunInsert = {
    lane: input.lane,
    job: input.job,
    stage: input.stage,
    targetFips: input.targetFips ?? null,
    targetCity: input.targetCity ?? null,
    cohort: input.cohort ?? null,
    scopeLabel: input.scopeLabel ?? null,
    itemsTotal: input.itemsTotal ?? null,
    holdsHeavySlot: input.holdsHeavySlot ?? false,
    runClass: input.runClass ?? "other",
    artifactPath: input.artifactPath ?? null,
    notes: input.notes ?? null,
    status: "running",
  };
  const [inserted] = await db
    .insert(manifestRun)
    .values(row)
    .returning({ id: manifestRun.id });
  return inserted.id;
}

export async function updateManifestRunProgress(
  input: ManifestRunProgressInput,
  db: Db = prodDb,
): Promise<void> {
  await db
    .update(manifestRun)
    .set({
      stage: input.stage,
      heartbeatAt: new Date(),
      ...(input.itemsDone !== undefined ? { itemsDone: input.itemsDone } : {}),
      ...(input.itemsTotal !== undefined ? { itemsTotal: input.itemsTotal } : {}),
      ...(input.artifactPath !== undefined
        ? { artifactPath: input.artifactPath }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    })
    .where(eq(manifestRun.id, input.runId));
}

export async function completeManifestRun(
  runId: string,
  outcome: {
    status: Exclude<ManifestRunStatus, "running">;
    outcome?: string | null;
    artifactPath?: string | null;
    cost?: ManifestRunCostInput;
  },
  db: Db = prodDb,
): Promise<void> {
  const now = new Date();
  await db
    .update(manifestRun)
    .set({
      status: outcome.status,
      outcome: outcome.outcome ?? null,
      completedAt: now,
      heartbeatAt: now,
      ...(outcome.artifactPath !== undefined
        ? { artifactPath: outcome.artifactPath }
        : {}),
      ...(outcome.cost?.computeSeconds != null
        ? { computeSeconds: String(outcome.cost.computeSeconds) }
        : {}),
      ...(outcome.cost?.dbSeconds != null
        ? { dbSeconds: String(outcome.cost.dbSeconds) }
        : {}),
      ...(outcome.cost?.egressBytes != null
        ? { egressBytes: outcome.cost.egressBytes }
        : {}),
      ...(outcome.cost?.externalApiCalls != null
        ? { externalApiCalls: outcome.cost.externalApiCalls }
        : {}),
      ...(outcome.cost?.humanMinutes != null
        ? { humanMinutes: String(outcome.cost.humanMinutes) }
        : {}),
      ...(outcome.cost?.costUsd != null
        ? { costUsd: String(outcome.cost.costUsd) }
        : {}),
    })
    .where(eq(manifestRun.id, runId));
}

/** Running manifest runs for the LIVE panel. */
export async function listRunningManifestRuns(db: Db = prodDb) {
  return db
    .select()
    .from(manifestRun)
    .where(eq(manifestRun.status, "running"))
    .orderBy(desc(manifestRun.startedAt));
}

export async function acquireManifestSlot(
  resourceKey: string,
  holderRunId: string,
  db: Db = prodDb,
): Promise<string> {
  const [inserted] = await db
    .insert(manifestSlotReservation)
    .values({ resourceKey, holderRunId })
    .returning({ id: manifestSlotReservation.id });

  await db
    .update(manifestRun)
    .set({ holdsHeavySlot: true, heartbeatAt: new Date() })
    .where(eq(manifestRun.id, holderRunId));

  return inserted.id;
}

export async function releaseManifestSlot(
  resourceKey: string,
  holderRunId: string,
  db: Db = prodDb,
): Promise<void> {
  const now = new Date();
  await db
    .update(manifestSlotReservation)
    .set({ releasedAt: now })
    .where(
      and(
        eq(manifestSlotReservation.resourceKey, resourceKey),
        eq(manifestSlotReservation.holderRunId, holderRunId),
        isNull(manifestSlotReservation.releasedAt),
      ),
    );

  await db
    .update(manifestRun)
    .set({ holdsHeavySlot: false, heartbeatAt: now })
    .where(eq(manifestRun.id, holderRunId));
}

export async function getActiveManifestSlotHolder(
  resourceKey: string,
  db: Db = prodDb,
) {
  const [row] = await db
    .select()
    .from(manifestSlotReservation)
    .where(
      and(
        eq(manifestSlotReservation.resourceKey, resourceKey),
        isNull(manifestSlotReservation.releasedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function enqueueManifestSlot(
  resourceKey: string,
  runId: string,
  db: Db = prodDb,
): Promise<number> {
  const [maxRow] = await db
    .select({
      maxPos: sql<number>`coalesce(max(${manifestSlotQueue.queuePosition}), 0)`,
    })
    .from(manifestSlotQueue)
    .where(
      and(
        eq(manifestSlotQueue.resourceKey, resourceKey),
        isNull(manifestSlotQueue.dequeuedAt),
      ),
    );

  const queuePosition = Number(maxRow?.maxPos ?? 0) + 1;
  await db.insert(manifestSlotQueue).values({
    resourceKey,
    runId,
    queuePosition,
  });
  return queuePosition;
}

export async function listManifestSlotQueue(
  resourceKey: string,
  db: Db = prodDb,
) {
  return db
    .select()
    .from(manifestSlotQueue)
    .where(
      and(
        eq(manifestSlotQueue.resourceKey, resourceKey),
        isNull(manifestSlotQueue.dequeuedAt),
      ),
    )
    .orderBy(manifestSlotQueue.queuePosition);
}

export async function dequeueManifestSlotEntry(
  queueEntryId: string,
  db: Db = prodDb,
): Promise<void> {
  await db
    .update(manifestSlotQueue)
    .set({ dequeuedAt: new Date() })
    .where(eq(manifestSlotQueue.id, queueEntryId));
}

/**
 * Apply run cost to jurisdiction counters. Re-warm runs (`runClass=rewarm` or
 * `countsTowardCommitment=false`) increment lifetime only. First successful
 * acquisition sets commitment_cost_usd once.
 */
export async function applyManifestRunCostToJurisdiction(
  countyFips: string,
  runId: string,
  costUsd: number,
  opts: { countsTowardCommitment: boolean; isSuccessfulAcquisition: boolean },
  db: Db = prodDb,
): Promise<void> {
  const costStr = costUsd.toFixed(2);
  const now = new Date();

  const [existing] = await db
    .select()
    .from(manifestJurisdictionCost)
    .where(eq(manifestJurisdictionCost.countyFips, countyFips))
    .limit(1);

  if (!existing) {
    await db.insert(manifestJurisdictionCost).values({
      countyFips,
      lifetimeCostUsd: costStr,
      commitmentCostUsd:
        opts.countsTowardCommitment && opts.isSuccessfulAcquisition
          ? costStr
          : null,
      firstAcquisitionRunId:
        opts.countsTowardCommitment && opts.isSuccessfulAcquisition
          ? runId
          : null,
      firstAcquisitionRecordedAt:
        opts.countsTowardCommitment && opts.isSuccessfulAcquisition ? now : null,
      updatedAt: now,
    });
    return;
  }

  const lifetime =
    Number(existing.lifetimeCostUsd ?? 0) + costUsd;

  const setCommitment =
    opts.countsTowardCommitment &&
    opts.isSuccessfulAcquisition &&
    existing.commitmentCostUsd == null;

  await db
    .update(manifestJurisdictionCost)
    .set({
      lifetimeCostUsd: lifetime.toFixed(2),
      updatedAt: now,
      ...(setCommitment
        ? {
            commitmentCostUsd: costStr,
            firstAcquisitionRunId: runId,
            firstAcquisitionRecordedAt: now,
          }
        : {}),
    })
    .where(eq(manifestJurisdictionCost.countyFips, countyFips));
}

export async function getManifestJurisdictionCost(
  countyFips: string,
  db: Db = prodDb,
) {
  const [row] = await db
    .select()
    .from(manifestJurisdictionCost)
    .where(eq(manifestJurisdictionCost.countyFips, countyFips))
    .limit(1);
  return row ?? null;
}
