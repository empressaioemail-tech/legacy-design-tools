/**
 * Smart Files artifact store (OPS-17 PLAN-ROW G-14).
 *
 * The read/write surface over `smart_file_documents`, `smart_file_versions`,
 * and `smart_file_placements`. Three operations carry the promise:
 *
 *   `placeDocument`  — store once, place many. Placing an existing document at
 *                      a new target inserts ONE placement row and touches no
 *                      document or version row, so the artifact count is
 *                      invariant under re-placement.
 *   `reviseDocument` — revise once, current everywhere, prior version retained.
 *                      INSERTS a version and moves the document pointer in ONE
 *                      transaction. It never updates or deletes an existing
 *                      version, so history survives by construction, and it
 *                      never writes per-placement, so every placement is
 *                      current on the next read with no partial-failure window.
 *   `readDocument`   — stamps every read with source, computedAt and servedAt,
 *                      and a STALE verdict. There is no read path that returns
 *                      content without a stamp.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (scope boundary, stated so a successor can
 * tell an exclusion from an oversight):
 *   - No typed absence. `readDocument` returns null for a document that is not
 *     held; converting that into a typed absence carrying its basis is G-34.
 *     Until then callers MUST NOT render a null as a data gap.
 *   - No corpus capture (G-44) and no coverage counting (G-20).
 *   - No surface. Nothing here is deployed or served to a customer, so nothing
 *     here satisfies DEV_PROCESS 4.4.
 *   - No per-tenant ENFORCEMENT of accessPolicy. The column is resolved at read
 *     and returned; enforcing it across tenants is gated on G-11 / S-1.
 *   - No blob bytes. `contentCid` is minted by the engine document-ingest
 *     pinBlob over the ENGINE_API_URL seam (operator ruling OR-A2); this store
 *     records the CID and never re-implements content addressing.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  smartFileDocuments,
  smartFilePlacements,
  smartFileVersions,
  type SmartFileAccessPolicyValue,
  type SmartFilePlacementTargetType,
} from "@workspace/db";

import {
  buildSmartFileEntityId,
  evaluateSmartFileFreshness,
  type SmartFileFreshness,
  type SmartFileProvenance,
  SMART_FILE_PROVENANCE_SCHEMA,
} from "../atoms/smart-file.contract";

export interface CreateSmartFileInput {
  jurisdictionFips: string;
  docSlug: string;
  title: string;
  accessPolicy: SmartFileAccessPolicyValue;
  contentCid: string;
  contentType: string;
  byteSize: number;
  provenance: SmartFileProvenance;
  /** When the content was established. Defaults to now. */
  computedAt?: Date;
}

export interface PlaceSmartFileInput {
  entityId: string;
  targetType: SmartFilePlacementTargetType;
  targetId: string;
  placedBy?: string | null;
}

export interface ReviseSmartFileInput {
  entityId: string;
  contentCid: string;
  contentType: string;
  byteSize: number;
  provenance: SmartFileProvenance;
  computedAt?: Date;
}

export interface SmartFileVersionView {
  version: number;
  contentCid: string;
  contentType: string;
  byteSize: number;
  provenance: SmartFileProvenance;
  computedAt: string;
  supersededAt: string | null;
}

export interface SmartFileReadView {
  entityId: string;
  jurisdictionFips: string;
  docSlug: string;
  title: string;
  accessPolicy: SmartFileAccessPolicyValue;
  currentVersion: number;
  version: SmartFileVersionView;
  provenance: SmartFileProvenance;
  freshness: SmartFileFreshness;
  placements: ReadonlyArray<{
    targetType: SmartFilePlacementTargetType;
    targetId: string;
    placedAt: string;
    placedBy: string | null;
  }>;
}

function parseProvenance(raw: unknown): SmartFileProvenance {
  // Parsed on the way OUT as well as in: a row written before a provenance
  // shape change must fail loudly here rather than serve a half-populated
  // stamp. A cache without a trustworthy stamp is a liar waiting for load.
  return SMART_FILE_PROVENANCE_SCHEMA.parse(raw) as SmartFileProvenance;
}

