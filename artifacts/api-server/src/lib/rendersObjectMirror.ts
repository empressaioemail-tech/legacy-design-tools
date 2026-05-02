/**
 * V1-4 / DA-RP-1 — render output mirror pipeline.
 *
 * mnml.ai's `GET /v1/status/{id}` returns output URLs that point at
 * `api.mnmlai.dev/v1/images/...` (and `/v1/videos/...`). Spec 54 v2
 * §6.3 documents these as ephemeral; we mirror to our own object
 * storage on first observation of `success` so the render-output
 * row carries a durable reference. The route at `Step 6` invokes
 * this helper from its status-poll handler the moment a child
 * `mnml_jobs` entry transitions to `ready`.
 *
 * Surface (matches Phase 1B Step 5 contract):
 *
 *   mirrorRenderOutput({ outputUrl, contentType, renderId, role })
 *     → { mirroredUrl, mirroredObjectKey, sha256, sizeBytes,
 *         thumbnailUrl?, thumbnailObjectKey?, thumbnailSizeBytes? }
 *
 * The deterministic key scheme is
 * `renders/{renderId}/{role}-{sha256[:16]}.{ext}` so listing the
 * render-outputs for an engagement does not require a DB join: the
 * key carries enough structure to identify parent + role + content
 * fingerprint.
 *
 * Video kind handling: `contentType === "video/mp4"` triggers an
 * ffmpeg first-frame extraction (mnml does not return a thumbnail
 * — Spec 54 v2 §6.5). The extracted JPEG is uploaded alongside the
 * mp4 with the same key prefix and a `-thumb` suffix; the helper
 * returns both URLs so the route can insert two `render_outputs`
 * rows (`video-primary` for the mp4, `video-thumbnail` for the
 * JPEG) in the same transaction.
 *
 * Error mapping: throws {@link RenderMirrorError} with a coarse
 * code the route maps to `viewpoint_renders.error_code`:
 *   - `fetch_failed`     — mnml CDN unreachable / 4xx / 5xx
 *   - `upload_failed`    — GCS save threw or returned non-OK
 *   - `thumbnail_failed` — ffmpeg first-frame extraction threw
 *
 * Test boundary: GCS upload + fluent-ffmpeg are pluggable via
 * the `uploader` and `thumbnailer` injection points; tests pass
 * stubs and never touch the real filesystem / GCS / ffmpeg binary.
 * Production paths use the defaults that wrap @google-cloud/storage
 * and ffmpeg-static.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { objectStorageClient } from "./objectStorage";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface MirrorRenderOutputInput {
  /** mnml's ephemeral CDN URL. The helper fetches the bytes verbatim. */
  outputUrl: string;
  /**
   * Content type the upload should advertise. Drives the file
   * extension in the object key (so a mirrored mp4 stays addressable
   * by "looks like a video file" tooling) AND the thumbnail branch
   * (anything starting with `video/` triggers ffmpeg).
   */
  contentType: string;
  /** Parent `viewpoint_renders.id` — the first path segment of the GCS key. */
  renderId: string;
  /**
   * `render_outputs.role` value: `primary` | `elevation-{n,e,s,w}` |
   * `video-primary` | `video-thumbnail`. Used in the GCS key suffix
   * so each role lives at a stable address per parent render.
   */
  role: string;
  /** Test-injectable fetch. Defaults to `globalThis.fetch`. */
  fetcher?: typeof fetch;
  /** Test-injectable uploader. Defaults to a real-GCS implementation. */
  uploader?: ObjectUploader;
  /** Test-injectable thumbnail extractor. Defaults to ffmpeg-static + fluent-ffmpeg. */
  thumbnailer?: VideoThumbnailer;
}

export interface MirrorRenderOutputResult {
  /**
   * Canonical reference to the mirrored asset, in `gs://<bucket>/<key>`
   * form. The route persists the key portion in
   * `render_outputs.mirrored_object_key`; the route's serve path
   * mints signed HTTPS URLs from the key when the FE asks.
   */
  mirroredUrl: string;
  /** Just the object key portion — convenience so callers don't re-parse. */
  mirroredObjectKey: string;
  /** Hex-encoded SHA-256 of the mirrored bytes. */
  sha256: string;
  /** Byte count of the mirrored asset. */
  sizeBytes: number;
  /** Set when contentType started with `video/`. */
  thumbnailUrl?: string;
  thumbnailObjectKey?: string;
  thumbnailSizeBytes?: number;
}

