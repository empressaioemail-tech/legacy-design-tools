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
 * TYPED ABSENCE (G-34, this row). `readDocument` no longer returns null. It
 * returns a `SmartFileReadResult` — a discriminated union with NO null member —
 * so a caller cannot reach content without narrowing on `status`, and the store
 * cannot return a bare null without a COMPILE error. The G-14 rule "callers must
 * not render a null as a data gap" was a doc comment; it is now the type system.
 *
 * The rule that makes the absence honest: ONLY A POSITIVE DETERMINATION WRITES
 * AN ABSENCE. `absent-verified` is producible only by reading a deliberately
 * written `smart_file_absence_determinations` row. An empty lookup returns
 * `not-sought` and writes NOTHING, so a never-attempted lookup can never
 * masquerade as a verified absence.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (scope boundary, stated so a successor can
 * tell an exclusion from an oversight):
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
  smartFileAbsenceDeterminations,
  smartFileDocuments,
  smartFilePlacements,
  smartFileVersions,
  type SmartFileAbsenceVerdict,
  type SmartFileAccessPolicyValue,
  type SmartFilePlacementTargetType,
} from "@workspace/db";

import {
  buildSmartFileEntityId,
  evaluateSmartFileFreshness,
  parseSmartFileEntityId,
  type SmartFileAbsence,
  type SmartFileFreshness,
  type SmartFileProvenance,
  type SmartFileReadResult,
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
 * Record an absence DETERMINATION — that we looked for a document and what we
 * concluded (G-34).
 *
 * This is the ONLY way an `absent-verified` status can ever be produced. The
 * inherited spine constraint is that only a POSITIVE determination writes an
 * absence: an empty or failed lookup re-enters the queue and does not become a
 * recorded absence. That rule is only real if "absent" cannot be synthesized
 * from a zero-row query, so the verdict must be a row something deliberately
 * wrote — this function is that deliberate act, and nothing else calls it.
 *
 * A re-determination UPDATES the existing row and moves `determinedAt` forward,
 * so the freshness stamp reflects the LATEST looking rather than the first. A
 * determination that keeps returning the same answer still gets fresher, which
 * is correct: the claim is "we checked on this date", not "we first checked".
 *
 * The basis is validated here AND is NOT NULL plus check-constrained non-empty
 * at the database, so a caller bypassing this function with raw SQL still
 * cannot record an uncited absence.
 */
export async function recordAbsenceDetermination(input: {
  jurisdictionFips: string;
  docSlug: string;
  verdict: SmartFileAbsenceVerdict;
  /** WHY. Never "not found" — that is the question, not the answer. */
  basis: string;
  /** What did the determining. Attributable by contract. */
  determinedBy: string;
  sourceUri?: string | null;
  accessPolicy: SmartFileAccessPolicyValue;
  determinedAt?: Date;
}): Promise<{ entityId: string; recorded: true }> {
  const entityId = buildSmartFileEntityId({
    jurisdictionFips: input.jurisdictionFips,
    docSlug: input.docSlug,
  });

  // Fail loudly BEFORE the write rather than letting the DB check constraint
  // surface as an opaque driver error. Both layers hold; this one explains.
  if (input.basis.trim().length === 0) {
    throw new Error(
      `smart-file absence: basis is required and must be non-empty for ${entityId}. ` +
        `"Not found" is not a basis — record WHY it is not found.`,
    );
  }
  if (input.determinedBy.trim().length === 0) {
    throw new Error(
      `smart-file absence: determinedBy is required for ${entityId}. ` +
        `An unattributable determination cannot be re-verified.`,
    );
  }

  const determinedAt = input.determinedAt ?? new Date();

  await db
    .insert(smartFileAbsenceDeterminations)
    .values({
      entityId,
      jurisdictionFips: input.jurisdictionFips,
      docSlug: input.docSlug,
      verdict: input.verdict,
      basis: input.basis,
      determinedBy: input.determinedBy,
      sourceUri: input.sourceUri ?? null,
      accessPolicy: input.accessPolicy,
      determinedAt,
    })
    .onConflictDoUpdate({
      target: smartFileAbsenceDeterminations.entityId,
      set: {
        verdict: input.verdict,
        basis: input.basis,
        determinedBy: input.determinedBy,
        sourceUri: input.sourceUri ?? null,
        accessPolicy: input.accessPolicy,
        determinedAt,
        updatedAt: determinedAt,
      },
    });

  return { entityId, recorded: true };
}

/**
 * Build the `not-sought` absence — the honest default when nothing is known.
 *
 * Freshness is deliberately NULL here, not synthesized. There is no
 * determination event to age, and inventing a stamp would fabricate a
 * measurement about a lookup that never happened (DEV_PROCESS: a measurement
 * that was not taken is not a measurement).
 */
function buildNotSoughtAbsence(
  entityId: string,
  jurisdictionFips: string,
  docSlug: string,
): SmartFileAbsence {
  return {
    status: "not-sought",
    entityId,
    jurisdictionFips,
    docSlug,
    absence: {
      basis:
        "No document is held for this entityId and no absence determination has " +
        "been recorded. We have not looked. This is a statement about our " +
        "coverage, not about whether the document exists.",
      determinedBy: null,
      determinedAt: null,
      sourceUri: null,
    },
    freshness: null,
    heldDocument: null,
  };
}

/**
 * Read a document. Returns a TYPED RESULT — never null (G-34).
 *
 * Every successful read is stamped: source (provenance), `computedAt`, and
 * `servedAt`, plus a STALE verdict from the proven-in-both-directions
 * evaluator. `servedAt` is taken at serve time and never stored.
 *
 * Every UNSUCCESSFUL read is also stamped and also typed. The five outcomes:
 *
 *   `held`                — document and version both resolved. Carries content.
 *   `held-version-absent` — the document IS held; that version is not. Carries
 *                           the document identity and what versions exist, so a
 *                           caller learns what it CAN have. This is NOT a data
 *                           gap and must never render as one.
 *   `absent-verified`     — a recorded determination says we looked and it is
 *                           genuinely not there. A real answer.
 *   `lookup-failed`       — a recorded determination says the ATTEMPT failed.
 *                           We know nothing about existence.
 *   `not-sought`          — nothing is held and nothing was determined. We
 *                           never looked.
 *
 * Absences carry a freshness stamp for the same reason presences do: a VERIFIED
 * ABSENCE DECAYS. A 2019 determination is not evidence about today. The stamp
 * comes from the SAME `evaluateSmartFileFreshness` the present path uses, so
 * one proven-in-both-directions indicator covers both paths and there is no
 * second evaluator to drift.
 */
export async function readDocument(input: {
  entityId: string;
  /** Read a specific prior version. Defaults to the current one. */
  version?: number;
  servedAt?: Date;
  stalenessThresholdSeconds?: number;
}): Promise<SmartFileReadResult> {
  const servedAt = input.servedAt ?? new Date();

  // The entityId is PARSED, never reconstructed from parts (constraint 6). A
  // malformed id is reported as such rather than silently matching zero rows
  // and reading as an honest absence — the exact failure this family exists to
  // prevent.
  const parts = parseSmartFileEntityId(input.entityId);

  const [doc] = await db
    .select()
    .from(smartFileDocuments)
    .where(eq(smartFileDocuments.entityId, input.entityId))
    .limit(1);

  if (!doc) {
    // NOT HELD. Look for a recorded determination — and note that only a row
    // that something DELIBERATELY WROTE can produce a verified absence here.
    // A zero-row result falls through to `not-sought` and writes nothing.
    const [determination] = await db
      .select()
      .from(smartFileAbsenceDeterminations)
      .where(eq(smartFileAbsenceDeterminations.entityId, input.entityId))
      .limit(1);

    if (!determination) {
      if (!parts) {
        // A malformed entityId is its own answer, distinct from "we never
        // looked for this well-formed thing".
        return {
          status: "lookup-failed",
          entityId: input.entityId,
          jurisdictionFips: "",
          docSlug: "",
          absence: {
            basis:
              `The entityId ${JSON.stringify(input.entityId)} does not match the ` +
              `declared shape smartfile:<jurisdictionFips>:<docSlug>, so no lookup ` +
              `was possible. This is a malformed request, NOT evidence that the ` +
              `document is absent.`,
            determinedBy: "smartFileStore.readDocument",
            determinedAt: servedAt.toISOString(),
            sourceUri: null,
          },
          freshness: evaluateSmartFileFreshness({
            computedAt: servedAt.toISOString(),
            servedAt: servedAt.toISOString(),
            stalenessThresholdSeconds: input.stalenessThresholdSeconds,
          }),
          heldDocument: null,
        };
      }
      return buildNotSoughtAbsence(
        input.entityId,
        parts.jurisdictionFips,
        parts.docSlug,
      );
    }

    // A determination EXISTS. Its verdict is reported as recorded — this
    // function never upgrades or downgrades a verdict, it reports one.
    return {
      status: determination.verdict === "absent-verified"
        ? "absent-verified"
        : "lookup-failed",
      entityId: determination.entityId,
      jurisdictionFips: determination.jurisdictionFips,
      docSlug: determination.docSlug,
      absence: {
        basis: determination.basis,
        determinedBy: determination.determinedBy,
        determinedAt: determination.determinedAt.toISOString(),
        sourceUri: determination.sourceUri,
      },
      // The determination decays like any other fact.
      freshness: evaluateSmartFileFreshness({
        computedAt: determination.determinedAt.toISOString(),
        servedAt: servedAt.toISOString(),
        stalenessThresholdSeconds: input.stalenessThresholdSeconds,
      }),
      heldDocument: null,
    };
  }

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

  if (!version) {
    // The document IS held. This is a VERSION absence, which the G-14 store
    // returned as the identical null as a document absence (finding
    // F-A2-CP1-2) — two different facts behind one value. They are now
    // different discriminants, because "we do not have this document" and "we
    // have it but not that revision" call for opposite renderings.
    return {
      status: "held-version-absent",
      entityId: doc.entityId,
      jurisdictionFips: doc.jurisdictionFips,
      docSlug: doc.docSlug,
      absence: {
        basis:
          `The document is HELD but version ${wantVersion} is not. Current ` +
          `version is ${doc.currentVersion}. This is a version that does not ` +
          `exist, NOT a missing document and NOT a data gap.`,
        determinedBy: "smartFileStore.readDocument",
        determinedAt: doc.updatedAt.toISOString(),
        sourceUri: null,
      },
      // Aged against the document's last change, which is the only
      // determination event there is for "which versions exist".
      freshness: evaluateSmartFileFreshness({
        computedAt: doc.updatedAt.toISOString(),
        servedAt: servedAt.toISOString(),
        stalenessThresholdSeconds: input.stalenessThresholdSeconds,
      }),
      heldDocument: {
        title: doc.title,
        accessPolicy: doc.accessPolicy,
        currentVersion: doc.currentVersion,
        requestedVersion: wantVersion,
      },
    };
  }

  const placements = await db
    .select()
    .from(smartFilePlacements)
    .where(eq(smartFilePlacements.documentId, doc.id))
    .orderBy(asc(smartFilePlacements.placedAt));

  const provenance = parseProvenance(version.provenance);

  const freshness = evaluateSmartFileFreshness({
    computedAt: version.computedAt.toISOString(),
    servedAt: servedAt.toISOString(),
    stalenessThresholdSeconds: input.stalenessThresholdSeconds,
  });

  return {
    status: "held",
    document: {
      entityType: "smart-file-document",
      entityId: doc.entityId,
      jurisdictionFips: doc.jurisdictionFips,
      docSlug: doc.docSlug,
      title: doc.title,
      accessPolicy: doc.accessPolicy,
      currentVersion: doc.currentVersion,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    },
    version: {
      entityType: "smart-file-version",
      documentEntityId: doc.entityId,
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
      entityType: "smart-file-placement" as const,
      documentEntityId: doc.entityId,
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