/**
 * Create a document at version 1. Idempotent on the declared entityId: a second
 * create of the same document returns the existing one rather than minting a
 * second identity (the store-once guarantee, backstopped by the unique index).
 */
export async function createDocument(
  input: CreateSmartFileInput,
): Promise<{ entityId: string; created: boolean }> {
  const entityId = buildSmartFileEntityId({
    jurisdictionFips: input.jurisdictionFips,
    docSlug: input.docSlug,
  });
  // Validate before any write: an unsourced document must never land.
  const provenance = parseProvenance(input.provenance);
  const computedAt = input.computedAt ?? new Date();

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: smartFileDocuments.id })
      .from(smartFileDocuments)
      .where(eq(smartFileDocuments.entityId, entityId))
      .limit(1);

    if (existing.length > 0) {
      return { entityId, created: false };
    }

    const [doc] = await tx
      .insert(smartFileDocuments)
      .values({
        entityId,
        jurisdictionFips: input.jurisdictionFips,
        docSlug: input.docSlug,
        title: input.title,
        accessPolicy: input.accessPolicy,
        currentVersion: 1,
      })
      .returning({ id: smartFileDocuments.id });

    await tx.insert(smartFileVersions).values({
      documentId: doc.id,
      documentEntityId: entityId,
      version: 1,
      contentCid: input.contentCid,
      contentType: input.contentType,
      byteSize: input.byteSize,
      provenance,
      computedAt,
      supersededAt: null,
    });

    return { entityId, created: true };
  });
}

/**
 * Place a document at a target. STORE ONCE, PLACE MANY.
 *
 * Inserts exactly one placement row and touches neither the document nor any
 * version, so the artifact row count does not rise when a document is placed
 * again. Idempotent on (document, targetType, targetId) so a repeated placement
 * does not inflate the placement count either.
 */
export async function placeDocument(
  input: PlaceSmartFileInput,
): Promise<{ placed: boolean }> {
  const [doc] = await db
    .select({ id: smartFileDocuments.id })
    .from(smartFileDocuments)
    .where(eq(smartFileDocuments.entityId, input.entityId))
    .limit(1);

  if (!doc) {
    // A positive failure, not a silent no-op: placing into a document that is
    // not held must never look like a successful placement.
    throw new Error(
      `smart-file placement: no document for entityId ${JSON.stringify(input.entityId)}`,
    );
  }

  const inserted = await db
    .insert(smartFilePlacements)
    .values({
      documentId: doc.id,
      documentEntityId: input.entityId,
      targetType: input.targetType,
      targetId: input.targetId,
      placedBy: input.placedBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: smartFilePlacements.id });

  return { placed: inserted.length > 0 };
}

/**
 * Revise a document. REVISE ONCE, CURRENT EVERYWHERE, PRIOR VERSION RETAINED.
 *
 * In one transaction: stamp the outgoing version's `superseded_at`, INSERT the
 * new version, and move the document's `current_version` pointer. The prior
 * version row is never deleted and its content is never overwritten — only its
 * supersession is recorded, which is a positive fact rather than an inference.
 *
 * No placement row is written. Every placement references the DOCUMENT, so all
 * of them are current on the next read; there is no per-placement fan-out that
 * could partially fail and leave placements disagreeing.
 */
export async function reviseDocument(
  input: ReviseSmartFileInput,
): Promise<{ version: number }> {
  const provenance = parseProvenance(input.provenance);
  const computedAt = input.computedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({
        id: smartFileDocuments.id,
        currentVersion: smartFileDocuments.currentVersion,
      })
      .from(smartFileDocuments)
      .where(eq(smartFileDocuments.entityId, input.entityId))
      .limit(1)
      .for("update");

    if (!doc) {
      throw new Error(
        `smart-file revision: no document for entityId ${JSON.stringify(input.entityId)}`,
      );
    }

    const nextVersion = doc.currentVersion + 1;

    // Record supersession on the outgoing version. An UPDATE of the
    // `superseded_at` column only — content is never touched.
    await tx
      .update(smartFileVersions)
      .set({ supersededAt: computedAt })
      .where(
        and(
          eq(smartFileVersions.documentId, doc.id),
          eq(smartFileVersions.version, doc.currentVersion),
        ),
      );

    await tx.insert(smartFileVersions).values({
      documentId: doc.id,
      documentEntityId: input.entityId,
      version: nextVersion,
      contentCid: input.contentCid,
      contentType: input.contentType,
      byteSize: input.byteSize,
      provenance,
      computedAt,
      supersededAt: null,
    });

    await tx
      .update(smartFileDocuments)
      .set({ currentVersion: nextVersion, updatedAt: computedAt })
      .where(eq(smartFileDocuments.id, doc.id));

    return { version: nextVersion };
  });
}

