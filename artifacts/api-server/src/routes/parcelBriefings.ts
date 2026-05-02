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
  briefingGenerationJobs,
  users,
  type ParcelBriefing,
  type BriefingSource,
  type BriefingGenerationJob,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CreateEngagementBriefingSourceBody,
  CreateEngagementBriefingSourceParams,
  ExportEngagementBriefingPdfParams,
  ExportEngagementBriefingPdfQueryParams,
  GenerateEngagementBriefingBody,
  GenerateEngagementBriefingParams,
  GetEngagementBriefingGenerationStatusParams,
  GetEngagementBriefingParams,
  ListEngagementBriefingGenerationRunsParams,
  ListEngagementBriefingSourcesParams,
  ListEngagementBriefingSourcesQueryParams,
  RestoreEngagementBriefingSourceParams,
  RetryBriefingSourceConversionParams,
} from "@workspace/api-zod";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import {
  BRIEFING_MANUAL_UPLOAD_ACTOR_ID,
  BRIEFING_ENGINE_ACTOR_ID,
} from "@workspace/server-actor-ids";
import {
  generateBriefing,
  type BriefingSourceInput,
  type GenerateBriefingResult,
} from "@workspace/briefing-engine";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  BRIEFING_SOURCE_EVENT_TYPES,
  type BriefingSourceEventType,
} from "../atoms/briefing-source.atom";
import {
  PARCEL_BRIEFING_EVENT_TYPES,
  type ParcelBriefingEventType,
} from "../atoms/parcel-briefing.atom";
import {
  MATERIALIZABLE_ELEMENT_EVENT_TYPES,
  type MaterializableElementEventType,
} from "../atoms/materializable-element.atom";
import {
  ConverterError,
  DXF_LAYER_KINDS,
  getConverterClient,
  isDxfLayerKind,
  type DxfLayerKind,
} from "../lib/converterClient";
import {
  getBriefingLlmClient,
  getBriefingLlmMode,
} from "../lib/briefingLlmClient";
import { resolveKeepPerEngagement } from "../lib/briefingGenerationJobsSweep";
import { ObjectStorageService } from "../lib/objectStorage";
import { resolveMatchingReviewerRequests } from "../lib/reviewerRequestResolution";
import {
  DEFAULT_BRIEFING_PDF_HEADER,
  renderBriefingPdf,
  type PdfBriefingSource,
} from "../lib/briefingPdf";

/**
 * Lazily-instantiated singleton — the constructor reads env at the
 * first call site (e.g. PRIVATE_OBJECT_DIR), so creating it at
 * module load order would race with the test harness's env setup.
 */
let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

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
  id: BRIEFING_MANUAL_UPLOAD_ACTOR_ID,
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
  sourceKind:
    | "manual-upload"
    | "federal-adapter"
    | "state-adapter"
    | "local-adapter";
  provider: string | null;
  snapshotDate: string;
  note: string | null;
  /**
   * Structured producer payload — `{}` for manual-upload rows, the
   * adapter's `AdapterResult.payload` shape for adapter rows. The
   * Site Context tab's "view layer details" expander reads this
   * field, so producers must keep the shape stable. Treated as
   * opaque on the wire — see openapi.yaml's EngagementBriefingSource
   * schema for the contract.
   */
  payload: Record<string, unknown>;
  uploadObjectPath: string | null;
  uploadOriginalFilename: string | null;
  uploadContentType: string | null;
  uploadByteSize: number | null;
  /** DA-MV-1 — see column docs on `briefing_sources` schema. */
  dxfObjectPath: string | null;
  glbObjectPath: string | null;
  conversionStatus:
    | "pending"
    | "converting"
    | "ready"
    | "failed"
    | "dxf-only"
    | null;
  conversionError: string | null;
  supersededAt: string | null;
  supersededById: string | null;
  createdAt: string;
}

/**
 * The seven A–G section narrative + generation metadata, surfaced via
 * `EngagementBriefingNarrative` in the OpenAPI spec. Returned `null`
 * by {@link toBriefingNarrativeWire} when no generation has run on
 * the row (every section column + `generatedAt` is null).
 */
interface BriefingNarrativeWire {
  sectionA: string | null;
  sectionB: string | null;
  sectionC: string | null;
  sectionD: string | null;
  sectionE: string | null;
  sectionF: string | null;
  sectionG: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
  /**
   * Task #281 — id of the `briefing_generation_jobs` row that produced
   * the current `section_a..g` body. Null when no generation has been
   * stamped on the briefing yet, when a legacy row has not been
   * backfilled, or when the producing job was pruned (FK is
   * `ON DELETE SET NULL`). The UI matches on this id directly rather
   * than inferring "Current" from a timestamp window — see
   * `BriefingRecentRunsPanel` in the design-tools page.
   */
  generationId: string | null;
}

