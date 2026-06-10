import {
  db,
  atomCalibrationOverlay,
  reasoningAtoms,
  PUBLIC_CALIBRATION_TENANT,
  type CalibrationPartitionKind,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  canonicalOverlayAtomKey,
  canonicalOverlayKeyFromCodeToken,
  isReasoningOverlayAtomId,
  overlayAtomLookupKey,
} from "@workspace/codes";
import { computePartitionCalibration } from "./compute";
import { partitionForSignal } from "./partition";
import { stampsMatch, stampFromFields } from "./stamp";
import {
  collectCalibrationSignals,
  loadAtomAccessContexts,
  type AtomAccessContext,
} from "./signals";
import {
  assertedBaselineFromSourceType,
  atomClassFromCodeRef,
} from "./corpusBaseline";
import type { OverlayCalibrationRow } from "./types";

export function effectiveConfidence(args: {
  assertedConfidence: number;
  calibratedConfidence: number | null;
  calibrationStale: boolean;
}): { value: number; grade: "asserted" | "calibrated" | "stale" } {
  if (args.calibrationStale) {
    return { value: args.assertedConfidence, grade: "stale" };
  }
  if (args.calibratedConfidence != null) {
    return { value: args.calibratedConfidence, grade: "calibrated" };
  }
  return { value: args.assertedConfidence, grade: "asserted" };
}

function groupKey(
  overlayTenant: string,
  atomId: string,
  atomClass: string,
): string {
  return `${overlayTenant}\0${atomId}\0${atomClass}`;
}