export type RenderMirrorErrorCode =
  | "fetch_failed"
  | "upload_failed"
  | "thumbnail_failed";

export class RenderMirrorError extends Error {
  constructor(
    public readonly code: RenderMirrorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RenderMirrorError";
    Object.setPrototypeOf(this, RenderMirrorError.prototype);
  }
}

/**
 * Pluggable upload surface. Production wraps GCS via
 * {@link defaultGcsUploader}; tests inject a recording stub.
 */
export interface ObjectUploader {
  /** Upload `bytes` to the given key with the given contentType. Returns the bucket name actually used. */
  upload(args: {
    objectKey: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<{ bucketName: string }>;
}

/**
 * Pluggable video-frame extractor. Production wraps fluent-ffmpeg +
 * ffmpeg-static via {@link defaultFfmpegThumbnailer}; tests inject a
 * stub that returns a fixed JPEG buffer (or throws).
 */
export interface VideoThumbnailer {
  /** Extract frame 0 of the given video bytes as a JPEG buffer. */
  extractFirstFrameJpeg(videoBytes: Buffer): Promise<Buffer>;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

export async function mirrorRenderOutput(
  input: MirrorRenderOutputInput,
): Promise<MirrorRenderOutputResult> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const uploader = input.uploader ?? defaultGcsUploader;
  const thumbnailer = input.thumbnailer ?? defaultFfmpegThumbnailer;

  // 1. Fetch the bytes verbatim from mnml's CDN.
  let bodyBuffer: Buffer;
  try {
    const response = await fetcher(input.outputUrl);
    if (!response.ok) {
      throw new RenderMirrorError(
        "fetch_failed",
        `mnml CDN returned ${response.status} for ${input.outputUrl}`,
      );
    }
    bodyBuffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof RenderMirrorError) throw err;
    throw new RenderMirrorError(
      "fetch_failed",
      `mnml CDN fetch threw: ${(err as Error).message}`,
    );
  }

  // 2. Hash + size derive deterministically off the bytes.
  const sha256 = createHash("sha256").update(bodyBuffer).digest("hex");
  const sizeBytes = bodyBuffer.byteLength;
  const ext = extensionForContentType(input.contentType);
  const objectKey = buildObjectKey({
    renderId: input.renderId,
    role: input.role,
    sha256,
    ext,
  });

  // 3. Upload main asset.
  let mainBucket: string;
  try {
    const result = await uploader.upload({
      objectKey,
      bytes: bodyBuffer,
      contentType: input.contentType,
    });
    mainBucket = result.bucketName;
  } catch (err) {
    if (err instanceof RenderMirrorError) throw err;
    throw new RenderMirrorError(
      "upload_failed",
      `GCS upload threw for ${objectKey}: ${(err as Error).message}`,
    );
  }

  const mainResult: MirrorRenderOutputResult = {
    mirroredUrl: `gs://${mainBucket}/${objectKey}`,
    mirroredObjectKey: objectKey,
    sha256,
    sizeBytes,
  };

  // 4. Thumbnail branch. Anything advertised as `video/*` triggers
  //    ffmpeg first-frame extraction — `video/mp4` and `video/webm`
  //    both qualify since either could come back from a future mnml
  //    update.
  if (input.contentType.startsWith("video/")) {
    let thumbBytes: Buffer;
    try {
      thumbBytes = await thumbnailer.extractFirstFrameJpeg(bodyBuffer);
    } catch (err) {
      throw new RenderMirrorError(
        "thumbnail_failed",
        `ffmpeg first-frame extraction failed: ${(err as Error).message}`,
      );
    }

    const thumbHash = createHash("sha256").update(thumbBytes).digest("hex");
    const thumbKey = buildObjectKey({
      renderId: input.renderId,
      role: `${input.role}-thumb`,
      sha256: thumbHash,
      ext: "jpg",
    });

    let thumbBucket: string;
    try {
      const result = await uploader.upload({
        objectKey: thumbKey,
        bytes: thumbBytes,
        contentType: "image/jpeg",
      });
      thumbBucket = result.bucketName;
    } catch (err) {
      throw new RenderMirrorError(
        "upload_failed",
        `GCS upload threw for thumbnail ${thumbKey}: ${(err as Error).message}`,
      );
    }

    return {
      ...mainResult,
      thumbnailUrl: `gs://${thumbBucket}/${thumbKey}`,
      thumbnailObjectKey: thumbKey,
      thumbnailSizeBytes: thumbBytes.byteLength,
    };
  }

  return mainResult;
}

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Map content type → file extension. Pure function. Returns `bin`
 * for unknown content types (rather than throwing) — the upload
 * still succeeds; a unknown extension is observable in logs but
 * doesn't break the pipeline.
 */
export function extensionForContentType(ct: string): string {
  const c = ct.toLowerCase();
  if (c.startsWith("image/png")) return "png";
  if (c.startsWith("image/jpeg") || c.startsWith("image/jpg")) return "jpg";
  if (c.startsWith("image/webp")) return "webp";
  if (c.startsWith("video/mp4")) return "mp4";
  if (c.startsWith("video/webm")) return "webm";
  return "bin";
}

/**
 * Build the deterministic GCS key. Pure function. The first 16 hex
 * chars of sha256 (64 bits of entropy) are sufficient to disambiguate
 * outputs for a given (renderId, role) pair — collision probability
 * is negligible at the volume V1-4 supports.
 */
export function buildObjectKey(args: {
  renderId: string;
  role: string;
  sha256: string;
  ext: string;
}): string {
  return `renders/${args.renderId}/${args.role}-${args.sha256.slice(0, 16)}.${args.ext}`;
}

/**
 * Resolve the bucket name from the `PRIVATE_OBJECT_DIR` env var.
 * Format: `/<bucket>/<prefix>...`. Pure modulo env. Exported for
 * unit tests.
 */
export function resolveRenderBucketName(): string {
  const dir = process.env["PRIVATE_OBJECT_DIR"];
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. Mirroring requires the same private bucket the rest of the api-server writes to.",
    );
  }
  // Strip leading slash(es) then take the first path segment.
  const parts = dir.replace(/^\/+/, "").split("/");
  if (!parts[0]) {
    throw new Error(
      `PRIVATE_OBJECT_DIR is malformed: "${dir}". Expected "/<bucket>/<prefix>".`,
    );
  }
  return parts[0];
}

