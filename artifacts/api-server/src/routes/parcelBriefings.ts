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
  ListEngagementBriefingSourcesParams,
  ListEngagementBriefingSourcesQueryParams,
  RestoreEngagementBriefingSourceParams,
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

/**
 * Wire shape for one briefing source. Carries `supersededAt` /
 * `supersededById` so the same projection serves both the "current
 * sources" view (where these are always null) and the per-layer
 * history view exposed by `GET .../briefing/sources?includeSuperseded=true`,
 * which the Site Context history panel uses to offer a rollback.
 */
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
  supersededAt: string | null;
  supersededById: string | null;
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
function toBriefingSourceWire(s: BriefingSource): BriefingSourceWire {
  return {
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
    supersededAt: s.supersededAt ? s.supersededAt.toISOString() : null,
    supersededById: s.supersededById,
    createdAt: s.createdAt.toISOString(),
  };
}

function toBriefingWire(
  briefing: ParcelBriefing,
  sources: BriefingSource[],
): BriefingWire {
  return {
    id: briefing.id,
    engagementId: briefing.engagementId,
    createdAt: briefing.createdAt.toISOString(),
    updatedAt: briefing.updatedAt.toISOString(),
    sources: sources.map(toBriefingSourceWire),
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

/**
 * GET /engagements/:id/briefing/sources?layerKind=...&includeSuperseded=true
 *
 * History-aware listing scoped to one layer. The default
 * (`includeSuperseded=false`) returns the same single current row the
 * `GET /engagements/:id/briefing` route would surface for that layer
 * — kept as a separate endpoint so the Site Context "View history"
 * affordance can request only the rows it needs without re-fetching
 * the entire briefing payload, and so the federal-adapter timeline
 * (DA-PI-2) has a contract to call into without round-tripping the
 * full briefing read.
 *
 * Returns `{ sources: [] }` when the engagement has no briefing yet
 * — this is not an error: the briefing row is created lazily on
 * first upload and there is therefore nothing to list. Missing
 * engagement is still a 404 so consumers can distinguish "no upload"
 * from "wrong engagement id".
 */
router.get(
  "/engagements/:id/briefing/sources",
  async (req: Request, res: Response) => {
    const paramsParse = ListEngagementBriefingSourcesParams.safeParse(
      req.params,
    );
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    // Generated `ListEngagementBriefingSourcesQueryParams` uses
    // `zod.coerce.string()` for `layerKind`, which is permissive in
    // the missing-input case (`String(undefined) === "undefined"`).
    // Reject the missing query param explicitly so callers get a
    // meaningful 400 instead of an empty-result false success.
    if (typeof req.query.layerKind !== "string") {
      res.status(400).json({ error: "invalid_query_parameters" });
      return;
    }
    // The codegen schema uses `zod.coerce.boolean()` for
    // `includeSuperseded`, which (per JS truthiness) treats the
    // strings "false", "0", and "no" as `true`. Reject anything that
    // isn't a clean "true"/"false" before parsing so the contract
    // matches what the OpenAPI spec advertises.
    const rawIncludeSuperseded = req.query.includeSuperseded;
    if (
      rawIncludeSuperseded !== undefined &&
      rawIncludeSuperseded !== "true" &&
      rawIncludeSuperseded !== "false"
    ) {
      res.status(400).json({ error: "invalid_query_parameters" });
      return;
    }
    const queryParse = ListEngagementBriefingSourcesQueryParams.safeParse(
      req.query,
    );
    if (!queryParse.success) {
      res.status(400).json({ error: "invalid_query_parameters" });
      return;
    }
    const engagementId = paramsParse.data.id;
    const { layerKind } = queryParse.data;
    const includeSuperseded = rawIncludeSuperseded === "true";

    try {
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
        .select({ id: parcelBriefings.id })
        .from(parcelBriefings)
        .where(eq(parcelBriefings.engagementId, engagementId))
        .limit(1);
      const briefing = briefingRows[0];
      if (!briefing) {
        // No upload has happened yet; the per-layer history is
        // trivially empty rather than 404. Mirrors the briefing read
        // path (which returns `{ briefing: null }` rather than 404 on
        // the same condition).
        res.json({ sources: [] });
        return;
      }

      const baseConditions = [
        eq(briefingSources.briefingId, briefing.id),
        eq(briefingSources.layerKind, layerKind),
      ];
      const conditions = includeSuperseded
        ? baseConditions
        : [...baseConditions, isNull(briefingSources.supersededAt)];
      const rows = await db
        .select()
        .from(briefingSources)
        .where(and(...conditions))
        .orderBy(desc(briefingSources.createdAt));

      res.json({ sources: rows.map(toBriefingSourceWire) });
    } catch (err) {
      logger.error(
        { err, engagementId, layerKind },
        "list briefing sources failed",
      );
      res.status(500).json({ error: "Failed to list briefing sources" });
    }
  },
);

/**
 * POST /engagements/:id/briefing/sources/:sourceId/restore
 *
 * Roll back a per-layer slot to a previously-superseded row. Inverts
 * the supersession the original re-upload installed:
 *
 *   1. The current row for the same `(briefing_id, layer_kind)` is
 *      stamped with `supersededAt = now` and
 *      `supersededById = <restored row's id>`.
 *   2. The restored row's `supersededAt` and `supersededById` are
 *      cleared, returning it to the partial-unique "current" slot.
 *
 * The write order matters for the same reason POST does: the partial
 * unique index gates on `supersededAt IS NULL`, so the prior current
 * row's `supersededAt` must be set before the restored row's
 * `supersededAt` is cleared. All writes happen inside one
 * transaction so a concurrent restore / upload either commits before
 * our `select` (and is visible at step 1) or starts after our commit
 * (and finds the restored row as its prior).
 *
 * Idempotent: when the target row is already current the endpoint
 * does nothing and returns the briefing unchanged. This makes
 * double-clicks (or double-fires from a flaky network) safe.
 *
 * No event is emitted today — the supersession trail is reconstructable
 * from the row state alone, and the timeline view that consumes
 * `briefing-source.fetched` does not yet distinguish "rolled back" from
 * "freshly uploaded". When DA-PI-2's timeline lands a richer event
 * type (`briefing-source.restored`) can be added without breaking the
 * row contract.
 */
router.post(
  "/engagements/:id/briefing/sources/:sourceId/restore",
  async (req: Request, res: Response) => {
    const paramsParse = RestoreEngagementBriefingSourceParams.safeParse(
      req.params,
    );
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_route_parameters" });
      return;
    }
    const { id: engagementId, sourceId } = paramsParse.data;

    let outcome: { briefing: ParcelBriefing };
    try {
      outcome = await db.transaction(async (tx) => {
        const eng = await tx
          .select({ id: engagements.id })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .limit(1);
        if (eng.length === 0) {
          throw new EngagementNotFoundError(engagementId);
        }

        const briefingRows = await tx
          .select()
          .from(parcelBriefings)
          .where(eq(parcelBriefings.engagementId, engagementId))
          .limit(1);
        const briefing = briefingRows[0];
        if (!briefing) {
          // The route accepts a `sourceId` that supposedly belongs to
          // this engagement's briefing — if no briefing exists at all
          // the source can't possibly belong to it. Surfaces as 404
          // rather than 400 because from the caller's perspective the
          // identified source does not exist on this engagement.
          throw new BriefingSourceNotFoundError(sourceId);
        }

        const targetRows = await tx
          .select()
          .from(briefingSources)
          .where(eq(briefingSources.id, sourceId))
          .limit(1);
        const target = targetRows[0];
        if (!target) {
          throw new BriefingSourceNotFoundError(sourceId);
        }
        if (target.briefingId !== briefing.id) {
          // The source row exists but on a different engagement's
          // briefing — refuse rather than silently restoring an
          // unrelated row. 400 (not 404) so the client can tell this
          // apart from "deleted".
          throw new BriefingSourceMismatchError(sourceId, engagementId);
        }

        // Idempotency: if the target is already the current row for
        // its layer, there is nothing to flip. Return the briefing
        // unchanged so a duplicate restore call is safe.
        if (target.supersededAt === null) {
          return { briefing };
        }

        const supersededAt = new Date();

        // Step 1: stamp the current row for the same layer (if any).
        // Defensive: a layer with a superseded target *must* have a
        // current row by the supersession contract, but if the chain
        // has been broken (e.g. by a manual DB edit) we surface 400
        // rather than try to restore into an empty slot — that would
        // leave the partial-unique index in a state inconsistent with
        // the chain pointer.
        const currentRows = await tx
          .select({ id: briefingSources.id })
          .from(briefingSources)
          .where(
            and(
              eq(briefingSources.briefingId, briefing.id),
              eq(briefingSources.layerKind, target.layerKind),
              isNull(briefingSources.supersededAt),
            ),
          )
          .limit(1);
        const currentId = currentRows[0]?.id ?? null;
        if (!currentId) {
          throw new NoCurrentRowError(target.layerKind);
        }

        await tx
          .update(briefingSources)
          .set({ supersededAt, supersededById: target.id })
          .where(eq(briefingSources.id, currentId));

        // Step 2: clear the restored row so it owns the current
        // slot. The partial-unique index is now satisfied because
        // step 1 freed the prior occupant.
        await tx
          .update(briefingSources)
          .set({ supersededAt: null, supersededById: null })
          .where(eq(briefingSources.id, target.id));

        // Touch the briefing's updatedAt so consumers polling the
        // briefing read see a fresh updatedAt without having to peek
        // into the source rows.
        const [updatedBriefing] = await tx
          .update(parcelBriefings)
          .set({ updatedAt: new Date() })
          .where(eq(parcelBriefings.id, briefing.id))
          .returning();

        return { briefing: updatedBriefing };
      });
    } catch (err) {
      if (err instanceof EngagementNotFoundError) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      if (err instanceof BriefingSourceNotFoundError) {
        res.status(404).json({ error: "briefing_source_not_found" });
        return;
      }
      if (err instanceof BriefingSourceMismatchError) {
        res
          .status(400)
          .json({ error: "briefing_source_engagement_mismatch" });
        return;
      }
      if (err instanceof NoCurrentRowError) {
        res.status(400).json({ error: "no_current_briefing_source" });
        return;
      }
      logger.error(
        { err, engagementId, sourceId },
        "restore briefing source failed",
      );
      res.status(500).json({ error: "Failed to restore briefing source" });
      return;
    }

    const sources = await loadCurrentSources(outcome.briefing.id);
    res.json({ briefing: toBriefingWire(outcome.briefing, sources) });
  },
);

class EngagementNotFoundError extends Error {
  constructor(public readonly engagementId: string) {
    super(`Engagement not found: ${engagementId}`);
    this.name = "EngagementNotFoundError";
  }
}

class BriefingSourceNotFoundError extends Error {
  constructor(public readonly sourceId: string) {
    super(`Briefing source not found: ${sourceId}`);
    this.name = "BriefingSourceNotFoundError";
  }
}

class BriefingSourceMismatchError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly engagementId: string,
  ) {
    super(
      `Briefing source ${sourceId} does not belong to engagement ${engagementId}`,
    );
    this.name = "BriefingSourceMismatchError";
  }
}

class NoCurrentRowError extends Error {
  constructor(public readonly layerKind: string) {
    super(
      `No current briefing source for layer ${layerKind} — supersession chain is broken`,
    );
    this.name = "NoCurrentRowError";
  }
}

export default router;