export async function recomputeCalibrationOverlay(): Promise<{
  rowsWritten: number;
}> {
  const signals = await collectCalibrationSignals();
  const buckets = new Map<
    string,
    {
      overlayTenant: string;
      partitionKind: CalibrationPartitionKind;
      atomId: string;
      atomClass: string;
      accessPolicy: string;
      sharedWithTenants: string[] | null;
      atomSignals: typeof signals;
      classSignals: typeof signals;
      context: AtomAccessContext | undefined;
    }
  >();

  const atomIds = [...new Set(signals.map((s) => s.atomId))];
  const contexts = await loadAtomAccessContexts(atomIds);

  for (const signal of signals) {
    const ctx = contexts.get(signal.atomId);
    const { overlayTenant, partitionKind } = partitionForSignal({
      accessPolicy: signal.accessPolicy,
      jurisdictionTenant: signal.jurisdictionTenant,
      sharedWithTenants: signal.sharedWithTenants,
    });
    const key = groupKey(overlayTenant, signal.atomId, signal.atomClass);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        overlayTenant,
        partitionKind,
        atomId: signal.atomId,
        atomClass: signal.atomClass,
        accessPolicy: signal.accessPolicy,
        sharedWithTenants: signal.sharedWithTenants,
        atomSignals: [],
        classSignals: [],
        context: ctx,
      };
      buckets.set(key, bucket);
    }
    bucket.atomSignals.push(signal);
  }

  for (const bucket of buckets.values()) {
    for (const signal of bucket.atomSignals) {
      const classKey = groupKey(
        bucket.overlayTenant,
        "__class__",
        signal.atomClass,
      );
      let classBucket = buckets.get(classKey);
      if (!classBucket) {
        classBucket = {
          overlayTenant: bucket.overlayTenant,
          partitionKind: bucket.partitionKind,
          atomId: bucket.atomId,
          atomClass: signal.atomClass,
          accessPolicy: bucket.accessPolicy,
          sharedWithTenants: bucket.sharedWithTenants,
          atomSignals: [],
          classSignals: [],
          context: bucket.context,
        };
        buckets.set(classKey, classBucket);
      }
      classBucket.classSignals.push(signal);
    }
  }

  let rowsWritten = 0;
  const now = new Date();

  for (const bucket of buckets.values()) {
    if (bucket.atomId === "__class__") continue;
    const classBucket = buckets.get(
      groupKey(bucket.overlayTenant, "__class__", bucket.atomClass),
    );
    const classSignals = classBucket?.classSignals ?? bucket.atomSignals;
    const ctx = bucket.context;
    const asserted =
      ctx?.assertedConfidence ??
      computePartitionCalibration(bucket.atomSignals, classSignals)
        .assertedConfidence;

    const computed = computePartitionCalibration(
      bucket.atomSignals,
      classSignals,
    );
    const stamp = stampFromFields({
      codeRef: ctx?.codeRef ?? bucket.atomSignals[0]?.stamp.codeRef ?? null,
      edition: ctx?.edition ?? bucket.atomSignals[0]?.stamp.edition ?? null,
      sourceSetVersion:
        ctx?.sourceSetVersion ??
        bucket.atomSignals[0]?.stamp.sourceSetVersion ??
        1,
    });

    const existing = await db
      .select()
      .from(atomCalibrationOverlay)
      .where(
        and(
          eq(atomCalibrationOverlay.atomId, bucket.atomId),
          eq(atomCalibrationOverlay.jurisdictionTenant, bucket.overlayTenant),
        ),
      )
      .limit(1);

    const storedStamp = stampFromFields({
      codeRef: existing[0]?.codeRef ?? null,
      edition: existing[0]?.edition ?? null,
      sourceSetVersion: Number(existing[0]?.sourceSetVersion ?? 1),
    });
    const stale =
      existing[0] != null &&
      existing[0].calibratedConfidence != null &&
      !stampsMatch(stamp, storedStamp);

    const calibratedValue = stale ? null : computed.calibratedConfidence;

    await db
      .insert(atomCalibrationOverlay)
      .values({
        atomId: bucket.atomId,
        jurisdictionTenant: bucket.overlayTenant,
        partitionKind: bucket.partitionKind,
        accessPolicy: bucket.accessPolicy,
        sharedWithTenants: bucket.sharedWithTenants,
        assertedConfidence: String(asserted),
        calibratedConfidence:
          calibratedValue != null ? String(calibratedValue) : null,
        codeRef: stamp.codeRef || null,
        edition: stamp.edition || null,
        sourceSetVersion: stamp.sourceSetVersion,
        calibrationStale: stale,
        calibrationGrain: computed.calibrationGrain,
        atomClass: bucket.atomClass,
        signalCount: computed.signalCount,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          atomCalibrationOverlay.atomId,
          atomCalibrationOverlay.jurisdictionTenant,
        ],
        set: {
          partitionKind: bucket.partitionKind,
          accessPolicy: bucket.accessPolicy,
          sharedWithTenants: bucket.sharedWithTenants,
          assertedConfidence: String(asserted),
          calibratedConfidence:
            calibratedValue != null ? String(calibratedValue) : null,
          codeRef: stamp.codeRef || null,
          edition: stamp.edition || null,
          sourceSetVersion: stamp.sourceSetVersion,
          calibrationStale: stale,
          calibrationGrain: computed.calibrationGrain,
          atomClass: bucket.atomClass,
          signalCount: computed.signalCount,
          updatedAt: now,
        },
      });
    rowsWritten += 1;

    if (isReasoningOverlayAtomId(bucket.atomId) && bucket.overlayTenant === PUBLIC_CALIBRATION_TENANT) {
      await db
        .update(reasoningAtoms)
        .set({
          calibratedConfidence:
            calibratedValue != null ? String(calibratedValue) : null,
          calibrationStale: stale,
          updatedAt: now,
        })
        .where(eq(reasoningAtoms.id, bucket.atomId));
    }
  }

  return { rowsWritten };
}

export async function ensureCorpusOverlayRow(args: {
  atomId: string;
  jurisdictionTenant?: string;
  sourceType?: string | null;
  codeRef?: string | null;
  edition?: string | null;
}): Promise<void> {
  const atomId = canonicalOverlayAtomKey(args.atomId);
  const tenant = args.jurisdictionTenant ?? PUBLIC_CALIBRATION_TENANT;
  const asserted = assertedBaselineFromSourceType(args.sourceType ?? null);
  const now = new Date();
  await db
    .insert(atomCalibrationOverlay)
    .values({
      atomId,
      jurisdictionTenant: tenant,
      partitionKind: "public",
      accessPolicy: "public-free",
      assertedConfidence: String(asserted),
      codeRef: args.codeRef ?? null,
      edition: args.edition ?? null,
      atomClass: atomClassFromCodeRef(args.codeRef ?? null),
      updatedAt: now,
    })
    .onConflictDoNothing();
}