interface BriefingWire {
  id: string;
  engagementId: string;
  createdAt: string;
  updatedAt: string;
  sources: BriefingSourceWire[];
  narrative: BriefingNarrativeWire | null;
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
    // database technically allows any value, but the writers in the
    // codebase are this route (`manual-upload`), the future federal
    // adapter (`federal-adapter`), and the DA-PI-4 state/local
    // adapters (`state-adapter` / `local-adapter`). Anything else
    // would be a schema-violation we want to surface, not silently
    // round-trip.
    sourceKind: s.sourceKind as BriefingSourceWire["sourceKind"],
    provider: s.provider,
    snapshotDate: s.snapshotDate.toISOString(),
    note: s.note,
    // Cast: drizzle types `jsonb` as `unknown`; the producers in this
    // codebase (this route + generateLayers.ts) only ever insert a
    // `Record<string, unknown>` so the cast is a structural assertion
    // rather than a type laundering. Empty object is the column
    // default for manual-upload rows.
    payload: (s.payload ?? {}) as Record<string, unknown>,
    uploadObjectPath: s.uploadObjectPath,
    uploadOriginalFilename: s.uploadOriginalFilename,
    uploadContentType: s.uploadContentType,
    uploadByteSize: s.uploadByteSize,
    dxfObjectPath: s.dxfObjectPath,
    glbObjectPath: s.glbObjectPath,
    // The column is `text`; the only producers are this route + the
    // retry endpoint, which both write one of the closed-set values.
    // Cast keeps the wire shape's discriminated-union honest while
    // still surfacing a schema violation as a TS error rather than a
    // silent round-trip.
    conversionStatus: s.conversionStatus as BriefingSourceWire["conversionStatus"],
    conversionError: s.conversionError,
    supersededAt: s.supersededAt ? s.supersededAt.toISOString() : null,
    supersededById: s.supersededById,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * Project the seven section columns + generation metadata into the
 * `EngagementBriefingNarrative` wire shape, or return `null` when the
 * row has never been generated. The "never generated" sentinel is
 * "every section is null AND `generatedAt` is null" — this is what
 * the `null`-narrative envelope tells the UI to render the
 * "Generate Briefing" button instead of the section cards.
 */
function toBriefingNarrativeWire(
  b: ParcelBriefing,
): BriefingNarrativeWire | null {
  const everySectionNull =
    b.sectionA === null &&
    b.sectionB === null &&
    b.sectionC === null &&
    b.sectionD === null &&
    b.sectionE === null &&
    b.sectionF === null &&
    b.sectionG === null;
  if (everySectionNull && b.generatedAt === null) {
    return null;
  }
  return {
    sectionA: b.sectionA,
    sectionB: b.sectionB,
    sectionC: b.sectionC,
    sectionD: b.sectionD,
    sectionE: b.sectionE,
    sectionF: b.sectionF,
    sectionG: b.sectionG,
    generatedAt: b.generatedAt ? b.generatedAt.toISOString() : null,
    generatedBy: b.generatedBy,
    // Task #281 — surface the producing job's id directly. The UI
    // uses this to mark the matching row in the "Recent runs"
    // disclosure as "Current" instead of guessing from a
    // timestamp window. Null on legacy rows that pre-date the
    // backfill and on briefings whose producing job was pruned.
    generationId: b.generationId,
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
    narrative: toBriefingNarrativeWire(briefing),
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
 * DA-MV-1 — outcome of running the DXF→glb converter against an
 * already-stored DXF. The result is a partial column projection —
 * the route applies it on top of a `briefingSources` insert (POST)
 * or update (retry endpoint), so the same helper drives both
 * write paths.
 *
 * On success: `glbObjectPath` is the freshly-uploaded converted glb,
 * `conversionStatus` is `ready`, and `conversionError` is null.
 * On failure: `glbObjectPath` is null (no bytes to persist),
 * `conversionStatus` is `failed`, and `conversionError` carries the
 * `ConverterError.message` blurb verbatim — that string is what the
 * UI's per-source status pill renders.
 */
interface ConversionOutcome {
  glbObjectPath: string | null;
  conversionStatus: "ready" | "failed";
  conversionError: string | null;
}

/**
 * Run the DXF→glb converter against an already-stored DXF.
 * Network failures (converter timeout, 5xx, malformed response) are
 * caught here and translated into a `failed` outcome — the calling
 * route still inserts/updates the row so the architect has something
 * to retry against rather than getting a 500 with no row to point
 * at.
 *
 * Object-storage read errors are *not* caught here — those mean the
 * request body referenced a path that doesn't exist (or our bucket
 * is down), which the route should surface as a 400/500 rather than
 * stamp a misleading `failed` status on the row.
 */
async function runDxfConversion(args: {
  dxfObjectPath: string;
  layerKind: DxfLayerKind;
  originalFilename: string;
  reqLog: typeof logger;
}): Promise<ConversionOutcome> {
  const { dxfObjectPath, layerKind, originalFilename, reqLog } = args;
  const dxfBytes = await objectStorage().getObjectEntityBytes(dxfObjectPath);

  let glbBytes: Buffer;
  try {
    const result = await getConverterClient().convert({
      dxfBytes,
      layerKind,
      originalFilename,
    });
    glbBytes = result.glbBytes;
  } catch (err) {
    if (err instanceof ConverterError) {
      reqLog.warn(
        { err, layerKind, dxfObjectPath, code: err.code },
        "dxf→glb conversion failed — recording row with status=failed",
      );
      return {
        glbObjectPath: null,
        conversionStatus: "failed",
        conversionError: err.message,
      };
    }
    // Anything not a `ConverterError` is unexpected — propagate so
    // the route layer logs it as an unhandled 500 instead of
    // swallowing it into the row.
    throw err;
  }

  const glbObjectPath = await objectStorage().uploadObjectEntityFromBuffer(
    glbBytes,
    "model/gltf-binary",
  );
  return {
    glbObjectPath,
    conversionStatus: "ready",
    conversionError: null,
  };
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

    // DA-MV-1 — branch on upload modality. Default is "qgis" (the
    // pre-DA-MV-1 path) so old clients that never sent the field
    // keep working unchanged. The dxf branch is gated to the seven
    // Spec 52 §2 layer kinds and rejects mismatched pairings before
    // we touch storage / the converter.
    const uploadKind = body.upload.kind ?? "qgis";
    if (uploadKind === "dxf" && !isDxfLayerKind(body.layerKind)) {
      res.status(400).json({
        error: "invalid_dxf_layer_kind",
        message: `upload.kind="dxf" requires layerKind to be one of: ${DXF_LAYER_KINDS.join(", ")}`,
      });
      return;
    }
    if (uploadKind === "qgis" && isDxfLayerKind(body.layerKind)) {
      res.status(400).json({
        error: "dxf_layer_kind_requires_dxf_upload",
        message: `layerKind="${body.layerKind}" must be uploaded as upload.kind="dxf"`,
      });
      return;
    }

    // Run the converter outside the DB transaction — it's a network
    // call that can take seconds, and we don't want to hold a row
    // lock while waiting on an external service. The conversion
    // helper translates ConverterError into a `failed` outcome so
    // the row is still inserted (which is what the retry endpoint
    // operates against).
    //
    // BUT first: short-circuit on a missing engagement so a bad id
    // can't trigger an avoidable converter call + glb upload that
    // we'd then throw away. The in-transaction re-check below stays
    // for race safety.
    let conversion: ConversionOutcome | null = null;
    if (uploadKind === "dxf") {
      const engPre = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (engPre.length === 0) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      try {
        conversion = await runDxfConversion({
          dxfObjectPath: body.upload.objectPath,
          layerKind: body.layerKind as DxfLayerKind,
          originalFilename: body.upload.originalFilename,
          reqLog,
        });
      } catch (err) {
        // Only object-storage / unexpected failures land here —
        // ConverterErrors are caught inside the helper. Surface as
        // 500 so the architect sees something is wrong rather than
        // a row stamped `failed` that masks a bucket-level issue.
        logger.error(
          { err, engagementId, layerKind: body.layerKind },
          "create briefing source: dxf prep failed",
        );
        res.status(500).json({ error: "Failed to prepare DXF for conversion" });
        return;
      }
    }

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
            // DA-MV-1 — DXF branch carries the converter outcome.
            // QGIS branch leaves all four fields null so a "this
            // doesn't apply here" reads unambiguously on the wire.
            dxfObjectPath: uploadKind === "dxf" ? body.upload.objectPath : null,
            glbObjectPath: conversion?.glbObjectPath ?? null,
            conversionStatus: conversion?.conversionStatus ?? null,
            conversionError: conversion?.conversionError ?? null,
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

/**
 * POST /engagements/:id/briefing/sources/:sourceId/retry-conversion
 *
 * DA-MV-1 — re-run the DXF→glb converter against the briefing
 * source's already-stored DXF (`dxfObjectPath`) without forcing the
 * architect to re-upload. The retry path operates on the same row
 * (no new row inserted, no supersession) so the row's id stays
 * stable and the timeline doesn't grow a phantom version per retry.
 *
 * Idempotent against the row's identity: the row id is unchanged,
 * `glbObjectPath` and `conversionStatus` flip to whatever the
 * latest converter result is. (We do *not* delete the prior glb's
 * bytes — orphaned bytes are cheap and keeping them simplifies
 * recovery if a botched retry needs to be inspected.)
 *
 * Refuses non-DXF rows (a QGIS row has `conversionStatus = null`,
 * a federal-adapter row likewise) — those would silently no-op
 * which is harder to debug than a 400 stating the contract.
 */
router.post(
  "/engagements/:id/briefing/sources/:sourceId/retry-conversion",
  async (req: Request, res: Response) => {
    const paramsParse = RetryBriefingSourceConversionParams.safeParse(
      req.params,
    );
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_route_parameters" });
      return;
    }
    const { id: engagementId, sourceId } = paramsParse.data;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    let target: BriefingSource;
    let briefing: ParcelBriefing;
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
        .select()
        .from(parcelBriefings)
        .where(eq(parcelBriefings.engagementId, engagementId))
        .limit(1);
      if (!briefingRows[0]) {
        res.status(404).json({ error: "briefing_source_not_found" });
        return;
      }
      briefing = briefingRows[0];
      const targetRows = await db
        .select()
        .from(briefingSources)
        .where(eq(briefingSources.id, sourceId))
        .limit(1);
      if (!targetRows[0]) {
        res.status(404).json({ error: "briefing_source_not_found" });
        return;
      }
      target = targetRows[0];
      if (target.briefingId !== briefing.id) {
        res
          .status(400)
          .json({ error: "briefing_source_engagement_mismatch" });
        return;
      }
      // Refuse non-DXF rows. The conversionStatus column is the
      // canonical "this row owns a DXF" marker; a QGIS row has it
      // null and a federal-adapter row likewise. The dxfObjectPath
      // null check is belt-and-braces — it would only trip on a
      // DXF row whose path got nulled by hand.
      if (target.conversionStatus === null || !target.dxfObjectPath) {
        res.status(400).json({ error: "not_a_dxf_briefing_source" });
        return;
      }
      if (!isDxfLayerKind(target.layerKind)) {
        // Defensive: a DXF row with a non-DXF layer kind would mean
        // the schema was hand-edited. Refuse rather than reattempt
        // a conversion the converter would reject anyway.
        res.status(400).json({ error: "not_a_dxf_briefing_source" });
        return;
      }
    } catch (err) {
      logger.error(
        { err, engagementId, sourceId },
        "retry conversion: lookup failed",
      );
      res.status(500).json({ error: "Failed to retry briefing source conversion" });
      return;
    }

    let conversion: ConversionOutcome;
    try {
      conversion = await runDxfConversion({
        dxfObjectPath: target.dxfObjectPath,
        layerKind: target.layerKind as DxfLayerKind,
        originalFilename: target.uploadOriginalFilename ?? "upload.dxf",
        reqLog,
      });
    } catch (err) {
      logger.error(
        { err, engagementId, sourceId },
        "retry conversion: prep failed",
      );
      res.status(500).json({ error: "Failed to retry briefing source conversion" });
      return;
    }

    try {
      await db
        .update(briefingSources)
        .set({
          glbObjectPath: conversion.glbObjectPath,
          conversionStatus: conversion.conversionStatus,
          conversionError: conversion.conversionError,
        })
        .where(eq(briefingSources.id, target.id));
      // Touch the briefing's updatedAt so consumers polling the
      // briefing read see a fresh timestamp without having to peek
      // into the source rows.
      const [updatedBriefing] = await db
        .update(parcelBriefings)
        .set({ updatedAt: new Date() })
        .where(eq(parcelBriefings.id, briefing.id))
        .returning();
      const sources = await loadCurrentSources(briefing.id);
      res.json({ briefing: toBriefingWire(updatedBriefing, sources) });
    } catch (err) {
      logger.error(
        { err, engagementId, sourceId },
        "retry conversion: persist failed",
      );
      res.status(500).json({ error: "Failed to retry briefing source conversion" });
    }
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

/**
 * --- DA-PI-3: briefing generation kickoff + status polling ---
 *
 * Two endpoints:
 *
 *   - POST /engagements/:id/briefing/generate
 *       Kicks off an asynchronous run of the briefing engine
 *       (`@workspace/briefing-engine`). The route returns 202 +
 *       `{ generationId, state: "pending" }` immediately; the engine
 *       call runs in the background, persists the seven-section
 *       narrative on the `parcel_briefings` row, and emits
 *       `parcel-briefing.generated` (first run) or
 *       `parcel-briefing.regenerated` (subsequent runs, with the
 *       prior narrative copied into the `prior_section_*` backup
 *       columns inside the same transaction).
 *
 *   - GET /engagements/:id/briefing/status
 *       Returns the most recent generation's outcome for that
 *       engagement so the UI can poll until the run settles. Job
 *       state is persisted in `briefing_generation_jobs` (one row per
 *       kickoff), so it survives api-server restarts and stays
 *       coherent across multiple instances. The persisted briefing on
 *       `GET /briefing` remains the source of truth for the
 *       narrative; this endpoint is the mechanism the UI uses to know
 *       when the narrative has landed.
 */

/**
 * Closed wire union for the job's `state` column. The DB column is
 * `text` so writers must narrow into this union — anything else would
 * be a schema-violation we want to surface, not silently round-trip.
 */
type BriefingGenerationJobState = "pending" | "completed" | "failed";

/** PG unique-violation SQLSTATE — see the snapshots route's identical helper. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps pg errors in `DrizzleQueryError` with the underlying
 * pg error on `.cause`, so we check both the top level and `.cause`
 * (mirrors `routes/snapshots.ts`). Used to map the partial unique
 * index conflict on `(engagement_id) WHERE state = 'pending'` into
 * the route's 409 response.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || cause === PG_UNIQUE_VIOLATION;
}

/** Pinned event-type constants — break compilation on a rename. */
const PARCEL_BRIEFING_GENERATED_EVENT_TYPE: ParcelBriefingEventType =
  PARCEL_BRIEFING_EVENT_TYPES[1];
const PARCEL_BRIEFING_REGENERATED_EVENT_TYPE: ParcelBriefingEventType =
  PARCEL_BRIEFING_EVENT_TYPES[3];
const MATERIALIZABLE_ELEMENT_IDENTIFIED_EVENT_TYPE: MaterializableElementEventType =
  MATERIALIZABLE_ELEMENT_EVENT_TYPES[0];

/** Stable system actor for engine-driven generation events. */
const BRIEFING_ENGINE_ACTOR = {
  kind: "system" as const,
  id: BRIEFING_ENGINE_ACTOR_ID,
};

/**
 * `generatedBy` value persisted on `parcel_briefings.generated_by`.
 * Mirrors the audit-trail convention used elsewhere ("system:<id>")
 * so the wire payload is unambiguous to humans reading it without
 * having to inspect the actor envelope on the event chain.
 */
const BRIEFING_ENGINE_GENERATED_BY = "system:briefing-engine";

/**
 * Project a current `briefing_sources` row into the engine's input
 * shape. The engine only needs the cited surface — id, layerKind,
 * sourceKind, provider, snapshotDate, note. Payload is intentionally
 * omitted for now (DA-PI-3 baseline): the federal-adapter rows that
 * carry parsed JSON in a payload column will be wired in DA-PI-2 / 4.
 */
function toEngineSourceInput(s: BriefingSource): BriefingSourceInput {
  return {
    id: s.id,
    layerKind: s.layerKind,
    sourceKind: s.sourceKind,
    provider: s.provider,
    snapshotDate: s.snapshotDate.toISOString(),
    note: s.note,
  };
}

/**
 * Persist the engine's output to the briefing row in one transaction.
 * If the row already had a generated narrative, copy it into the
 * `prior_section_*` backup columns first so the audit trail can
 * reconstruct the prior version without loading the event chain.
 *
 * Returns:
 *   - the updated row,
 *   - whether this was a regeneration (a prior narrative existed and
 *     was backed up), so the caller can pick the right event type.
 */
async function persistGenerationResult(
  briefingId: string,
  generationId: string,
  result: GenerateBriefingResult,
): Promise<{ row: ParcelBriefing; wasRegeneration: boolean }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.id, briefingId))
      .limit(1);
    if (!current) {
      throw new Error(`parcel_briefings row vanished mid-generation: ${briefingId}`);
    }
    const hadPrior =
      current.sectionA !== null ||
      current.sectionB !== null ||
      current.sectionC !== null ||
      current.sectionD !== null ||
      current.sectionE !== null ||
      current.sectionF !== null ||
      current.sectionG !== null ||
      current.generatedAt !== null;
    const [updated] = await tx
      .update(parcelBriefings)
      .set({
        sectionA: result.sections.a,
        sectionB: result.sections.b,
        sectionC: result.sections.c,
        sectionD: result.sections.d,
        sectionE: result.sections.e,
        sectionF: result.sections.f,
        sectionG: result.sections.g,
        generatedAt: result.generatedAt,
        generatedBy: result.generatedBy,
        // Task #281 — stamp the producing job's id in the same
        // transaction that overwrites the section columns. Storing
        // it on the briefing row directly means the UI can match
        // "the narrative on screen" to "the run that produced it"
        // by id rather than picking the latest completed row in
        // the runs list — that heuristic was correct in practice
        // today but quietly drifts the moment a backfill writes
        // sections without inserting a job row, the runs route
        // paginates, or two completions race.
        generationId,
        // Backup columns: copy the previous narrative into the prior_*
        // slots (or clear them on first generation so the row's invariant
        // is "prior_* set ↔ current narrative was overwritten at least
        // once"). Drizzle's set() accepts null to clear.
        priorSectionA: hadPrior ? current.sectionA : null,
        priorSectionB: hadPrior ? current.sectionB : null,
        priorSectionC: hadPrior ? current.sectionC : null,
        priorSectionD: hadPrior ? current.sectionD : null,
        priorSectionE: hadPrior ? current.sectionE : null,
        priorSectionF: hadPrior ? current.sectionF : null,
        priorSectionG: hadPrior ? current.sectionG : null,
        priorGeneratedAt: hadPrior ? current.generatedAt : null,
        priorGeneratedBy: hadPrior ? current.generatedBy : null,
        updatedAt: new Date(),
      })
      .where(eq(parcelBriefings.id, briefingId))
      .returning();
    return { row: updated, wasRegeneration: hadPrior };
  });
}

