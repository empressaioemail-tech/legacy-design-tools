/**
 * /api/engagements/:id/briefing — DA-PI-1B manual-QGIS upload path.
 *
 * Two endpoints:
 *
 *   - GET  /engagements/:id/briefing
 *       Returns the engagement's `parcel_briefings` row (or null) along
 *       with its current (non-superseded) `briefing_sources`. The
 *       envelope is `{ briefing: ... | null }` so the wire shape stays a
 *       plain object even before the first upload — see
 *       `EngagementBriefingResponse` in the OpenAPI spec.
 *
 *   - POST /engagements/:id/briefing/sources
 *       Records a manually-uploaded layer. The first call lazily creates
 *       the engagement's `parcel_briefings` row
 *       (first-upload-creates-briefing). Subsequent calls of the same
 *       `layerKind` mark the prior `briefing_sources` row superseded
 *       (Spec 51 §4 reconciliation contract): the prior row's
 *       `superseded_by_id` is pointed at the new row's id and
 *       `superseded_at` is stamped, but the row stays readable so the
 *       timeline preserves the full per-layer history.
 *
 * Best-effort `briefing-source.fetched` event emission via the existing
 * event-anchoring service: a transient history outage cannot fail the
 * HTTP request — the row is the source of truth, the event chain is
 * observability (mirrors the contract used by snapshots / submissions).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  engagements,
  parcelBriefings,
  briefingSources,
  type ParcelBriefing,
  type BriefingSource,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CreateEngagementBriefingSourceBody,
  CreateEngagementBriefingSourceParams,
  GetEngagementBriefingParams,
} from "@workspace/api-zod";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  BRIEFING_SOURCE_EVENT_TYPES,
  type BriefingSourceEventType,
} from "../atoms/briefing-source.atom";

const router: IRouter = Router();

/**
 * Pinned to the briefing-source atom's event-type union so a rename in
 * the atom registration breaks compilation here rather than silently
 * emitting a stale event name.
 */
const BRIEFING_SOURCE_FETCHED_EVENT_TYPE: BriefingSourceEventType =
  BRIEFING_SOURCE_EVENT_TYPES[0];

/** Stable system actor for manual-upload briefing-source events. */
const BRIEFING_MANUAL_UPLOAD_ACTOR = {
  kind: "system" as const,
  id: "briefing-manual-upload",
};

/** Wire shape for one current source on the briefing read response. */
interface BriefingSourceWire {
  id: string;
  layerKind: string;
  sourceKind: "manual-upload" | "federal-adapter";
  provider: string | null;
  snapshotDate: string;
  note: string | null;
  uploadObjectPath: string | null;
  uploadOriginalFilename: string | null;
  uploadContentType: string | null;
  uploadByteSize: number | null;
  createdAt: string;
}

interface BriefingWire {
  id: string;
  engagementId: string;
  createdAt: string;
  updatedAt: string;
  sources: BriefingSourceWire[];
}

/**
 * Project a row + its current sources into the wire shape declared by
 * the OpenAPI `EngagementBriefing` schema. Centralized so GET and POST
 * agree on the projection (in particular: which `sourceKind` values
 * leak to the wire, and the timestamp serialization).
 */