export async function resolveOverlayCalibration(args: {
  atomId: string;
  jurisdictionTenant: string;
}): Promise<OverlayCalibrationRow | null> {
  const atomKey = canonicalOverlayAtomKey(args.atomId);
  const lookupKeys = [
    overlayAtomLookupKey({
      jurisdictionTenant: args.jurisdictionTenant,
      atomId: atomKey,
    }),
    overlayAtomLookupKey({
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      atomId: atomKey,
    }),
  ];

  for (const key of lookupKeys) {
    const sep = key.indexOf("\0");
    const tenant = key.slice(0, sep);
    const atomId = key.slice(sep + 1);
    const [row] = await db
      .select()
      .from(atomCalibrationOverlay)
      .where(
        and(
          eq(atomCalibrationOverlay.atomId, atomId),
          eq(atomCalibrationOverlay.jurisdictionTenant, tenant),
        ),
      )
      .limit(1);
    if (!row) continue;

    if (isReasoningOverlayAtomId(atomId)) {
      const [reasoning] = await db
        .select()
        .from(reasoningAtoms)
        .where(eq(reasoningAtoms.id, atomId))
        .limit(1);
      if (reasoning) {
        const stamp = stampFromFields({
          codeRef: reasoning.codeRef,
          edition: reasoning.edition,
          sourceSetVersion: Number(reasoning.sourceSetVersion ?? 1),
        });
        const storedStamp = stampFromFields({
          codeRef: row.codeRef,
          edition: row.edition,
          sourceSetVersion: Number(row.sourceSetVersion ?? 1),
        });
        const stale =
          Boolean(reasoning.calibrationStale) ||
          (row.calibratedConfidence != null && !stampsMatch(stamp, storedStamp));
        const asserted = Number(reasoning.assertedConfidence);
        const calibrated =
          row.calibratedConfidence != null
            ? Number(row.calibratedConfidence)
            : reasoning.calibratedConfidence != null
              ? Number(reasoning.calibratedConfidence)
              : null;
        const eff = effectiveConfidence({
          assertedConfidence: asserted,
          calibratedConfidence: calibrated,
          calibrationStale: stale,
        });
        return {
          atomId,
          jurisdictionTenant: tenant,
          partitionKind: row.partitionKind as CalibrationPartitionKind,
          accessPolicy: row.accessPolicy,
          sharedWithTenants: (row.sharedWithTenants as string[] | null) ?? null,
          assertedConfidence: asserted,
          calibratedConfidence: calibrated,
          effectiveConfidence: eff.value,
          calibrationGrade: eff.grade,
          codeRef: row.codeRef,
          edition: row.edition,
          sourceSetVersion: Number(row.sourceSetVersion ?? 1),
          calibrationStale: stale,
          calibrationGrain: row.calibrationGrain as "atom" | "class",
          atomClass: row.atomClass,
          signalCount: row.signalCount,
        };
      }
    }

    const asserted = Number(row.assertedConfidence);
    const calibrated =
      row.calibratedConfidence != null
        ? Number(row.calibratedConfidence)
        : null;
    const eff = effectiveConfidence({
      assertedConfidence: asserted,
      calibratedConfidence: calibrated,
      calibrationStale: row.calibrationStale,
    });
    return {
      atomId,
      jurisdictionTenant: tenant,
      partitionKind: row.partitionKind as CalibrationPartitionKind,
      accessPolicy: row.accessPolicy,
      sharedWithTenants: (row.sharedWithTenants as string[] | null) ?? null,
      assertedConfidence: asserted,
      calibratedConfidence: calibrated,
      effectiveConfidence: eff.value,
      calibrationGrade: eff.grade,
      codeRef: row.codeRef,
      edition: row.edition,
      sourceSetVersion: Number(row.sourceSetVersion ?? 1),
      calibrationStale: row.calibrationStale,
      calibrationGrain: row.calibrationGrain as "atom" | "class",
      atomClass: row.atomClass,
      signalCount: row.signalCount,
    };
  }

  return null;
}