/**
 * Read a document at its current version, or at an explicit prior version.
 *
 * Every successful read is stamped: source (provenance), `computedAt`, and
 * `servedAt`, plus a STALE verdict from the proven-in-both-directions
 * evaluator. `servedAt` is taken at serve time and never stored.
 *
 * Returns null when the document or the requested version is not held. That
 * null is NOT a typed absence and callers must not render it as a data gap —
 * typed absence with a basis is G-34.
 */
export async function readDocument(input: {
  entityId: string;
  /** Read a specific prior version. Defaults to the current one. */
  version?: number;
  servedAt?: Date;
  stalenessThresholdSeconds?: number;
}): Promise<SmartFileReadView | null> {
  const [doc] = await db
    .select()
    .from(smartFileDocuments)
    .where(eq(smartFileDocuments.entityId, input.entityId))
    .limit(1);

  if (!doc) return null;

  const wantVersion = input.version ?? doc.currentVersion;

  const [version] = await db
    .select()
    .from(smartFileVersions)
    .where(
      and(
        eq(smartFileVersions.documentId, doc.id),
        eq(smartFileVersions.version, wantVersion),
      ),
    )
    .limit(1);

  if (!version) return null;

  const placements = await db
    .select()
    .from(smartFilePlacements)
    .where(eq(smartFilePlacements.documentId, doc.id))
    .orderBy(asc(smartFilePlacements.placedAt));

  const provenance = parseProvenance(version.provenance);
  const servedAt = input.servedAt ?? new Date();

  const freshness = evaluateSmartFileFreshness({
    computedAt: version.computedAt.toISOString(),
    servedAt: servedAt.toISOString(),
    stalenessThresholdSeconds: input.stalenessThresholdSeconds,
  });

  return {
    entityId: doc.entityId,
    jurisdictionFips: doc.jurisdictionFips,
    docSlug: doc.docSlug,
    title: doc.title,
    accessPolicy: doc.accessPolicy,
    currentVersion: doc.currentVersion,
    version: {
      version: version.version,
      contentCid: version.contentCid,
      contentType: version.contentType,
      byteSize: version.byteSize,
      provenance,
      computedAt: version.computedAt.toISOString(),
      supersededAt: version.supersededAt?.toISOString() ?? null,
    },
    provenance,
    freshness,
    placements: placements.map((p) => ({
      targetType: p.targetType,
      targetId: p.targetId,
      placedAt: p.placedAt.toISOString(),
      placedBy: p.placedBy,
    })),
  };
}

/**
 * Count artifact rows for a document — the direct instrument for the
 * store-once guarantee. Returns MEASURED counts, never a derived one
 * (DEV_PROCESS 1.3).
 *
 * Counting rules, stated at the point of use:
 *   `documents`  — rows in `smart_file_documents` for this declared entityId.
 *                  Must be exactly 1 however many times it is placed.
 *   `versions`   — rows in `smart_file_versions`. Rises only on revision.
 *   `placements` — rows in `smart_file_placements`. Rises only on placement.
 */
export async function countDocumentRows(entityId: string): Promise<{
  documents: number;
  versions: number;
  placements: number;
}> {
  const [docCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(smartFileDocuments)
    .where(eq(smartFileDocuments.entityId, entityId));

  const [versionCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(smartFileVersions)
    .where(eq(smartFileVersions.documentEntityId, entityId));

  const [placementCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(smartFilePlacements)
    .where(eq(smartFilePlacements.documentEntityId, entityId));

  return {
    documents: docCount?.n ?? 0,
    versions: versionCount?.n ?? 0,
    placements: placementCount?.n ?? 0,
  };
}
