/**
 * doc 40e A.2 — mnml.ai power-tool routes.
 *
 * Five POST endpoints, each parent-scoped under an existing
 * `render_outputs` row:
 *   POST /api/render-outputs/:parentId/enhance
 *   POST /api/render-outputs/:parentId/upscale
 *   POST /api/render-outputs/:parentId/erase
 *   POST /api/render-outputs/:parentId/inpaint
 *   POST /api/render-outputs/:parentId/style-transfer
 *
 * Each accepts multipart (Busboy — mirrors the prompt-generator route
 * in `renders.ts`), calls the corresponding {@link MnmlClient} power-
 * tool method, inserts a `viewpoint_renders` row (`kind='still'`,
 * `source_type=<tool>`, `parent_render_output_id=<parent>`), and fires
 * a fire-and-forget polling worker that mirrors the output with role
 * `primary` (tool-specific roles land in A.6).
 *
 * Production gate: same `RENDERS_PROD_ENABLED` flag as `renders.ts`.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import Busboy from "busboy";
import {
  db,
  renderOutputs,
  viewpointRenders,
  type ViewpointRender,
} from "@workspace/db";
import {
  estimatePowerToolCost,
  getMnmlClient,
  MnmlError,
  type AiEraserRequest,
  type InpaintRequest,
  type PowerToolSourceType,
  type RenderEnhancerRequest,
  type StyleTransferRequest,
  type UpscaleRequest,
} from "@workspace/mnml-client";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  mirrorRenderOutput,
  RenderMirrorError,
} from "../lib/rendersObjectMirror";

// ─────────────────────────────────────────────────────────────────────
// Constants (mirrors renders.ts polling cadence)
// ─────────────────────────────────────────────────────────────────────

const FIRST_POLL_DELAY_MS = 3_000;
const STEADY_POLL_DELAY_MS = 5_000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;

const MAX_ENHANCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPSCALE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ERASE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INPAINT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_STYLE_TRANSFER_IMAGE_BYTES = 10 * 1024 * 1024;

const RENDER_SYSTEM_ACTOR: { kind: "system"; id: string } = {
  kind: "system",
  id: "render-tools",
};

const ParentIdParamsSchema = z.object({
  parentId: z.string().uuid(),
});

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

function rendersProdGateOpen(): boolean {
  if (process.env["NODE_ENV"] !== "production") return true;
  return process.env["RENDERS_PROD_ENABLED"] === "true";
}

// ─────────────────────────────────────────────────────────────────────
// Multipart parsing
// ─────────────────────────────────────────────────────────────────────

interface FilePart {
  name: string;
  bytes: Buffer;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: FilePart[];
}

type MultipartLimits = {
  maxImageBytes: number;
  maxSecondFileBytes?: number;
  maxFiles: number;
  maxFields: number;
};

function consumeMultipartUpload(
  req: Request,
  limits: MultipartLimits,
  allowedFileNames: ReadonlySet<string>,
): Promise<
  | { ok: true; parsed: ParsedMultipart }
  | { ok: false; status: number; error: string }
> {
  return new Promise((resolve) => {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: Math.max(
            limits.maxImageBytes,
            limits.maxSecondFileBytes ?? limits.maxImageBytes,
          ),
          files: limits.maxFiles,
          fields: limits.maxFields,
        },
      });
    } catch (err) {
      logger.warn({ err }, "render-tools upload: busboy init failed");
      resolve({ ok: false, status: 400, error: "invalid_multipart" });
      return;
    }

    const fields: Record<string, string> = {};
    const files: FilePart[] = [];
    const fileByteCounts = new Map<string, number>();
    const fileTruncated = new Set<string>();
    let aborted = false;

    function abort(status: number, error: string) {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe(busboy);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, status, error });
    }

    busboy.on("field", (name: string, value: string) => {
      if (aborted) return;
      fields[name] = value;
    });

    busboy.on("file", (name: string, stream: NodeJS.ReadableStream) => {
      if (aborted) return;
      if (!allowedFileNames.has(name)) {
        stream.resume();
        return;
      }
      const maxBytes =
        name === "image"
          ? limits.maxImageBytes
          : (limits.maxSecondFileBytes ?? limits.maxImageBytes);
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          fileTruncated.add(name);
          return;
        }
        chunks.push(chunk);
      });
      stream.on("limit", () => {
        fileTruncated.add(name);
      });
      stream.on("end", () => {
        if (!fileTruncated.has(name) && bytes > 0) {
          files.push({ name, bytes: Buffer.concat(chunks, bytes) });
          fileByteCounts.set(name, bytes);
        }
      });
      stream.on("error", (err) => {
        logger.warn({ err, file: name }, "render-tools upload: file stream error");
      });
    });

    busboy.on("error", (err) => {
      logger.warn({ err }, "render-tools upload: busboy error");
      abort(400, "multipart_parse_failed");
    });

    busboy.on("finish", () => {
      if (aborted) return;
      for (const name of fileTruncated) {
        if (name === "image") {
          abort(413, "image_too_large");
          return;
        }
        if (name === "mask") {
          abort(413, "mask_too_large");
          return;
        }
        if (name === "reference_image") {
          abort(413, "reference_image_too_large");
          return;
        }
      }
      resolve({ ok: true, parsed: { fields, files } });
    });

    req.pipe(busboy);
  });
}

function requireFile(
  parsed: ParsedMultipart,
  name: string,
): Buffer | null {
  return parsed.files.find((f) => f.name === name)?.bytes ?? null;
}

function parseOptionalFloat(
  fields: Record<string, string>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = fields[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function parseOptionalInt(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function parseOptionalBool(fields: Record<string, string>, key: string): boolean | undefined {
  const raw = fields[key]?.toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
// DB + events
// ─────────────────────────────────────────────────────────────────────

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
      "render-tools event emission failed",
    );
  }
}

async function persistTerminalState(
  viewpointRenderId: string,
  patch: {
    status: "ready" | "failed" | "cancelled";
    errorCode?: string | null;
    errorMessage?: string | null;
    errorDetails?: Record<string, unknown> | null;
    completedAt?: Date;
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
        updatedAt: new Date(),
      })
      .where(eq(viewpointRenders.id, viewpointRenderId))
      .returning();
    return row!;
  });
}

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
    case "transport":
      return "unavailable";
  }
}

function mnmlErrorToHttpStatus(err: MnmlError): number {
  switch (err.kind) {
    case "validation":
      return 400;
    case "auth":
    case "not_found":
      return 502;
    case "insufficient_credits":
      return 402;
    case "rate_limited":
    case "unavailable":
    case "transport":
      return 503;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────
// Polling worker
// ─────────────────────────────────────────────────────────────────────

export type ToolTriggerInput =
  | { tool: "enhance"; request: RenderEnhancerRequest }
  | { tool: "upscale"; request: UpscaleRequest }
  | { tool: "erase"; request: AiEraserRequest }
  | { tool: "inpaint"; request: InpaintRequest }
  | { tool: "style_transfer"; request: StyleTransferRequest };

/**
 * Trigger the mnml power tool, poll to terminal, mirror with role
 * `primary`. Fire-and-forget from the route handler.
 */
