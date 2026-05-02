/**
 * V1-4 / DA-RP-1 — mnml.ai render trigger + persistence routes.
 *
 * Endpoints:
 *   POST /api/engagements/:id/renders   — kickoff (kind = still | elevation-set | video)
 *   GET  /api/renders/:id                — single render status + outputs
 *   GET  /api/engagements/:id/renders    — list per engagement (newest first)
 *   POST /api/renders/:id/cancel         — server-side cancel (mnml has no cancel API per Spec 54 v2 §6.1)
 *
 * Elevation-set fan-out (Spec 54 v2 §6.2):
 *   ONE viewpoint_renders row + N (=4) child mnml /v1/archDiffusion-v43
 *   calls. Per-direction in-flight state lives in `mnml_jobs` JSONB on
 *   the parent row; render_outputs rows are inserted only when each
 *   child resolves to `ready`. Any-child-fail → parent fail with
 *   error_code "elevation_set_partial" + error_details listing which
 *   directions failed (Phase 1A approved). Partial successes still
 *   mirror so the architect can re-trigger only the failed
 *   direction(s) without re-rendering the whole set.
 *
 * Polling worker (fire-and-forget):
 *   Each kickoff fires `void runRenderPolling(...)`. The worker walks
 *   the lifecycle (capture → trigger → poll → mirror → terminal),
 *   persisting state on each transition + emitting atom events. Errors
 *   inside the worker land on the row's error_code/error_message
 *   columns; the worker itself never throws to the request handler
 *   (which has long since returned 202). Mirrors the runBriefingGeneration
 *   pattern in parcelBriefings.ts.
 *
 * Audience guard: `requireArchitectAudience` is inlined here pending
 * V1-3 PR #2's `audienceGuards.ts` extract. Once V1-3 merges and we
 * rebase, the local function flips to a single-line import. Per the
 * Phase 1A path-(b) recommendation.
 *
 * Production feature flag: `RENDERS_PROD_ENABLED=true` is required to
 * accept kickoffs when NODE_ENV=production. Mock mode (the default)
 * is permissive in dev / CI / staging. Locked decision §4 from the
 * Phase 1A approval.
 *
 * GLB resolution: V1-4 requires the kickoff body to include `glbUrl`
 * (an absolute URL the FE provides — typically a signed object-storage
 * URL the FE already loaded into its viewer). Server-side resolution
 * from the bim-model row's pointer is V1-5 work; the route returns 400
 * if `glbUrl` is missing. The capture helper accepts the URL verbatim.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  bimModels,
  db,
  engagements,
  parcelBriefings,
  renderOutputs,
  viewpointRenders,
  type ViewpointRender,
} from "@workspace/db";
import {
  estimateRenderCost,
  getMnmlClient,
  MnmlError,
  type ArchDiffusionRequest,
  type DomainRenderKind,
  type RenderRequest,
  type VideoAiRequest,
} from "@workspace/mnml-client";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  captureBimViewport,
  BimViewportCaptureError,
  type CaptureVec3,
} from "../lib/bimViewportCapture";
import {
  mirrorRenderOutput,
  RenderMirrorError,
} from "../lib/rendersObjectMirror";
import { runRendersSweep } from "../lib/rendersSweep";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Polling cadence: first poll after 3s, subsequent at 5s. Spec 54 v2 §2.3. */
const FIRST_POLL_DELAY_MS = 3_000;
const STEADY_POLL_DELAY_MS = 5_000;

/**
 * Hard wall-clock cap on the per-render polling loop. After this much
 * time has elapsed since trigger, mark the row failed with code
 * `polling_timeout`. mnml's typical render time is 30-60s; this cap
 * leaves comfortable headroom for 5-10s videos which can take longer.
 */
const MAX_POLL_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Elevation-set conventions. mnml's `camera_direction` enum is camera-
 * relative (which side of the building the camera is on). Our role
 * names are building-relative (which face is shown). The mapping
 * assumes the architect's GLB faces "front = south" — common for
 * residential. V1-5 can add a per-bim-model orientation override.
 */
const ELEVATION_SET_CALLS = [
  { role: "elevation-n" as const, cameraDirection: "back" as const, axis: "+z" as const },
  { role: "elevation-e" as const, cameraDirection: "right" as const, axis: "+x" as const },
  { role: "elevation-s" as const, cameraDirection: "front" as const, axis: "-z" as const },
  { role: "elevation-w" as const, cameraDirection: "left" as const, axis: "-x" as const },
];

/**
 * System actor for the polling worker's atom event emissions. The
 * row's `requested_by` column carries the architect's id (extracted
 * from the request session) — that's a separate concept.
 */
const RENDER_SYSTEM_ACTOR: { kind: "system"; id: string } = {
  kind: "system",
  id: "renders",
};

// ─────────────────────────────────────────────────────────────────────
// Audience guard (inline pending V1-3's audienceGuards.ts)
// ─────────────────────────────────────────────────────────────────────

/**
 * Architect-only routes. Returns `true` and sends a 403 when the
 * caller's session audience is not internal; the caller early-returns
 * on `true`. Mirrors the bimModels.ts `requireArchitectAudience`
 * pattern verbatim — V1-3 PR #2 extracts both copies into a shared
 * `audienceGuards.ts`; the post-merge rebase here is a single-line
 * swap to an import.
 */
function requireArchitectAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "renders_requires_architect_audience" });
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

/**
 * Production gate. Mock mode is the default in dev / CI / staging;
 * production requires the operator to flip RENDERS_PROD_ENABLED=true
 * after canary QA. Returns `true` when the gate is open.
 */
function rendersProdGateOpen(): boolean {
  if (process.env["NODE_ENV"] !== "production") return true;
  return process.env["RENDERS_PROD_ENABLED"] === "true";
}

// ─────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────

const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** Common fields across all kinds. */
const KickoffCommonSchema = z.object({
  glbUrl: z.string().url(),
  prompt: z.string().min(1).max(2000),
  expertName: z
    .enum(["exterior", "interior", "masterplan", "landscape", "plan", "product"])
    .optional(),
  renderStyle: z
    .enum([
      "raw",
      "photoreal",
      "cgi_render",
      "cad",
      "freehand_sketch",
      "clay_model",
      "illustration",
      "watercolor",
    ])
    .optional(),
  expertParams: z.record(z.string(), z.string()).optional(),
});

const KickoffStillSchema = KickoffCommonSchema.extend({
  kind: z.literal("still"),
  cameraPosition: Vec3Schema,
  cameraTarget: Vec3Schema,
  fov: z.number().min(10).max(120).optional(),
});

const KickoffElevationSetSchema = KickoffCommonSchema.extend({
  kind: z.literal("elevation-set"),
  buildingCenter: Vec3Schema,
  cameraDistance: z.number().positive(),
  cameraHeight: z.number(),
  fov: z.number().min(10).max(120).optional(),
});

const KickoffVideoSchema = KickoffCommonSchema.extend({
  kind: z.literal("video"),
  cameraPosition: Vec3Schema,
  cameraTarget: Vec3Schema,
  duration: z.union([z.literal(5), z.literal(10)]),
  cfgScale: z.number().min(0).max(1).optional(),
  aspectRatio: z.enum(["16:9", "4:3", "1:1"]).optional(),
  movementType: z
    .enum(["horizontal", "vertical", "zoom_in", "zoom_out", "pan"])
    .optional(),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
});

const KickoffBodySchema = z.discriminatedUnion("kind", [
  KickoffStillSchema,
  KickoffElevationSetSchema,
  KickoffVideoSchema,
]);

type KickoffBody = z.infer<typeof KickoffBodySchema>;

const EngagementIdParamsSchema = z.object({ id: z.string().uuid() });
const RenderIdParamsSchema = z.object({ id: z.string().uuid() });

// ─────────────────────────────────────────────────────────────────────
// In-flight job state shape (stored as JSONB in viewpoint_renders.mnml_jobs)
// ─────────────────────────────────────────────────────────────────────

type ElevationSetJobStatus =
  | "pending-trigger"
  | "queued"
  | "rendering"
  | "ready"
  | "failed";