/**
 * Best-effort emission of `parcel-briefing.generated` /
 * `parcel-briefing.regenerated`. Failures are caught + logged so a
 * history outage cannot fail the in-flight generation — the row is
 * the source of truth, the event chain is observability (mirrors the
 * contract used by `emitBriefingSourceFetchedEvent` above).
 */
async function emitParcelBriefingGeneratedEvent(
  history: EventAnchoringService,
  briefing: ParcelBriefing,
  result: GenerateBriefingResult,
  wasRegeneration: boolean,
  reqLog: typeof logger,
): Promise<void> {
  const eventType = wasRegeneration
    ? PARCEL_BRIEFING_REGENERATED_EVENT_TYPE
    : PARCEL_BRIEFING_GENERATED_EVENT_TYPE;
  let appendedEventId: string | null = null;
  try {
    const event = await history.appendEvent({
      entityType: "parcel-briefing",
      entityId: briefing.engagementId,
      eventType,
      actor: BRIEFING_ENGINE_ACTOR,
      payload: {
        briefingId: briefing.id,
        engagementId: briefing.engagementId,
        producer: result.producer,
        generatedAt: result.generatedAt.toISOString(),
        generatedBy: result.generatedBy,
        invalidCitationCount: result.invalidCitations.length,
        wasRegeneration,
      },
    });
    appendedEventId = event.id;
    reqLog.info(
      {
        briefingId: briefing.id,
        engagementId: briefing.engagementId,
        eventType,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "parcel-briefing generation event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        briefingId: briefing.id,
        engagementId: briefing.engagementId,
        eventType,
      },
      "parcel-briefing generation event append failed — row update kept",
    );
  }

  // V1-2 implicit-resolve hook: a `parcel-briefing.regenerated` emit
  // closes every `pending` reviewer-request whose target tuple matches
  // this engagement's parcel-briefing. Skip the first-generation case
  // (`!wasRegeneration`) — there's nothing to "regenerate" so any
  // pending request the architect could be honoring would have been
  // filed against a non-existent briefing. Best-effort.
  if (wasRegeneration && appendedEventId) {
    await resolveMatchingReviewerRequests({
      targetEntityType: "parcel-briefing",
      targetEntityId: briefing.engagementId,
      triggeredActionEventId: appendedEventId,
      log: reqLog,
    });
  }
  // DA-PI-5: emit one `materializable-element.identified` event per
  // requirement extracted from sections C/D/F. The atom is registered
  // in `atoms/registry.ts`, so the previous `BRIEFING_EMIT_MATERIALIZABLE`
  // env-flag gate is no longer needed — events flow on every successful
  // generation. Emission is best-effort per element so a single
  // history outage cannot fail the in-flight generation.
  await emitMaterializableElementIdentifiedEvents(
    history,
    briefing,
    result,
    reqLog,
  );
}