export async function runToolPolling(args: {
  viewpointRenderId: string;
  sourceType: PowerToolSourceType;
  trigger: ToolTriggerInput;
}): Promise<void> {
  const { viewpointRenderId, sourceType, trigger } = args;
  const mnml = getMnmlClient();

  try {
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.requested", {
      sourceType,
      tool: trigger.tool,
    });

    let renderId: string;
    try {
      const result = await (async () => {
        switch (trigger.tool) {
          case "enhance":
            return mnml.enhance(trigger.request);
          case "upscale":
            return mnml.upscale(trigger.request);
          case "erase":
            return mnml.aiErase(trigger.request);
          case "inpaint":
            return mnml.inpaint(trigger.request);
          case "style_transfer":
            return mnml.styleTransfer(trigger.request);
        }
      })();
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
        await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", {
          errorCode: code,
        });
        return;
      }
      throw err;
    }

    await db
      .update(viewpointRenders)
      .set({ mnmlJobId: renderId, status: "queued", updatedAt: new Date() })
      .where(eq(viewpointRenders.id, viewpointRenderId));
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.queued", {
      mnmlJobId: renderId,
    });

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
        await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", {
          errorCode: "polling_timeout",
        });
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

      let status;
      try {
        status = await mnml.getRenderStatus(renderId);
      } catch (err) {
        if (err instanceof MnmlError) {
          logger.warn(
            { err, viewpointRenderId, renderId },
            "render-tools status poll failed, will retry",
          );
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
        await finalizeToolReady(
          viewpointRenderId,
          renderId,
          status.outputUrls ?? [],
          status.seed,
        );
        return;
      }
      if (status.status === "failed") {
        const code = "mnml_failed";
        await persistTerminalState(viewpointRenderId, {
          status: "failed",
          errorCode: code,
          errorMessage: status.error?.message ?? "mnml render failed",
        });
        await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", {
          errorCode: code,
        });
        return;
      }
      if (status.status === "cancelled") {
        await persistTerminalState(viewpointRenderId, { status: "cancelled" });
        return;
      }
    }
  } catch (err) {
    logger.error(
      { err, viewpointRenderId },
      "runToolPolling crashed unexpectedly — persisting generic failure",
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
      /* nothing left */
    }
  }
}