function toBriefingWire(
  briefing: ParcelBriefing,
  sources: BriefingSource[],
): BriefingWire {
  return {
    id: briefing.id,
    engagementId: briefing.engagementId,
    createdAt: briefing.createdAt.toISOString(),
    updatedAt: briefing.updatedAt.toISOString(),
    sources: sources.map((s) => ({
      id: s.id,
      layerKind: s.layerKind,
      // Cast to the closed wire enum: the column is `text` so the
      // database technically allows any value, but the only writers in
      // the codebase are this route (`manual-upload`) and the future
      // federal-adapter (`federal-adapter`). Anything else would be a
      // schema-violation we want to surface, not silently round-trip.
      sourceKind: s.sourceKind as "manual-upload" | "federal-adapter",
      provider: s.provider,
      snapshotDate: s.snapshotDate.toISOString(),
      note: s.note,
      uploadObjectPath: s.uploadObjectPath,
      uploadOriginalFilename: s.uploadOriginalFilename,
      uploadContentType: s.uploadContentType,
      uploadByteSize: s.uploadByteSize,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

/**
 * Load the current (non-superseded) sources for a briefing, newest-
 * first. Used by GET and as the post-write projection on POST so the
 * wire response always reflects the canonical "current view".
 */
async function loadCurrentSources(
  briefingId: string,
): Promise<BriefingSource[]> {
  return db
    .select()
    .from(briefingSources)
    .where(
      and(
        eq(briefingSources.briefingId, briefingId),
        // `supersededAt` is the canonical "no-longer-current" flag —
        // see the partial unique index on the table for why we gate on
        // the timestamp rather than `supersededById`.
        isNull(briefingSources.supersededAt),
      ),
    )
    .orderBy(desc(briefingSources.createdAt));
}

/**
 * Best-effort emission of `briefing-source.fetched` against a freshly-
 * inserted briefing source. Failures are swallowed and logged so a
 * history outage cannot fail the HTTP request — the row is the source
 * of truth, the event chain is observability (mirrors the contract
 * used by `routes/snapshots.ts`).
 */
async function emitBriefingSourceFetchedEvent(
  history: EventAnchoringService,
  source: BriefingSource,
  engagementId: string,
  supersededSourceId: string | null,
  reqLog: typeof logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "briefing-source",
      entityId: source.id,
      eventType: BRIEFING_SOURCE_FETCHED_EVENT_TYPE,
      actor: BRIEFING_MANUAL_UPLOAD_ACTOR,
      payload: {
        briefingId: source.briefingId,
        engagementId,
        layerKind: source.layerKind,
        sourceKind: source.sourceKind,
        uploadObjectPath: source.uploadObjectPath,
        uploadOriginalFilename: source.uploadOriginalFilename,
        uploadContentType: source.uploadContentType,
        uploadByteSize: source.uploadByteSize,
        supersededSourceId,
      },
    });
    reqLog.info(
      {
        briefingSourceId: source.id,
        briefingId: source.briefingId,
        engagementId,
        layerKind: source.layerKind,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "briefing-source.fetched event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        briefingSourceId: source.id,
        briefingId: source.briefingId,
        engagementId,
        layerKind: source.layerKind,
      },
      "briefing-source.fetched event append failed — row insert kept",
    );
  }
}

router.get(
  "/engagements/:id/briefing",
  async (req: Request, res: Response) => {
    const paramsParse = GetEngagementBriefingParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    try {
      // Verify the engagement exists so `null` briefing always means
      // "no upload yet" and never "engagement vanished" — matches the
      // 404-vs-empty distinction other engagement-scoped routes draw.
      const eng = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (eng.length === 0) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const briefingRows = await db
        .select()
        .from(parcelBriefings)
        .where(eq(parcelBriefings.engagementId, engagementId))
        .limit(1);
      const briefing = briefingRows[0];
      if (!briefing) {
        res.json({ briefing: null });
        return;
      }
      const sources = await loadCurrentSources(briefing.id);
      res.json({ briefing: toBriefingWire(briefing, sources) });
    } catch (err) {
      logger.error({ err, engagementId }, "get engagement briefing failed");
      res.status(500).json({ error: "Failed to load briefing" });
    }
  },
);

router.post(
  "/engagements/:id/briefing/sources",
  async (req: Request, res: Response) => {
    const paramsParse = CreateEngagementBriefingSourceParams.safeParse(
      req.params,
    );
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    const bodyParse = CreateEngagementBriefingSourceBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({ error: "invalid_briefing_source_body" });
      return;
    }
    const body = bodyParse.data;
    const trimmedNote = body.note?.trim() ?? null;
    const note = trimmedNote && trimmedNote.length > 0 ? trimmedNote : null;
    const provider = body.provider?.trim() || null;

    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    let outcome: {
      briefing: ParcelBriefing;
      newSource: BriefingSource;
      supersededSourceId: string | null;
    };
    try {
      // Engagement existence + briefing upsert + per-layer supersession
      // + new-row insert all happen in one transaction so a concurrent
      // second upload cannot interleave between supersession-stamp and
      // insert and trip the partial unique index.
      outcome = await db.transaction(async (tx) => {
        const eng = await tx
          .select({ id: engagements.id })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .limit(1);
        if (eng.length === 0) {
          // Throw a tagged sentinel so the catch can map it to a 404
          // without leaking a generic 500.
          throw new EngagementNotFoundError(engagementId);
        }

        // First-upload-creates-briefing: ON CONFLICT DO UPDATE bumps
        // updatedAt and returns the row (insert *or* refetch in one
        // round-trip). The `engagement_id` column carries a unique
        // constraint (one briefing per engagement today) so the
        // conflict target is well-defined.
        const [briefing] = await tx
          .insert(parcelBriefings)
          .values({ engagementId })
          .onConflictDoUpdate({
            target: parcelBriefings.engagementId,
            set: { updatedAt: new Date() },
          })
          .returning();

        // Per-layer supersession (Spec 51 §4). The partial unique
        // index gates on `superseded_at IS NULL`, so the write order is
        // strictly:
        //   1. Stamp the prior current row's `superseded_at` to free
        //      its slot in the partial-unique index.
        //   2. Insert the new row (no longer races the index).
        //   3. Backfill the prior row's `superseded_by_id` with the
        //      new row's id so the consumer-facing pointer is set.
        // All three live in the same transaction, so a concurrent
        // second upload either commits before our `select` and is
        // visible at step 1, or starts after our commit and finds our
        // new row as its prior.
        const supersededAt = new Date();
        const priorRows = await tx
          .select({ id: briefingSources.id })
          .from(briefingSources)
          .where(
            and(
              eq(briefingSources.briefingId, briefing.id),
              eq(briefingSources.layerKind, body.layerKind),
              isNull(briefingSources.supersededAt),
            ),
          )
          .limit(1);
        const priorId = priorRows[0]?.id ?? null;

        if (priorId) {
          await tx
            .update(briefingSources)
            .set({ supersededAt })
            .where(eq(briefingSources.id, priorId));
        }

        const [newSource] = await tx
          .insert(briefingSources)
          .values({
            briefingId: briefing.id,
            layerKind: body.layerKind,
            sourceKind: "manual-upload",
            provider,
            snapshotDate: body.snapshotDate ?? new Date(),
            note,
            uploadObjectPath: body.upload.objectPath,
            uploadOriginalFilename: body.upload.originalFilename,
            uploadContentType: body.upload.contentType,
            uploadByteSize: body.upload.byteSize,
          })
          .returning();

        if (priorId) {
          await tx
            .update(briefingSources)
            .set({ supersededById: newSource.id })
            .where(eq(briefingSources.id, priorId));
        }

        return {
          briefing,
          newSource,
          supersededSourceId: priorId,
        };
      });
    } catch (err) {
      if (err instanceof EngagementNotFoundError) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      logger.error(
        { err, engagementId, layerKind: bodyParse.data.layerKind },
        "create briefing source failed",
      );
      res.status(500).json({ error: "Failed to record briefing source" });
      return;
    }

    // Best-effort event emission, awaited but never throws — see
    // `emitBriefingSourceFetchedEvent`.
    await emitBriefingSourceFetchedEvent(
      getHistoryService(),
      outcome.newSource,
      engagementId,
      outcome.supersededSourceId,
      reqLog,
    );

    const sources = await loadCurrentSources(outcome.briefing.id);
    res
      .status(201)
      .json({ briefing: toBriefingWire(outcome.briefing, sources) });
  },
);

class EngagementNotFoundError extends Error {
  constructor(public readonly engagementId: string) {
    super(`Engagement not found: ${engagementId}`);
    this.name = "EngagementNotFoundError";
  }
}

export default router;