interface ElevationSetJob {
  role: "elevation-n" | "elevation-e" | "elevation-s" | "elevation-w";
  cameraDirection: "front" | "back" | "right" | "left";
  mnmlJobId: string | null;
  status: ElevationSetJobStatus;
  error?: { code: string; message: string };
  /** Captured pre-mirror; populated when mnml returns success. */
  outputUrl?: string;
  /** Populated post-mirror. */
  mirroredObjectKey?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute camera position + look-at for an elevation-set face. Y-up,
 * Z+ = north convention (matches the FE BimViewer's defaults). Camera
 * sits on the cardinal axis at `distance` from the buildingCenter,
 * elevated by `height`, looking at a point one third the height above
 * the building's centroid.
 */
function computeElevationCamera(
  buildingCenter: CaptureVec3,
  distance: number,
  height: number,
  axis: "+x" | "-x" | "+z" | "-z",
): { cameraPosition: CaptureVec3; cameraTarget: CaptureVec3 } {
  const target: CaptureVec3 = {
    x: buildingCenter.x,
    y: buildingCenter.y + height / 3,
    z: buildingCenter.z,
  };
  let position: CaptureVec3;
  switch (axis) {
    case "+x":
      position = { x: buildingCenter.x + distance, y: buildingCenter.y + height, z: buildingCenter.z };
      break;
    case "-x":
      position = { x: buildingCenter.x - distance, y: buildingCenter.y + height, z: buildingCenter.z };
      break;
    case "+z":
      position = { x: buildingCenter.x, y: buildingCenter.y + height, z: buildingCenter.z + distance };
      break;
    case "-z":
      position = { x: buildingCenter.x, y: buildingCenter.y + height, z: buildingCenter.z - distance };
      break;
  }
  return { cameraPosition: position, cameraTarget: target };
}

/**
 * Snapshot the upstream atom_event_ids at trigger time per Spec 54 §6.
 * Best-effort; null on history outage so the row still inserts.
 */
async function snapshotUpstreamAtomEventIds(
  briefingId: string | null,
  bimModelId: string | null,
): Promise<{ briefingAtomEventId: string | null; bimModelAtomEventId: string | null }> {
  const history = getHistoryService();
  let briefingAtomEventId: string | null = null;
  let bimModelAtomEventId: string | null = null;
  if (briefingId) {
    try {
      const latest = await history.latestEvent({
        kind: "atom",
        entityType: "parcel-briefing",
        entityId: briefingId,
      });
      briefingAtomEventId = latest?.id ?? null;
    } catch {
      // Best-effort.
    }
  }
  if (bimModelId) {
    try {
      const latest = await history.latestEvent({
        kind: "atom",
        entityType: "bim-model",
        entityId: bimModelId,
      });
      bimModelAtomEventId = latest?.id ?? null;
    } catch {
      // Best-effort.
    }
  }
  return { briefingAtomEventId, bimModelAtomEventId };
}

/** Wrap event emission in try/catch — history outage must not fail the in-flight render. */
async function emitRenderEvent(
  viewpointRenderId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const history = getHistoryService();
  try {
    await history.appendEvent({
      entityType: "viewpoint-render",
      entityId: viewpointRenderId,
      eventType,
      actor: RENDER_SYSTEM_ACTOR,
      payload,
    });
  } catch (err) {
    logger.warn(
      { err, viewpointRenderId, eventType },
      "viewpoint-render event emission failed",
    );
  }
}

/**
 * Build the mnml RenderRequest for a `still` or `video` kickoff. For
 * elevation-set, the worker calls this once per direction with each
 * direction's captured image + camera_direction expert param.
 */
function buildArchDiffusionForStill(
  body: z.infer<typeof KickoffStillSchema>,
  image: Buffer,
): ArchDiffusionRequest {
  return {
    kind: "archdiffusion",
    image,
    prompt: body.prompt,
    ...(body.expertName ? { expertName: body.expertName } : {}),
    ...(body.renderStyle ? { renderStyle: body.renderStyle } : {}),
    ...(body.expertParams ? { expertParams: body.expertParams } : {}),
  };
}

function buildArchDiffusionForElevation(
  body: z.infer<typeof KickoffElevationSetSchema>,
  image: Buffer,
  cameraDirection: ElevationSetJob["cameraDirection"],
): ArchDiffusionRequest {
  const expertParams = {
    ...(body.expertParams ?? {}),
    camera_angle: "elevation",
    camera_direction: cameraDirection,
  };
  return {
    kind: "archdiffusion",
    image,
    prompt: body.prompt,
    expertName: body.expertName ?? "exterior",
    ...(body.renderStyle ? { renderStyle: body.renderStyle } : {}),
    expertParams,
  };
}

function buildVideoRequest(
  body: z.infer<typeof KickoffVideoSchema>,
  image: Buffer,
): VideoAiRequest {
  return {
    kind: "video",
    image,
    prompt: body.prompt,
    duration: body.duration,
    ...(body.cfgScale !== undefined ? { cfgScale: body.cfgScale } : {}),
    ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}),
    ...(body.movementType ? { movementType: body.movementType } : {}),
    ...(body.direction ? { direction: body.direction } : {}),
  };
}

/**
 * Map an MnmlError to the api-server's coarse error_code surface
 * stored on viewpoint_renders.error_code. Mirrors Spec 54 v2 §5
 * buckets onto our internal taxonomy.
 */
function mnmlErrorToCode(err: MnmlError): string {
  switch (err.kind) {
    case "insufficient_credits":
      return "insufficient_credits";
    case "rate_limited":
      return "rate_limited";
    case "validation":
      return "mnml_validation";
    case "auth":
      return "mnml_auth";
    case "not_found":
      return "mnml_not_found";
    case "unavailable":
      return "unavailable";
    case "transport":
      return "unavailable";
  }
}

/** Map MnmlError to an HTTP status for the synchronous trigger surface. */
function mnmlErrorToHttpStatus(err: MnmlError): number {
  switch (err.kind) {
    case "validation":
      return 400;
    case "auth":
      return 502; // mnml-side auth — backend issue, not user error
    case "insufficient_credits":
      return 402;
    case "not_found":
      return 502;
    case "rate_limited":
      return 503;
    case "unavailable":
    case "transport":
      return 503;
  }
}

/**
 * Persist a terminal state on the viewpoint_renders row. Returns the
 * updated row. Wrapped in a transaction with the render_outputs
 * inserts so a partial state never leaks to a concurrent reader.
 */