/**
 * Append one `materializable-element.identified` event per requirement
 * the engine extracted from sections C/D/F. Per-element entityId is
 * content-addressed within the briefing — `materializable-element:
 * {briefingId}:{section}:{index}` — so re-running generation against
 * the same input deterministically lands on the same atom ids and
 * downstream design-tooling subscribers can dedupe across runs.
 *
 * Failures are caught + logged per element so a single bad append
 * cannot prevent the rest of the requirements from being emitted.
 * The parent `parcel-briefing.generated` event is the durable
 * source-of-truth; `materializable-element.identified` is the
 * downstream-subscription convenience.
 */
async function emitMaterializableElementIdentifiedEvents(
  history: EventAnchoringService,
  briefing: ParcelBriefing,
  result: GenerateBriefingResult,
  reqLog: typeof logger,
): Promise<void> {
  for (const element of result.materializableElements) {
    const entityId = `materializable-element:${briefing.id}:${element.section}:${element.index}`;
    try {
      const event = await history.appendEvent({
        entityType: "materializable-element",
        entityId,
        eventType: MATERIALIZABLE_ELEMENT_IDENTIFIED_EVENT_TYPE,
        actor: BRIEFING_ENGINE_ACTOR,
        payload: {
          briefingId: briefing.id,
          engagementId: briefing.engagementId,
          section: element.section,
          index: element.index,
          text: element.text,
          producer: result.producer,
          generatedAt: result.generatedAt.toISOString(),
        },
      });
      reqLog.info(
        {
          briefingId: briefing.id,
          engagementId: briefing.engagementId,
          materializableElementId: entityId,
          section: element.section,
          index: element.index,
          eventId: event.id,
        },
        "materializable-element.identified event appended",
      );
    } catch (err) {
      reqLog.error(
        {
          err,
          briefingId: briefing.id,
          engagementId: briefing.engagementId,
          materializableElementId: entityId,
          section: element.section,
          index: element.index,
        },
        "materializable-element.identified event append failed — continuing",
      );
    }
  }
}