async function finalizeToolReady(
  viewpointRenderId: string,
  mnmlRenderId: string,
  outputUrls: string[],
  seed?: number,
): Promise<void> {
  if (outputUrls.length === 0) {
    await persistTerminalState(viewpointRenderId, {
      status: "failed",
      errorCode: "mnml_empty_outputs",
      errorMessage: "mnml status=success but message[] was empty",
    });
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.failed", {
      errorCode: "mnml_empty_outputs",
    });
    return;
  }
  if (outputUrls.length > 1) {
    await emitRenderEvent(viewpointRenderId, "viewpoint-render.unexpected-output-shape", {
      outputCount: outputUrls.length,
      mnmlRenderId,
    });
  }

  const primaryUrl = outputUrls[0]!;
  let mirror;
  try {
    mirror = await mirrorRenderOutput({
      outputUrl: primaryUrl,
      contentType: "image/png",
      renderId: viewpointRenderId,
      role: "primary",
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

  await persistTerminalState(viewpointRenderId, {
    status: "ready",
    completedAt: new Date(),
    outputs: [
      {
        role: "primary",
        format: "png",
        resolution: null,
        sizeBytes: mirror.sizeBytes,
        durationSeconds: null,
        sourceUrl: primaryUrl,
        mirroredObjectKey: mirror.mirroredObjectKey,
        thumbnailUrl: null,
        mnmlOutputId: null,
        seed: seed ?? null,
      },
    ],
  });
  await emitRenderEvent(viewpointRenderId, "viewpoint-render.ready", {
    mnmlRenderId,
    outputCount: 1,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Parent resolution
// ─────────────────────────────────────────────────────────────────────

async function loadParentRenderOutput(parentId: string) {
  const [row] = await db
    .select({
      output: renderOutputs,
      render: viewpointRenders,
    })
    .from(renderOutputs)
    .innerJoin(
      viewpointRenders,
      eq(renderOutputs.viewpointRenderId, viewpointRenders.id),
    )
    .where(eq(renderOutputs.id, parentId))
    .limit(1);
  return row ?? null;
}

async function kickoffToolRoute(
  req: Request,
  res: Response,
  sourceType: PowerToolSourceType,
  buildTrigger: (
    parsed: ParsedMultipart,
  ) =>
    | { ok: true; trigger: ToolTriggerInput; requestPayload: Record<string, unknown> }
    | { ok: false; status: number; error: string },
): Promise<void> {
  if (!rendersProdGateOpen()) {
    res.status(503).json({
      error: "renders_preview_disabled",
      message: "Renders are not yet enabled in production. Coming soon.",
    });
    return;
  }

  const params = ParentIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_parent_render_output_id" });
    return;
  }

  const parent = await loadParentRenderOutput(params.data.parentId);
  if (!parent) {
    res.status(404).json({ error: "parent_render_output_not_found" });
    return;
  }
  if (parent.render.status !== "ready") {
    res.status(400).json({ error: "parent_render_not_ready" });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    res.status(415).json({ error: "expected_multipart" });
    return;
  }

  const limits = limitsForTool(sourceType);
  const upload = await consumeMultipartUpload(
    req,
    limits,
    allowedFilesForTool(sourceType),
  );
  if (!upload.ok) {
    res.status(upload.status).json({ error: upload.error });
    return;
  }

  const built = buildTrigger(upload.parsed);
  if (!built.ok) {
    res.status(built.status).json({ error: built.error });
    return;
  }

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
        engagementId: parent.render.engagementId,
        briefingId: parent.render.briefingId,
        bimModelId: parent.render.bimModelId,
        briefingAtomEventId: parent.render.briefingAtomEventId,
        bimModelAtomEventId: parent.render.bimModelAtomEventId,
        kind: "still",
        sourceType,
        parentRenderOutputId: params.data.parentId,
        requestPayload: built.requestPayload,
        status: "queued",
        requestedBy,
      })
      .returning();
    inserted = rows[0]!;
  } catch (err) {
    logger.error({ err, parentId: params.data.parentId }, "render-tools kickoff: insert failed");
    res.status(500).json({ error: "render_tools_insert_failed" });
    return;
  }

  void runToolPolling({
    viewpointRenderId: inserted.id,
    sourceType,
    trigger: built.trigger,
  });

  const cost = estimatePowerToolCost({ tool: sourceType });
  res.status(202).json({
    renderId: inserted.id,
    state: "queued",
    kind: "still",
    sourceType,
    parentRenderOutputId: params.data.parentId,
    cost,
  });
}

function limitsForTool(tool: PowerToolSourceType): MultipartLimits {
  switch (tool) {
    case "enhance":
      return {
        maxImageBytes: MAX_ENHANCE_IMAGE_BYTES,
        maxFiles: 1,
        maxFields: 12,
      };
    case "upscale":
      return {
        maxImageBytes: MAX_UPSCALE_IMAGE_BYTES,
        maxFiles: 1,
        maxFields: 8,
      };
    case "erase":
      return {
        maxImageBytes: MAX_ERASE_IMAGE_BYTES,
        maxSecondFileBytes: MAX_ERASE_IMAGE_BYTES,
        maxFiles: 2,
        maxFields: 8,
      };
    case "inpaint":
      return {
        maxImageBytes: MAX_INPAINT_IMAGE_BYTES,
        maxSecondFileBytes: MAX_INPAINT_IMAGE_BYTES,
        maxFiles: 2,
        maxFields: 12,
      };
    case "style_transfer":
      return {
        maxImageBytes: MAX_STYLE_TRANSFER_IMAGE_BYTES,
        maxSecondFileBytes: MAX_STYLE_TRANSFER_IMAGE_BYTES,
        maxFiles: 2,
        maxFields: 12,
      };
  }
}

function allowedFilesForTool(tool: PowerToolSourceType): ReadonlySet<string> {
  switch (tool) {
    case "enhance":
    case "upscale":
      return new Set(["image"]);
    case "erase":
    case "inpaint":
      return new Set(["image", "mask"]);
    case "style_transfer":
      return new Set(["image", "reference_image"]);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

router.post("/render-outputs/:parentId/enhance", async (req, res) => {
  await kickoffToolRoute(req, res, "enhance", (parsed) => {
    const image = requireFile(parsed, "image");
    if (!image) return { ok: false, status: 400, error: "missing_image_part" };
    const prompt = parsed.fields["prompt"]?.trim();
    if (!prompt) return { ok: false, status: 400, error: "missing_prompt" };
    const geometry = parseOptionalFloat(parsed.fields, "geometry", 0, 1);
    const creativity = parseOptionalFloat(parsed.fields, "creativity", 0, 1);
    const dynamic = parseOptionalFloat(parsed.fields, "dynamic", 0, 10);
    const seed = parseOptionalInt(parsed.fields, "seed");
    const sharpen = parseOptionalFloat(parsed.fields, "sharpen", 0, 1);
    const request: RenderEnhancerRequest = {
      image,
      prompt,
      ...(geometry !== undefined ? { geometry } : {}),
      ...(creativity !== undefined ? { creativity } : {}),
      ...(dynamic !== undefined ? { dynamic } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(sharpen !== undefined ? { sharpen } : {}),
    };
    return {
      ok: true,
      trigger: { tool: "enhance", request },
      requestPayload: { tool: "enhance", prompt, fields: parsed.fields },
    };
  });
});

router.post("/render-outputs/:parentId/upscale", async (req, res) => {
  await kickoffToolRoute(req, res, "upscale", (parsed) => {
    const image = requireFile(parsed, "image");
    if (!image) return { ok: false, status: 400, error: "missing_image_part" };
    const scaleRaw = parsed.fields["scale"];
    const scale =
      scaleRaw === "2" || scaleRaw === "4" || scaleRaw === "8"
        ? (Number(scaleRaw) as 2 | 4 | 8)
        : undefined;
    const request: UpscaleRequest = {
      image,
      ...(scale !== undefined ? { scale } : {}),
      ...(parseOptionalBool(parsed.fields, "face_enhance") !== undefined
        ? { faceEnhance: parseOptionalBool(parsed.fields, "face_enhance") }
        : {}),
    };
    return {
      ok: true,
      trigger: { tool: "upscale", request },
      requestPayload: { tool: "upscale", fields: parsed.fields },
    };
  });
});

router.post("/render-outputs/:parentId/erase", async (req, res) => {
  await kickoffToolRoute(req, res, "erase", (parsed) => {
    const image = requireFile(parsed, "image");
    const mask = requireFile(parsed, "mask");
    if (!image) return { ok: false, status: 400, error: "missing_image_part" };
    if (!mask) return { ok: false, status: 400, error: "missing_mask_part" };
    const outputFormat = parsed.fields["output_format"];
    const request: AiEraserRequest = {
      image,
      mask,
      ...(outputFormat === "png" ||
      outputFormat === "jpg" ||
      outputFormat === "jpeg"
        ? { outputFormat }
        : {}),
    };
    return {
      ok: true,
      trigger: { tool: "erase", request },
      requestPayload: { tool: "erase", fields: parsed.fields },
    };
  });
});

router.post("/render-outputs/:parentId/inpaint", async (req, res) => {
  await kickoffToolRoute(req, res, "inpaint", (parsed) => {
    const image = requireFile(parsed, "image");
    const mask = requireFile(parsed, "mask");
    if (!image) return { ok: false, status: 400, error: "missing_image_part" };
    if (!mask) return { ok: false, status: 400, error: "missing_mask_part" };
    const maskType = parsed.fields["mask_type"];
    const request: InpaintRequest = {
      image,
      mask,
      ...(parsed.fields["prompt"] !== undefined ? { prompt: parsed.fields["prompt"] } : {}),
      ...(parsed.fields["negative_prompt"] !== undefined
        ? { negativePrompt: parsed.fields["negative_prompt"] }
        : {}),
      ...(parseOptionalInt(parsed.fields, "seed") !== undefined
        ? { seed: parseOptionalInt(parsed.fields, "seed") }
        : {}),
      ...(maskType === "manual" || maskType === "automatic"
        ? { maskType }
        : {}),
    };
    return {
      ok: true,
      trigger: { tool: "inpaint", request },
      requestPayload: { tool: "inpaint", fields: parsed.fields },
    };
  });
});

router.post("/render-outputs/:parentId/style-transfer", async (req, res) => {
  await kickoffToolRoute(req, res, "style_transfer", (parsed) => {
    const image = requireFile(parsed, "image");
    const referenceImage = requireFile(parsed, "reference_image");
    if (!image) return { ok: false, status: 400, error: "missing_image_part" };
    if (!referenceImage) {
      return { ok: false, status: 400, error: "missing_reference_image_part" };
    }
    const request: StyleTransferRequest = {
      image,
      referenceImage,
      ...(parsed.fields["prompt"] !== undefined ? { prompt: parsed.fields["prompt"] } : {}),
      ...(parseOptionalFloat(parsed.fields, "strength", 0, 1) !== undefined
        ? { strength: parseOptionalFloat(parsed.fields, "strength", 0, 1) }
        : {}),
      ...(parseOptionalBool(parsed.fields, "preserve_structure") !== undefined
        ? { preserveStructure: parseOptionalBool(parsed.fields, "preserve_structure") }
        : {}),
      ...(parseOptionalFloat(parsed.fields, "color_preservation", 0, 1) !== undefined
        ? {
            colorPreservation: parseOptionalFloat(
              parsed.fields,
              "color_preservation",
              0,
              1,
            ),
          }
        : {}),
    };
    return {
      ok: true,
      trigger: { tool: "style_transfer", request },
      requestPayload: { tool: "style_transfer", fields: parsed.fields },
    };
  });
});

export default router;