export async function listOverlayRows(options?: {
  jurisdictionTenant?: string | null;
  atomIds?: string[];
}): Promise<OverlayCalibrationRow[]> {
  const tenantFilter = (options?.jurisdictionTenant ?? "").trim() || null;
  const atomFilter = options?.atomIds?.map(canonicalOverlayAtomKey);

  const rows = await db.select().from(atomCalibrationOverlay);
  const out: OverlayCalibrationRow[] = [];
  for (const row of rows) {
    if (tenantFilter && row.jurisdictionTenant !== tenantFilter) continue;
    if (atomFilter && !atomFilter.includes(row.atomId)) continue;
    const asserted = Number(row.assertedConfidence);
    const calibrated =
      row.calibratedConfidence != null
        ? Number(row.calibratedConfidence)
        : null;
    const eff = effectiveConfidence({
      assertedConfidence: asserted,
      calibratedConfidence: calibrated,
      calibrationStale: row.calibrationStale,
    });
    out.push({
      atomId: row.atomId,
      jurisdictionTenant: row.jurisdictionTenant,
      partitionKind: row.partitionKind as CalibrationPartitionKind,
      accessPolicy: row.accessPolicy,
      sharedWithTenants: (row.sharedWithTenants as string[] | null) ?? null,
      assertedConfidence: asserted,
      calibratedConfidence: calibrated,
      effectiveConfidence: eff.value,
      calibrationGrade: eff.grade,
      codeRef: row.codeRef,
      edition: row.edition,
      sourceSetVersion: Number(row.sourceSetVersion ?? 1),
      calibrationStale: row.calibrationStale,
      calibrationGrain: row.calibrationGrain as "atom" | "class",
      atomClass: row.atomClass,
      signalCount: row.signalCount,
    });
  }
  out.sort((a, b) => {
    const t = a.jurisdictionTenant.localeCompare(b.jurisdictionTenant);
    if (t !== 0) return t;
    return a.atomId.localeCompare(b.atomId);
  });
  return out;
}

export function resolveOverlayKeyFromStructuredRef(
  token: string,
): string | null {
  return canonicalOverlayKeyFromCodeToken(token);
}

export async function seedReasoningOverlayFromAtom(args: {
  reasoningAtomId: string;
  jurisdictionTenant?: string;
}): Promise<void> {
  const [row] = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.id, args.reasoningAtomId))
    .limit(1);
  if (!row) return;
  const tenant = args.jurisdictionTenant ?? PUBLIC_CALIBRATION_TENANT;
  await db
    .insert(atomCalibrationOverlay)
    .values({
      atomId: row.id,
      jurisdictionTenant: tenant,
      partitionKind: "public",
      accessPolicy: row.accessPolicy,
      assertedConfidence: row.assertedConfidence,
      codeRef: row.codeRef,
      edition: row.edition,
      sourceSetVersion: Number(row.sourceSetVersion ?? 1),
      calibrationStale: row.calibrationStale,
      atomClass: atomClassFromCodeRef(row.codeRef),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
}

export async function invalidateStaleCalibrationForAtom(args: {
  atomId: string;
  codeRef: string;
  edition: string;
  sourceSetVersion: number;
}): Promise<void> {
  const atomKey = canonicalOverlayAtomKey(args.atomId);
  const rows = await db
    .select()
    .from(atomCalibrationOverlay)
    .where(eq(atomCalibrationOverlay.atomId, atomKey));

  const current = stampFromFields(args);
  for (const row of rows) {
    const stored = stampFromFields({
      codeRef: row.codeRef,
      edition: row.edition,
      sourceSetVersion: Number(row.sourceSetVersion ?? 1),
    });
    if (!stampsMatch(current, stored) && row.calibratedConfidence != null) {
      await db
        .update(atomCalibrationOverlay)
        .set({
          calibrationStale: true,
          calibratedConfidence: null,
          sourceSetVersion: args.sourceSetVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(atomCalibrationOverlay.atomId, atomKey),
            eq(atomCalibrationOverlay.jurisdictionTenant, row.jurisdictionTenant),
          ),
        );
    }
  }
}