/**
 * Update a job row to a terminal state (`completed` / `failed`).
 * Always stamps `completed_at`. Best-effort with respect to row
 * existence — the kickoff route inserted the row before launching
 * this background task, so the only way the row is gone is a
 * concurrent engagement deletion (cascade). In that case we log
 * and move on; there's nothing for the status endpoint to surface.
 */
async function finalizeJob(
  generationId: string,
  patch: {
    state: Extract<BriefingGenerationJobState, "completed" | "failed">;
    error: string | null;
    invalidCitationCount: number | null;
    /**
     * Verbatim citation token strings the engine stripped because they
     * pointed at unknown ids (Task #176). Mirrors `invalidCitations`
     * on the engine result; the status endpoint surfaces this back to
     * the UI so it can render each one as a "broken" pill in the
     * invalid-citation warning. Null on the failed branch and on
     * legacy rows written before Task #176 landed.
     */
    invalidCitations: string[] | null;
  },
  reqLog: typeof logger,
): Promise<void> {
  try {
    const updated = await db
      .update(briefingGenerationJobs)
      .set({
        state: patch.state,
        error: patch.error,
        invalidCitationCount: patch.invalidCitationCount,
        invalidCitations: patch.invalidCitations,
        completedAt: new Date(),
      })
      .where(eq(briefingGenerationJobs.id, generationId))
      .returning({ id: briefingGenerationJobs.id });
    if (updated.length === 0) {
      reqLog.warn(
        { generationId, state: patch.state },
        "briefing generation: job row missing on terminal update (engagement likely deleted)",
      );
    }
  } catch (err) {
    reqLog.error(
      { err, generationId, state: patch.state },
      "briefing generation: terminal job-row update failed",
    );
  }
}

/**
 * Body of the async generation kickoff. Persists every state
 * transition to the `briefing_generation_jobs` row inserted by the
 * kickoff route, so the status endpoint surfaces the run's true
 * outcome even if this api-server process restarts mid-flight or
 * another instance handles the poll. Never throws — terminal
 * failures land in the row's `state="failed"` column.
 */