async function persistTerminalState(
  viewpointRenderId: string,
  patch: {
    status: "ready" | "failed" | "cancelled";
    errorCode?: string | null;
    errorMessage?: string | null;
    errorDetails?: Record<string, unknown> | null;
    completedAt?: Date;
    mnmlJobs?: ElevationSetJob[] | null;
    outputs?: Array<{
      role: string;
      format: string;
      resolution: string | null;
      sizeBytes: number | null;
      durationSeconds: number | null;
      sourceUrl: string;
      mirroredObjectKey: string | null;
      thumbnailUrl: string | null;
      mnmlOutputId: string | null;
      seed: number | null;
    }>;
  },
): Promise<ViewpointRender> {
  return db.transaction(async (tx) => {
    if (patch.outputs) {
      for (const out of patch.outputs) {
        await tx.insert(renderOutputs).values({
          viewpointRenderId,
          role: out.role,
          format: out.format,
          resolution: out.resolution,
          sizeBytes: out.sizeBytes,
          durationSeconds: out.durationSeconds,
          sourceUrl: out.sourceUrl,
          mirroredObjectKey: out.mirroredObjectKey,
          thumbnailUrl: out.thumbnailUrl,
          mnmlOutputId: out.mnmlOutputId,
          seed: out.seed,
        });
      }
    }
    const [row] = await tx
      .update(viewpointRenders)
      .set({
        status: patch.status,
        errorCode: patch.errorCode ?? null,
        errorMessage: patch.errorMessage ?? null,
        errorDetails: patch.errorDetails ?? null,
        completedAt: patch.completedAt ?? new Date(),
        ...(patch.mnmlJobs !== undefined ? { mnmlJobs: patch.mnmlJobs } : {}),
        updatedAt: new Date(),
      })
      .where(eq(viewpointRenders.id, viewpointRenderId))
      .returning();
    return row!;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Polling worker (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────

/**
 * Drive a render through capture → trigger → poll → mirror → terminal.
 * Fire-and-forget: never throws to the caller. All errors land on the
 * row's error_code/error_message columns + a `viewpoint-render.failed`
 * atom event.
 *
 * The kickoff route invokes this with `void runRenderPolling(...)` and
 * returns 202 to the architect immediately. Exported so integration
 * tests can await it directly (rather than racing an HTTP poll
 * against the fire-and-forget Promise) — the production path still
 * uses the void-call form.
 */
export async function runRenderPolling(args: {
  viewpointRenderId: string;
  body: KickoffBody;
}): Promise<void> {
  const { viewpointRenderId, body } = args;
  try {
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.requested", {
      kind: body.kind,
    });

    if (body.kind === "elevation-set") {
      await runElevationSet(viewpointRenderId, body);
    } else {
      await runSingleCall(viewpointRenderId, body);
    }
  } catch (err) {
    // Last-ditch safety net. The branches above already persist their
    // own errors, but a hard crash here (e.g. unhandled async) would
    // otherwise leave the row pinned in `queued` forever. Persist a
    // generic failure so the sweep can age it out.
    logger.error(
      { err, viewpointRenderId },
      "runRenderPolling crashed unexpectedly — persisting generic failure",
    );
    try {
      await persistTerminalState(viewpointRenderId, {
        status: "failed",
        errorCode: "internal_error",
        errorMessage: (err as Error).message ?? "unknown",
      });
      await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", {
        errorCode: "internal_error",
      });
    } catch {
      // Nothing left to try.
    }
  }
}

// Single-call branch for `still` and `video` kickoffs.
async function runSingleCall(
  viewpointRenderId: string,
  body: Extract<KickoffBody, { kind: "still" } | { kind: "video" }>,
): Promise<void> {
  const cameraPosition = body.cameraPosition;
  const cameraTarget = body.cameraTarget;

  // 1. Capture viewport
  let imageBuffer: Buffer;
  try {
    const cap = await captureBimViewport({
      glbUrl: body.glbUrl,
      cameraPosition,
      cameraTarget,
      // Reorder narrows body to the still variant BEFORE accessing
      // `fov` — TS can't see through the property access otherwise
      // because the discriminated union's video variant has no `fov`.
      ...(body.kind === "still" && body.fov !== undefined ? { fov: body.fov } : {}),
    });
    imageBuffer = cap.pngBuffer;
  } catch (err) {
    const code = err instanceof BimViewportCaptureError ? `capture_${err.code}` : "capture_failed";
    await persistTerminalState(viewpointRenderId, {
      status: "failed",
      errorCode: code,
      errorMessage: (err as Error).message,
    });
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", { errorCode: code });
    return;
  }

  // 2. Trigger mnml
  const mnml = getMnmlClient();
  const renderRequest: RenderRequest =
    body.kind === "video"
      ? buildVideoRequest(body, imageBuffer)
      : buildArchDiffusionForStill(body, imageBuffer);
  let renderId: string;
  try {
    const result = await mnml.triggerRender(renderRequest);
    renderId = result.renderId;
  } catch (err) {
    if (err instanceof MnmlError) {
      const code = mnmlErrorToCode(err);
      await persistTerminalState(viewpointRenderId, {
        status: "failed",
        errorCode: code,
        errorMessage: err.message,
        errorDetails: (err.details ?? null) as Record<string, unknown> | null,
      });
      await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", { errorCode: code });
      return;
    }
    throw err;
  }
  await db
    .update(viewpointRenders)
    .set({ mnmlJobId: renderId, status: "queued", updatedAt: new Date() })
    .where(eq(viewpointRenders.id, viewpointRenderId));
  await emitRenderEvent(viewpointRenderId, "viewpoint-render.queued", { mnmlJobId: renderId });

  // 3. Poll until terminal
  const startedAt = Date.now();
  let firstPoll = true;
  let everSawRendering = false;
  while (true) {
    if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
      await persistTerminalState(viewpointRenderId, {
        status: "failed",
        errorCode: "polling_timeout",
        errorMessage: `render did not reach terminal within ${MAX_POLL_DURATION_MS}ms`,
      });
      await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", { errorCode: "polling_timeout" });
      return;
    }
    await delay(firstPoll ? FIRST_POLL_DELAY_MS : STEADY_POLL_DELAY_MS);
    firstPoll = false;

    // Cancellation check
    const [row] = await db.select({ status: viewpointRenders.status }).from(viewpointRenders).where(eq(viewpointRenders.id, viewpointRenderId)).limit(1);
    if (!row || row.status === "cancelled") return;

    let status;
    try {
      status = await mnml.getRenderStatus(renderId);
    } catch (err) {
      if (err instanceof MnmlError) {
        // Transient mnml errors during polling — log and retry next iteration.
        // A persistent error rolls past MAX_POLL_DURATION_MS into the timeout branch.
        logger.warn({ err, viewpointRenderId, renderId }, "mnml status poll failed, will retry");
        continue;
      }
      throw err;
    }

    if (status.status === "rendering" && !everSawRendering) {
      everSawRendering = true;
      await db
        .update(viewpointRenders)
        .set({ status: "rendering", updatedAt: new Date() })
        .where(eq(viewpointRenders.id, viewpointRenderId));
      await emitRenderEvent(viewpointRenderId, "viewpoint-render.rendering", {});
    }

    if (status.status === "ready") {
      await finalizeSingleCallReady(viewpointRenderId, body, renderId, status.outputUrls ?? [], status.seed);
      return;
    }
    if (status.status === "failed") {
      const code = "mnml_failed";
      await persistTerminalState(viewpointRenderId, {
        status: "failed",
        errorCode: code,
        errorMessage: status.error?.message ?? "mnml render failed",
      });
      await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", { errorCode: code });
      return;
    }
    if (status.status === "cancelled") {
      // Server-side cancellation observed via mnml — mirror it on our row.
      await persistTerminalState(viewpointRenderId, { status: "cancelled" });
      return;
    }
  }
}