// ─────────────────────────────────────────────────────────────────────
// Default uploader (production: GCS via @google-cloud/storage)
// ─────────────────────────────────────────────────────────────────────

const defaultGcsUploader: ObjectUploader = {
  async upload({ objectKey, bytes, contentType }) {
    const bucketName = resolveRenderBucketName();
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectKey);
    await file.save(bytes, {
      contentType,
      // Single-shot upload — render assets are small enough (1-3MB
      // archdiff PNG, ≤50MB Kling video) that resumable adds round-
      // trips without buying anything. If we ever need to resume on
      // a multi-GB asset, flip this then.
      resumable: false,
    });
    return { bucketName };
  },
};

// ─────────────────────────────────────────────────────────────────────
// Default thumbnailer (production: ffmpeg-static + fluent-ffmpeg)
// ─────────────────────────────────────────────────────────────────────

// Wire the bundled binary path into fluent-ffmpeg at module load.
// `ffmpeg-static` exports the path as the default export when its
// install postinstall has run (it pulls a per-platform binary into
// the package dir). On platforms where the binary isn't available,
// the import returns `null`; we fall back to whatever `ffmpeg` is on
// PATH and surface a clear error if neither resolves at runtime.
if (typeof ffmpegPath === "string") {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const defaultFfmpegThumbnailer: VideoThumbnailer = {
  async extractFirstFrameJpeg(videoBytes) {
    // fluent-ffmpeg's `-i pipe:0` works with stdin streams, but
    // input duration probing and the `-ss 0` seek both behave more
    // predictably with a real file. Render videos are ≤50MB so the
    // tmp-write cost is negligible (~50ms on a SATA SSD) compared
    // to the ffmpeg invocation itself (~200ms cold start).
    const tmpDir = await fs.mkdtemp(path.join(tmpdir(), "render-thumb-"));
    const inFile = path.join(tmpDir, "input.mp4");
    const outFile = path.join(tmpDir, "thumb.jpg");
    try {
      await fs.writeFile(inFile, videoBytes);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inFile)
          .seek(0)
          .frames(1)
          .output(outFile)
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });
      return await fs.readFile(outFile);
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Tmp cleanup is best-effort; OS reaps tmpdir periodically.
      }
    }
  },
};