async function runBriefingGeneration(args: {
  engagementId: string;
  briefingId: string;
  generationId: string;
  generatedBy: string;
  sources: BriefingSource[];
  reqLog: typeof logger;
}): Promise<void> {
  const { engagementId, briefingId, generationId, generatedBy, sources, reqLog } = args;
  try {
    const client = await getBriefingLlmClient();
    const mode = getBriefingLlmMode();
    reqLog.info(
      { engagementId, briefingId, generationId, mode, sourceCount: sources.length },
      "briefing generation: engine call starting",
    );
    const result = await generateBriefing(
      {
        engagementId,
        sources: sources.map(toEngineSourceInput),
        generatedBy,
      },
      {
        mode,
        ...(client ? { anthropicClient: client } : {}),
      },
    );
    const { row, wasRegeneration } = await persistGenerationResult(
      briefingId,
      generationId,
      result,
    );
    await emitParcelBriefingGeneratedEvent(
      getHistoryService(),
      row,
      result,
      wasRegeneration,
      reqLog,
    );
    if (result.invalidCitations.length > 0) {
      reqLog.warn(
        {
          engagementId,
          briefingId,
          generationId,
          invalidCount: result.invalidCitations.length,
          sample: result.invalidCitations.slice(0, 5),
        },
        "briefing generation: engine emitted unresolved citation tokens (stripped)",
      );
    }
    await finalizeJob(
      generationId,
      {
        state: "completed",
        error: null,
        invalidCitationCount: result.invalidCitations.length,
        // Surface the exact stripped tokens so the UI can render each
        // one as a "broken" pill in the invalid-citation warning
        // (Task #176). The engine returns `ReadonlyArray<string>`;
        // copy into a mutable array for the DB writer's shape.
        invalidCitations: [...result.invalidCitations],
      },
      reqLog,
    );
    reqLog.info(
      {
        engagementId,
        briefingId,
        generationId,
        wasRegeneration,
        producer: result.producer,
      },
      "briefing generation: completed",
    );
  } catch (err) {
    const message = (err as Error).message ?? "unknown engine failure";
    await finalizeJob(
      generationId,
      {
        state: "failed",
        error: message,
        invalidCitationCount: null,
        invalidCitations: null,
      },
      reqLog,
    );
    reqLog.error(
      { err, engagementId, briefingId, generationId },
      "briefing generation: failed",
    );
  }
}

// Outcomes mirror the manual route's 404/400/409/202 response set so
// both call sites can share the same vocabulary.
export type KickoffBriefingOutcome =
  | { kind: "engagement_not_found" }
  | { kind: "no_briefing_sources_for_engagement" }
  | { kind: "already_in_flight"; generationId: string | null }
  | { kind: "started"; generationId: string; sourceCount: number };

// Shared kickoff helper used by the manual HTTP route and the
// `engagement.created` auto-trigger subscriber. Never throws.
// `onSettled` (optional) fires once the void-launched runner finalizes
// the job row, so callers can observe terminal state without polling.
export async function kickoffBriefingGeneration(args: {
  engagementId: string;
  reqLog: typeof logger;
  onSettled?: (settled: {
    state: "completed" | "failed";
    generationId: string;
    error: string | null;
  }) => void | Promise<void>;
}): Promise<KickoffBriefingOutcome> {
  const { engagementId, reqLog, onSettled } = args;
  const eng = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (eng.length === 0) {
    return { kind: "engagement_not_found" };
  }

  const briefingRows = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, engagementId))
    .limit(1);
  const briefing = briefingRows[0];
  if (!briefing) {
    return { kind: "no_briefing_sources_for_engagement" };
  }
  const sources = await loadCurrentSources(briefing.id);
  if (sources.length === 0) {
    return { kind: "no_briefing_sources_for_engagement" };
  }

  // Single-flight guard via partial unique index on
  // `briefing_generation_jobs (engagement_id) WHERE state='pending'`.
  let kickoffRow: BriefingGenerationJob;
  try {
    const inserted = await db
      .insert(briefingGenerationJobs)
      .values({
        engagementId,
        briefingId: briefing.id,
        state: "pending",
      })
      .returning();
    kickoffRow = inserted[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [existing] = await db
        .select({ id: briefingGenerationJobs.id })
        .from(briefingGenerationJobs)
        .where(eq(briefingGenerationJobs.engagementId, engagementId))
        .orderBy(desc(briefingGenerationJobs.startedAt))
        .limit(1);
      return {
        kind: "already_in_flight",
        generationId: existing?.id ?? null,
      };
    }
    throw err;
  }
  const generationId = kickoffRow.id;

  // Fire-and-forget. Callers return immediately; the job row's
  // state is what the status endpoint reads.
  void (async () => {
    await runBriefingGeneration({
      engagementId,
      briefingId: briefing.id,
      generationId,
      generatedBy: BRIEFING_ENGINE_GENERATED_BY,
      sources,
      reqLog,
    });
    if (!onSettled) return;
    try {
      const [terminal] = await db
        .select({
          state: briefingGenerationJobs.state,
          error: briefingGenerationJobs.error,
        })
        .from(briefingGenerationJobs)
        .where(eq(briefingGenerationJobs.id, generationId))
        .limit(1);
      if (
        terminal &&
        (terminal.state === "completed" || terminal.state === "failed")
      ) {
        await onSettled({
          state: terminal.state,
          generationId,
          error: terminal.error ?? null,
        });
      }
    } catch (err) {
      reqLog.warn(
        { err, engagementId, generationId },
        "briefing generation: onSettled subscriber threw",
      );
    }
  })();

  reqLog.info(
    {
      engagementId,
      briefingId: briefing.id,
      generationId,
      sourceCount: sources.length,
    },
    "briefing generation: kicked off",
  );
  return { kind: "started", generationId, sourceCount: sources.length };
}

router.post(
  "/engagements/:id/briefing/generate",
  async (req: Request, res: Response) => {
    const paramsParse = GenerateEngagementBriefingParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;
    // Body is optional — `regenerate` is informational today (the
    // route auto-detects a prior narrative). Parse defensively.
    const bodyParse = GenerateEngagementBriefingBody.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      res.status(400).json({ error: "invalid_briefing_generate_body" });
      return;
    }

    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    try {
      const outcome = await kickoffBriefingGeneration({
        engagementId,
        reqLog,
      });
      switch (outcome.kind) {
        case "engagement_not_found":
          res.status(404).json({ error: "engagement_not_found" });
          return;
        case "no_briefing_sources_for_engagement":
          // No briefing / no sources → nothing to synthesize. The 400
          // mirrors what the UI's tooltip says ("Upload a layer or run
          // an adapter first").
          res
            .status(400)
            .json({ error: "no_briefing_sources_for_engagement" });
          return;
        case "already_in_flight":
          res.status(409).json({
            error: "briefing_generation_already_in_flight",
            generationId: outcome.generationId,
          });
          return;
        case "started":
          reqLog.info(
            {
              engagementId,
              generationId: outcome.generationId,
              regenerate: bodyParse.data?.regenerate ?? false,
            },
            "briefing generation: manual kickoff route returning 202",
          );
          res
            .status(202)
            .json({ generationId: outcome.generationId, state: "pending" });
          return;
      }
    } catch (err) {
      logger.error({ err, engagementId }, "kickoff briefing generation failed");
      res.status(500).json({ error: "Failed to kick off briefing generation" });
    }
  },
);