async function finalizeSingleCallReady(
  viewpointRenderId: string,
  body: Extract<KickoffBody, { kind: "still" } | { kind: "video" }>,
  mnmlRenderId: string,
  outputUrls: string[],
  seed?: number,
): Promise<void> {
  // Spec 54 v2 §2.3: `message` is typically length-1. Phase 1A approved
  // decision: log + emit audit event if mnml ever returns more.
  if (outputUrls.length === 0) {
    await persistTerminalState(viewpointRenderId, {
      status: "failed",
      errorCode: "mnml_empty_outputs",
      errorMessage: "mnml status=success but message[] was empty",
    });
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", { errorCode: "mnml_empty_outputs" });
    return;
  }
  if (outputUrls.length > 1) {
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.unexpected-output-shape", {
      outputCount: outputUrls.length,
      kind: body.kind,
      mnmlRenderId,
    });
  }

  const primaryUrl = outputUrls[0]!;
  const role = body.kind === "video" ? "video-primary" : "primary";
  const contentType = body.kind === "video" ? "video/mp4" : "image/png";

  let mirror;
  try {
    mirror = await mirrorRenderOutput({
      outputUrl: primaryUrl,
      contentType,
      renderId: viewpointRenderId,
      role,
    });
  } catch (err) {
    const code = err instanceof RenderMirrorError ? `mirror_${err.code}` : "mirror_failed";
    await persistTerminalState(viewpointRenderId, {
      status: "failed",
      errorCode: code,
      errorMessage: (err as Error).message,
    });
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", { errorCode: code });
    return;
  }

  const outputs: Array<Parameters<typeof persistTerminalState>[1]["outputs"] extends Array<infer T> | undefined ? T : never> = [
    {
      role,
      format: body.kind === "video" ? "mp4" : "png",
      resolution: null,
      sizeBytes: mirror.sizeBytes,
      durationSeconds: body.kind === "video" ? body.duration : null,
      sourceUrl: primaryUrl,
      mirroredObjectKey: mirror.mirroredObjectKey,
      thumbnailUrl: null,
      mnmlOutputId: null,
      seed: seed ?? null,
    },
  ];

  // For video, the mirror returned a thumbnail. Persist a second
  // render-output row tagged `video-thumbnail`.
  if (body.kind === "video" && mirror.thumbnailUrl && mirror.thumbnailObjectKey) {
    outputs.push({
      role: "video-thumbnail",
      format: "jpg",
      resolution: null,
      sizeBytes: mirror.thumbnailSizeBytes ?? null,
      durationSeconds: null,
      sourceUrl: primaryUrl, // synthesized from the mp4 — point at parent for traceability
      mirroredObjectKey: mirror.thumbnailObjectKey,
      thumbnailUrl: null,
      mnmlOutputId: null,
      seed: null,
    });
  }

  await persistTerminalState(viewpointRenderId, {
    status: "ready",
    completedAt: new Date(),
    outputs,
  });
  await emitRenderEvent(viewpointRenderId, "viewpoint-render.ready", { mnmlRenderId, outputCount: outputs.length });
}