router.get(
  "/engagements/:id/briefing/status",
  async (req: Request, res: Response) => {
    const paramsParse = GetEngagementBriefingGenerationStatusParams.safeParse(
      req.params,
    );
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

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
      // Read the most recent job for this engagement. Single-row
      // result (or zero, when no kickoff has ever run) — the partial
      // unique index keeps at most one `pending`, but completed/failed
      // rows accumulate over time, so order by `started_at DESC`.
      const [job] = await db
        .select()
        .from(briefingGenerationJobs)
        .where(eq(briefingGenerationJobs.engagementId, engagementId))
        .orderBy(desc(briefingGenerationJobs.startedAt))
        .limit(1);
      if (!job) {
        res.json({
          generationId: null,
          state: "idle",
          startedAt: null,
          completedAt: null,
          error: null,
          invalidCitationCount: null,
          invalidCitations: null,
        });
        return;
      }
      res.json({
        generationId: job.id,
        // The DB column is `text`; the writers in this file all narrow
        // into `BriefingGenerationJobState`, so a value outside that
        // union here would be a schema-violation we want to surface.
        state: job.state as BriefingGenerationJobState,
        startedAt: job.startedAt.toISOString(),
        completedAt: job.completedAt ? job.completedAt.toISOString() : null,
        error: job.error,
        invalidCitationCount: job.invalidCitationCount,
        invalidCitations: job.invalidCitations,
      });
    } catch (err) {
      logger.error(
        { err, engagementId },
        "get briefing generation status failed",
      );
      res.status(500).json({ error: "Failed to read briefing status" });
    }
  },
);

/**
 * GET /engagements/:id/briefing/runs — Task #230.
 *
 * Surface the recent briefing-generation attempts the
 * `briefingGenerationJobs` sweep already retains. The sister
 * `/briefing/status` endpoint deliberately collapses to one row (the
 * UI poll wants "what is the latest run doing right now?"), but
 * auditors investigating "the run before the bad one" need the
 * prior attempts visible without SSHing into the database — that's
 * the comparison window Task #201 carved out at the storage layer
 * but never exposed at the API layer.
 *
 * Cap mirrors the sweep's `keepPerEngagement` (default 5,
 * overridable via `BRIEFING_GENERATION_JOB_KEEP_PER_ENGAGEMENT`)
 * via the shared `resolveKeepPerEngagement` helper. If the API
 * returned more rows than the sweep keeps, the extras would silently
 * vanish on the next prune tick — keeping the two in lock-step
 * means a deploy-time env override applies to both at once.
 *
 * Pending rows are included (a freshly-kicked-off run IS one of the
 * recent attempts from the auditor's perspective, and the sweep
 * already counts pending toward its keep cap).
 */
router.get(
  "/engagements/:id/briefing/runs",
  async (req: Request, res: Response) => {
    const paramsParse = ListEngagementBriefingGenerationRunsParams.safeParse(
      req.params,
    );
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

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
      const limit = resolveKeepPerEngagement();
      // Newest first so the UI's "Recent runs" disclosure renders
      // top-to-bottom in chronological reverse order without an
      // additional sort. Bounded by the sweep's keep cap so the
      // wire shape cannot accidentally grow unbounded if a future
      // change loosens the prune retention.
      //
      // Task #280 — fetch the briefing row in parallel with the
      // jobs query so we can also surface the `prior_section_*`
      // backup columns alongside the runs. The prior narrative is
      // the snapshot the briefing held *before* its current
      // narrative was written; the regeneration transaction
      // stamps `prior_generated_at` atomically with the new
      // generation, so the FE can match that timestamp against
      // a job's [startedAt, completedAt] interval to figure out
      // which row in the disclosure produced it. There's at most
      // one prior on the wire because the briefing row only
      // retains one snapshot — older runs' bodies have already
      // been overwritten by newer regenerations.
      const [rows, briefingRows] = await Promise.all([
        db
          .select()
          .from(briefingGenerationJobs)
          .where(eq(briefingGenerationJobs.engagementId, engagementId))
          .orderBy(desc(briefingGenerationJobs.startedAt))
          .limit(limit),
        db
          .select()
          .from(parcelBriefings)
          .where(eq(parcelBriefings.engagementId, engagementId))
          .limit(1),
      ]);
      const briefing = briefingRows[0];
      // `prior_generated_at` is the load-bearing sentinel: the
      // regeneration transaction stamps it together with the
      // section_* backups, and `persistGenerationResult` clears
      // both back to null on a first-run-no-prior write. So
      // `priorGeneratedAt !== null` is the precise condition for
      // "the backup columns are populated and represent a real
      // prior narrative". When the briefing has never been
      // regenerated (or doesn't exist yet), surface `null` so
      // the FE doesn't try to match an empty interval.
      const priorNarrative =
        briefing && briefing.priorGeneratedAt
          ? {
              sectionA: briefing.priorSectionA,
              sectionB: briefing.priorSectionB,
              sectionC: briefing.priorSectionC,
              sectionD: briefing.priorSectionD,
              sectionE: briefing.priorSectionE,
              sectionF: briefing.priorSectionF,
              sectionG: briefing.priorSectionG,
              generatedAt: briefing.priorGeneratedAt.toISOString(),
              generatedBy: briefing.priorGeneratedBy,
            }
          : null;
      res.json({
        runs: rows.map((job) => ({
          generationId: job.id,
          // `state` in the DB is `text`; same narrowing the status
          // route does — a value outside the closed wire union here
          // would be a schema violation we want to surface, not
          // paper over.
          state: job.state as BriefingGenerationJobState,
          startedAt: job.startedAt.toISOString(),
          completedAt: job.completedAt
            ? job.completedAt.toISOString()
            : null,
          error: job.error,
          invalidCitationCount: job.invalidCitationCount,
        })),
        priorNarrative,
      });
    } catch (err) {
      logger.error(
        { err, engagementId },
        "list briefing generation runs failed",
      );
      res.status(500).json({ error: "Failed to read briefing runs" });
    }
  },
);

/**
 * GET /engagements/:id/briefing/export.pdf — DA-PI-6 stakeholder PDF.
 *
 * Synchronous render: reads the engagement + persisted briefing in one
 * round trip, hands the row to {@link renderBriefingPdf}, and streams
 * the resulting buffer back as `application/pdf`. Inline by default;
 * `?download=1` flips `Content-Disposition` to `attachment`.
 *
 * 422 `no_briefing_to_export` when the engagement exists but has no
 * generated narrative on file (the FE button is gated on the same
 * condition; this is defense-in-depth for direct API calls).
 *
 * Per-architect header override: when the request session carries a
 * `user`-kind requestor, we look up `users.architect_pdf_header` and
 * pass it through. Anonymous requests and missing rows fall back to
 * the default header. The lookup failure is non-fatal — a flaky
 * `users` read should not nuke the export.
 */
async function loadArchitectIdentity(
  req: Request,
  reqLog: typeof logger,
): Promise<{ header: string | null; displayName: string | null }> {
  const requestor = req.session?.requestor;
  if (!requestor || requestor.kind !== "user") {
    return { header: null, displayName: null };
  }
  try {
    const rows = await db
      .select({
        header: users.architectPdfHeader,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, requestor.id))
      .limit(1);
    const row = rows[0];
    return {
      header: row?.header ?? null,
      displayName: row?.displayName ?? null,
    };
  } catch (err) {
    reqLog.warn(
      { err, userId: requestor.id },
      "briefing pdf export: architect identity lookup failed — falling back to defaults",
    );
    return { header: null, displayName: null };
  }
}

router.get(
  "/engagements/:id/briefing/export.pdf",
  async (req: Request, res: Response) => {
    const paramsParse = ExportEngagementBriefingPdfParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const queryParse = ExportEngagementBriefingPdfQueryParams.safeParse(
      req.query,
    );
    if (!queryParse.success) {
      res.status(400).json({ error: "invalid_briefing_export_query" });
      return;
    }
    const engagementId = paramsParse.data.id;
    const wantsDownload = queryParse.data.download === "1";
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    try {
      const [engRows, briefingRows] = await Promise.all([
        db
          .select({
            id: engagements.id,
            name: engagements.name,
            jurisdiction: engagements.jurisdiction,
            address: engagements.address,
            latitude: engagements.latitude,
            longitude: engagements.longitude,
          })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .limit(1),
        db
          .select()
          .from(parcelBriefings)
          .where(eq(parcelBriefings.engagementId, engagementId))
          .limit(1),
      ]);
      const eng = engRows[0];
      if (!eng) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      const briefing = briefingRows[0];
      // Empty-export contract: no briefing row at all OR a briefing
      // row that has never been generated (every section_* column is
      // null) → 422 with the documented `no_briefing_to_export` code
      // so the FE can render its targeted "Generate the briefing
      // first" message rather than blanket-handling 4xx.
      if (!briefing || !briefing.generatedAt) {
        res.status(422).json({ error: "no_briefing_to_export" });
        return;
      }

      const sourceRows = await loadCurrentSources(briefing.id);
      const pdfSources: PdfBriefingSource[] = sourceRows.map((s) => ({
        id: s.id,
        layerKind: s.layerKind,
        sourceKind: s.sourceKind,
        provider: s.provider,
        snapshotDate: s.snapshotDate,
        note: s.note,
        // Wired through so the thumbnail page can render the
        // architect's actual upload (image preview when the file is
        // image-shaped, file-type tag otherwise) instead of a
        // placeholder card.
        uploadObjectPath: s.uploadObjectPath ?? null,
        uploadOriginalFilename: s.uploadOriginalFilename ?? null,
        uploadContentType: s.uploadContentType ?? null,
      }));

      const identity = await loadArchitectIdentity(req, reqLog);
      const header = identity.header ?? DEFAULT_BRIEFING_PDF_HEADER;

      const pdfBuffer = await renderBriefingPdf({
        engagement: {
          id: eng.id,
          name: eng.name,
          jurisdiction: eng.jurisdiction,
          address: eng.address,
          // Wired through so the site-map page can render a real
          // OSM static-tile capture centred on the engagement's
          // geocoded coordinates. Falls back to a labelled "no
          // coordinates" panel when null.
          latitude: eng.latitude,
          longitude: eng.longitude,
        },
        narrative: {
          // The PDF stamps the per-run `generation_id` (FK to
          // `briefing_generation_jobs`), so re-exporting after a
          // regeneration cycles the id and stakeholders can tell
          // two PDFs apart. Legacy rows whose producing job was
          // pruned before Task #281 carry NULL here; the renderer
          // surfaces that explicitly rather than fabricating an id.
          generationId: briefing.generationId,
          briefingId: briefing.id,
          sections: {
            a: briefing.sectionA ?? "",
            b: briefing.sectionB ?? "",
            c: briefing.sectionC ?? "",
            d: briefing.sectionD ?? "",
            e: briefing.sectionE ?? "",
            f: briefing.sectionF ?? "",
            g: briefing.sectionG ?? "",
          },
          generatedAt: briefing.generatedAt,
          generatedBy: briefing.generatedBy,
        },
        sources: pdfSources,
        header,
        architectName: identity.displayName,
      });

      // Stable filename — engagement name slugged, no embedded
      // timestamp so a second export overwrites the first when the
      // architect saves to disk (matches the implicit contract of an
      // "Export PDF" button).
      const slug =
        eng.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "briefing";
      const disposition = wantsDownload ? "attachment" : "inline";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${slug}-briefing.pdf"`,
      );
      res.setHeader("Content-Length", String(pdfBuffer.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.status(200).end(pdfBuffer);

      reqLog.info(
        {
          engagementId,
          briefingId: briefing.id,
          sourceCount: pdfSources.length,
          bytes: pdfBuffer.length,
          disposition,
        },
        "briefing pdf export: rendered",
      );
    } catch (err) {
      logger.error(
        { err, engagementId },
        "briefing pdf export: render failed",
      );
      res.status(500).json({ error: "Failed to render briefing PDF" });
    }
  },
);

export default router;