// Elevation-set branch — 4 captures + 4 mnml calls + 4-way rollup.
async function runElevationSet(
  viewpointRenderId: string,
  body: Extract<KickoffBody, { kind: "elevation-set" }>,
): Promise<void> {
  // 1. Initialize mnml_jobs jsonb with 4 pending entries.
  const initialJobs: ElevationSetJob[] = ELEVATION_SET_CALLS.map((call) => ({
    role: call.role,
    cameraDirection: call.cameraDirection,
    mnmlJobId: null,
    status: "pending-trigger",
  }));
  await db
    .update(viewpointRenders)
    .set({ mnmlJobs: initialJobs, updatedAt: new Date() })
    .where(eq(viewpointRenders.id, viewpointRenderId));

  // 2. For each direction: capture + trigger. Sequential to keep the
  //    mnml-side rate-limit footprint small (4 concurrent triggers
  //    risk a 429); the polling loop below is still single-pass.
  const jobs = [...initialJobs];
  const mnml = getMnmlClient();
  for (let i = 0; i < ELEVATION_SET_CALLS.length; i++) {
    const call = ELEVATION_SET_CALLS[i]!;
    const cam = computeElevationCamera(body.buildingCenter, body.cameraDistance, body.cameraHeight, call.axis);
    let imageBuffer: Buffer;
    try {
      const cap = await captureBimViewport({
        glbUrl: body.glbUrl,
        cameraPosition: cam.cameraPosition,
        cameraTarget: cam.cameraTarget,
        ...(body.fov !== undefined ? { fov: body.fov } : {}),
      });
      imageBuffer = cap.pngBuffer;
    } catch (err) {
      jobs[i] = {
        ...jobs[i]!,
        status: "failed",
        error: { code: "capture_failed", message: (err as Error).message },
      };
      continue;
    }
    try {
      const triggerResult = await mnml.triggerRender(
        buildArchDiffusionForElevation(body, imageBuffer, call.cameraDirection),
      );
      jobs[i] = {
        ...jobs[i]!,
        status: "queued",
        mnmlJobId: triggerResult.renderId,
      };
    } catch (err) {
      if (err instanceof MnmlError) {
        const code = mnmlErrorToCode(err);
        jobs[i] = {
          ...jobs[i]!,
          status: "failed",
          error: { code, message: err.message },
        };
        continue;
      }
      throw err;
    }
  }

  await db
    .update(viewpointRenders)
    .set({ mnmlJobs: jobs, status: "queued", updatedAt: new Date() })
    .where(eq(viewpointRenders.id, viewpointRenderId));
  await emitRenderEvent(viewpointRenderId, "viewpoint-render.queued", { mnmlJobs: jobs.length });

  // 3. Poll loop. On each tick, refresh state for every job that's
  //    not yet terminal.
  const startedAt = Date.now();
  let firstPoll = true;
  while (true) {
    if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
      // Time out the whole set. Any still-non-terminal jobs are forced to failed.
      for (let i = 0; i < jobs.length; i++) {
        if (!isTerminalJob(jobs[i]!)) {
          jobs[i] = { ...jobs[i]!, status: "failed", error: { code: "polling_timeout", message: "set timed out before all children resolved" } };
        }
      }
      await finalizeElevationSet(viewpointRenderId, body, jobs);
      return;
    }
    await delay(firstPoll ? FIRST_POLL_DELAY_MS : STEADY_POLL_DELAY_MS);
    firstPoll = false;

    const [row] = await db
      .select({ status: viewpointRenders.status })
      .from(viewpointRenders)
      .where(eq(viewpointRenders.id, viewpointRenderId))
      .limit(1);
    if (!row || row.status === "cancelled") return;

    let everSawRendering = false;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      if (isTerminalJob(job)) continue;
      if (!job.mnmlJobId) continue;
      try {
        const status = await mnml.getRenderStatus(job.mnmlJobId);
        if (status.status === "rendering" && job.status !== "rendering") {
          everSawRendering = true;
        }
        if (status.status === "ready") {
          jobs[i] = {
            ...job,
            status: "ready",
            outputUrl: (status.outputUrls ?? [])[0] ?? "",
          };
        } else if (status.status === "failed") {
          jobs[i] = {
            ...job,
            status: "failed",
            error: { code: "mnml_failed", message: status.error?.message ?? "mnml render failed" },
          };
        } else if (status.status === "cancelled") {
          jobs[i] = { ...job, status: "failed", error: { code: "mnml_cancelled", message: "mnml reported cancelled" } };
        } else {
          jobs[i] = { ...job, status: status.status };
        }
      } catch (err) {
        if (err instanceof MnmlError) {
          // Transient — leave job state alone; retry next loop.
          logger.warn({ err, viewpointRenderId, jobMnmlId: job.mnmlJobId }, "mnml status poll failed for elevation-set job, will retry");
          continue;
        }
        throw err;
      }
    }

    if (everSawRendering) {
      await db
        .update(viewpointRenders)
        .set({ status: "rendering", mnmlJobs: jobs, updatedAt: new Date() })
        .where(and(eq(viewpointRenders.id, viewpointRenderId), eq(viewpointRenders.status, "queued")));
      await emitRenderEvent(viewpointRenderId, "viewpoint-render.rendering", {});
    } else {
      // Persist incremental jobs progress so the FE list endpoint
      // surfaces forward motion mid-poll.
      await db
        .update(viewpointRenders)
        .set({ mnmlJobs: jobs, updatedAt: new Date() })
        .where(eq(viewpointRenders.id, viewpointRenderId));
    }

    if (jobs.every(isTerminalJob)) {
      await finalizeElevationSet(viewpointRenderId, body, jobs);
      return;
    }
  }
}

function isTerminalJob(job: ElevationSetJob): boolean {
  return job.status === "ready" || job.status === "failed";
}

async function finalizeElevationSet(
  viewpointRenderId: string,
  _body: Extract<KickoffBody, { kind: "elevation-set" }>,
  jobs: ElevationSetJob[],
): Promise<void> {
  // Mirror successful jobs' outputs in parallel.
  const successful = jobs.filter((j) => j.status === "ready" && j.outputUrl);
  const mirrored = await Promise.all(
    successful.map(async (job) => {
      try {
        const m = await mirrorRenderOutput({
          outputUrl: job.outputUrl!,
          contentType: "image/png",
          renderId: viewpointRenderId,
          role: job.role,
        });
        return { job, mirror: m, error: null as Error | null };
      } catch (err) {
        return { job, mirror: null, error: err as Error };
      }
    }),
  );

  const outputs: NonNullable<Parameters<typeof persistTerminalState>[1]["outputs"]> = [];
  const failedDirections: string[] = [];

  for (const job of jobs) {
    if (job.status === "failed") {
      failedDirections.push(job.role);
      continue;
    }
    const mirrorResult = mirrored.find((m) => m.job.role === job.role);
    if (!mirrorResult || mirrorResult.error || !mirrorResult.mirror) {
      // Mirror itself failed for this direction — count as failure.
      failedDirections.push(job.role);
      continue;
    }
    outputs.push({
      role: job.role,
      format: "png",
      resolution: null,
      sizeBytes: mirrorResult.mirror.sizeBytes,
      durationSeconds: null,
      sourceUrl: job.outputUrl!,
      mirroredObjectKey: mirrorResult.mirror.mirroredObjectKey,
      thumbnailUrl: null,
      mnmlOutputId: null,
      seed: null,
    });
  }

  if (failedDirections.length > 0) {
    // Phase 1A approved: any-child-fail → parent fail. Partial
    // successes still mirror so the architect can re-trigger only
    // the failed direction(s).
    const allFailedFromCredits = jobs
      .filter((j) => j.status === "failed")
      .every((j) => j.error?.code === "insufficient_credits");
    const partialDebit =
      jobs.some((j) => j.status === "ready") &&
      jobs.some((j) => j.status === "failed" && j.error?.code === "insufficient_credits");
    const errorCode = partialDebit
      ? "insufficient_credits_partial"
      : allFailedFromCredits
        ? "insufficient_credits"
        : "elevation_set_partial";
    await persistTerminalState(viewpointRenderId, {
      status: "failed",
      errorCode,
      errorMessage: `${failedDirections.length}/${jobs.length} elevations failed`,
      errorDetails: { failedDirections },
      mnmlJobs: jobs,
      completedAt: new Date(),
      outputs,
    });
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", {
      errorCode,
      failedDirections,
    });
    return;
  }

  await persistTerminalState(viewpointRenderId, {
    status: "ready",
    completedAt: new Date(),
    mnmlJobs: jobs,
    outputs,
  });
  await emitRenderEvent(viewpointRenderId, "viewpoint-render.ready", {
    outputCount: outputs.length,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

/**
 * POST /api/engagements/:id/renders — kickoff. Synchronous up to row
 * insert + 202 response; the real work happens in the fire-and-forget
 * `runRenderPolling`.
 */
router.post("/engagements/:id/renders", async (req: Request, res: Response) => {
  if (requireArchitectAudience(req, res)) return;
  if (!rendersProdGateOpen()) {
    res.status(503).json({
      error: "renders_preview_disabled",
      message: "Renders are not yet enabled in production. Coming soon.",
    });
    return;
  }
  const params = EngagementIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_engagement_id" });
    return;
  }
  const body = KickoffBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "invalid_render_body", issues: body.error.issues });
    return;
  }

  const engagementId = params.data.id;
  const [eng] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!eng) {
    res.status(404).json({ error: "engagement_not_found" });
    return;
  }

  const [briefing] = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, engagementId))
    .limit(1);
  if (!briefing) {
    res.status(400).json({ error: "no_briefing_for_engagement" });
    return;
  }
  const [bimModel] = await db
    .select()
    .from(bimModels)
    .where(eq(bimModels.engagementId, engagementId))
    .limit(1);
  if (!bimModel) {
    res.status(400).json({ error: "no_bim_model_for_engagement" });
    return;
  }

  const snapshots = await snapshotUpstreamAtomEventIds(briefing.id, bimModel.id);
  const requestor = req.session.requestor;
  const requestedBy =
    requestor?.kind === "user" || requestor?.kind === "agent"
      ? `${requestor.kind}:${requestor.id}`
      : `${RENDER_SYSTEM_ACTOR.kind}:${RENDER_SYSTEM_ACTOR.id}`;

  let inserted: ViewpointRender;
  try {
    const rows = await db
      .insert(viewpointRenders)
      .values({
        engagementId,
        briefingId: briefing.id,
        bimModelId: bimModel.id,
        briefingAtomEventId: snapshots.briefingAtomEventId,
        bimModelAtomEventId: snapshots.bimModelAtomEventId,
        kind: body.data.kind,
        requestPayload: body.data,
        status: "queued",
        requestedBy,
      })
      .returning();
    inserted = rows[0]!;
  } catch (err) {
    logger.error({ err, engagementId }, "renders kickoff: insert failed");
    res.status(500).json({ error: "renders_insert_failed" });
    return;
  }

  // Fire-and-forget worker. The 202 returns immediately.
  void runRenderPolling({ viewpointRenderId: inserted.id, body: body.data });

  // Surface the kickoff cost on the response so the FE can render
  // a "Render: N credits" chip without a second round-trip. Spec 54
  // v2 §4 — static costs, no quote call to mnml. DA-RP-2 owns the
  // running-balance UI; V1-4 just exposes the per-kickoff figure.
  const cost = estimateRenderCost({ kind: inserted.kind as DomainRenderKind });
  res.status(202).json({
    renderId: inserted.id,
    state: "queued",
    kind: inserted.kind,
    cost,
  });
});

/**
 * GET /api/renders/:id — status + outputs. Architect-audience-only;
 * the FE polls this while the row is non-terminal.
 */
router.get("/renders/:id", async (req: Request, res: Response) => {
  if (requireArchitectAudience(req, res)) return;
  const params = RenderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_render_id" });
    return;
  }
  const [row] = await db
    .select()
    .from(viewpointRenders)
    .where(eq(viewpointRenders.id, params.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "render_not_found" });
    return;
  }
  const outs = await db
    .select()
    .from(renderOutputs)
    .where(eq(renderOutputs.viewpointRenderId, row.id));
  res.json({
    id: row.id,
    engagementId: row.engagementId,
    kind: row.kind,
    status: row.status,
    mnmlJobId: row.mnmlJobId,
    mnmlJobs: row.mnmlJobs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    errorDetails: row.errorDetails,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    outputs: outs.map((o) => ({
      id: o.id,
      role: o.role,
      format: o.format,
      resolution: o.resolution,
      sizeBytes: o.sizeBytes,
      durationSeconds: o.durationSeconds,
      mirroredObjectKey: o.mirroredObjectKey,
      thumbnailUrl: o.thumbnailUrl,
      seed: o.seed,
    })),
  });
});

/**
 * GET /api/engagements/:id/renders — list. Newest first. No
 * pagination in V1-4 (default ordering + a sensible cap is enough
 * for the architect's render-history UI).
 */
router.get("/engagements/:id/renders", async (req: Request, res: Response) => {
  if (requireArchitectAudience(req, res)) return;
  const params = EngagementIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_engagement_id" });
    return;
  }
  const rows = await db
    .select()
    .from(viewpointRenders)
    .where(eq(viewpointRenders.engagementId, params.data.id))
    .orderBy(desc(viewpointRenders.createdAt))
    .limit(100);
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      errorCode: row.errorCode,
      requestedBy: row.requestedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    })),
  });
});

/**
 * POST /api/renders/:id/cancel — server-side cancellation. mnml has
 * no public cancel API (Spec 54 v2 §6.1), so this is purely an
 * api-server concept: mark the row `cancelled`, the polling worker
 * checks status before each poll and bails. Outputs already mirrored
 * before cancellation persist — they're auditable artifacts of the
 * partial run.
 */
router.post("/renders/:id/cancel", async (req: Request, res: Response) => {
  if (requireArchitectAudience(req, res)) return;
  const params = RenderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_render_id" });
    return;
  }
  const [row] = await db
    .select()
    .from(viewpointRenders)
    .where(eq(viewpointRenders.id, params.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "render_not_found" });
    return;
  }
  if (row.status !== "queued" && row.status !== "rendering") {
    res.status(409).json({
      error: "render_not_cancellable",
      message: `render is in terminal state ${row.status}`,
    });
    return;
  }
  await db
    .update(viewpointRenders)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(viewpointRenders.id, row.id));
  await emitRenderEvent(row.id, "viewpoint-render.cancelled", {});
  res.json({ id: row.id, status: "cancelled" });
});

/**
 * POST /api/admin/renders/sweep — cron-invoked maintenance pass.
 *
 * Auth via the `x-renders-admin-secret` header (compared to
 * `RENDERS_ADMIN_SECRET` env var). Mirrors the snapshot ingest's
 * shared-secret pattern at `routes/snapshots.ts` because Cloud
 * Scheduler does not carry a session cookie. When the env var is
 * unset, the route returns 503 — that is, sweep-mode is opt-in per
 * environment.
 *
 * The handler invokes {@link runRendersSweep} once and returns the
 * three-bucket counts (rescuedStuck, reapedTerminal,
 * warnedIncompleteMirror) plus the wall-clock duration. No body
 * required. The cron schedule is configured outside the api-server
 * (Cloud Scheduler / Replit cron / k8s CronJob).
 */
router.post("/admin/renders/sweep", async (req: Request, res: Response) => {
  const expected = process.env["RENDERS_ADMIN_SECRET"];
  if (!expected) {
    res.status(503).json({
      error: "renders_sweep_disabled",
      message:
        "RENDERS_ADMIN_SECRET is not configured; sweep is disabled in this environment.",
    });
    return;
  }
  const provided = req.header("x-renders-admin-secret");
  if (provided !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const result = await runRendersSweep({ logger });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "renders sweep route: unexpected failure");
    res.status(500).json({ error: "renders_sweep_failed" });
  }
});

export default router;
