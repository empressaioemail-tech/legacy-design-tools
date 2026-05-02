/**
 * Unit tests for {@link mirrorRenderOutput}.
 *
 * Both injection points (`uploader`, `thumbnailer`) are stubbed —
 * no real GCS, no real ffmpeg. The fetcher is also injected so no
 * real network. Tests cover:
 *   - Happy path image: fetch → hash → upload, no thumbnail branch
 *   - Happy path video/mp4: fetch → hash → upload main → ffmpeg →
 *     upload thumbnail
 *   - extensionForContentType + buildObjectKey + resolveRenderBucketName
 *     pure-function coverage
 *   - All three RenderMirrorError buckets (fetch_failed, upload_failed,
 *     thumbnail_failed)
 *   - SHA256 + sizeBytes match the response bytes
 *   - Object key shape: `renders/{renderId}/{role}-{sha[:16]}.{ext}`
 *   - Deterministic key derivation: identical inputs → identical key
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  buildObjectKey,
  extensionForContentType,
  mirrorRenderOutput,
  RenderMirrorError,
  resolveRenderBucketName,
  type ObjectUploader,
  type VideoThumbnailer,
} from "../lib/rendersObjectMirror";

// Sample bytes — 64 bytes of repeated 0x42, easy to fingerprint.
const PNG_BYTES = Buffer.from(Array(64).fill(0x42));
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");

const MP4_BYTES = Buffer.from(Array(128).fill(0x4d));
const MP4_SHA = createHash("sha256").update(MP4_BYTES).digest("hex");

const THUMB_BYTES = Buffer.from(Array(32).fill(0x4a));
const THUMB_SHA = createHash("sha256").update(THUMB_BYTES).digest("hex");

function makeFetcher(buffer: Buffer, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      // ArrayBufferLike → ArrayBuffer (slice copies into a fresh
      // backing buffer that doesn't alias other Buffer instances).
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
  })) as unknown as typeof fetch;
}

function makeUploader(bucketName = "test-bucket"): {
  uploader: ObjectUploader;
  uploads: Array<{ objectKey: string; bytes: Buffer; contentType: string }>;
} {
  const uploads: Array<{ objectKey: string; bytes: Buffer; contentType: string }> = [];
  const uploader: ObjectUploader = {
    async upload(args) {
      uploads.push(args);
      return { bucketName };
    },
  };
  return { uploader, uploads };
}

function makeThumbnailer(out: Buffer = THUMB_BYTES): {
  thumbnailer: VideoThumbnailer;
  calls: Array<Buffer>;
} {
  const calls: Array<Buffer> = [];
  const thumbnailer: VideoThumbnailer = {
    async extractFirstFrameJpeg(videoBytes) {
      calls.push(videoBytes);
      return out;
    },
  };
  return { thumbnailer, calls };
}

let envSnapshot: string | undefined;
beforeEach(() => {
  envSnapshot = process.env["PRIVATE_OBJECT_DIR"];
  process.env["PRIVATE_OBJECT_DIR"] = "/test-bucket/private";
});
afterEach(() => {
  if (envSnapshot === undefined) delete process.env["PRIVATE_OBJECT_DIR"];
  else process.env["PRIVATE_OBJECT_DIR"] = envSnapshot;
});

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

describe("extensionForContentType", () => {
  it("maps known image content types", () => {
    expect(extensionForContentType("image/png")).toBe("png");
    expect(extensionForContentType("image/jpeg")).toBe("jpg");
    expect(extensionForContentType("image/jpg")).toBe("jpg");
    expect(extensionForContentType("image/webp")).toBe("webp");
  });
  it("maps known video content types", () => {
    expect(extensionForContentType("video/mp4")).toBe("mp4");
    expect(extensionForContentType("video/webm")).toBe("webm");
  });
  it("is case-insensitive", () => {
    expect(extensionForContentType("Image/PNG")).toBe("png");
  });
  it("falls back to bin for unknown content types", () => {
    expect(extensionForContentType("application/octet-stream")).toBe("bin");
  });
});

describe("buildObjectKey", () => {
  it("uses the renders/{renderId}/{role}-{sha[:16]}.{ext} shape", () => {
    expect(
      buildObjectKey({
        renderId: "rnd-abc",
        role: "primary",
        sha256: "a".repeat(64),
        ext: "png",
      }),
    ).toBe(`renders/rnd-abc/primary-${"a".repeat(16)}.png`);
  });
  it("is deterministic — identical inputs yield identical keys", () => {
    const args = {
      renderId: "x",
      role: "elevation-n",
      sha256: PNG_SHA,
      ext: "png",
    };
    expect(buildObjectKey(args)).toBe(buildObjectKey(args));
  });
});

describe("resolveRenderBucketName", () => {
  it("extracts the first path segment of PRIVATE_OBJECT_DIR", () => {
    process.env["PRIVATE_OBJECT_DIR"] = "/abc-bucket/private/nested";
    expect(resolveRenderBucketName()).toBe("abc-bucket");
  });
  it("handles a leading-slash-only PRIVATE_OBJECT_DIR", () => {
    process.env["PRIVATE_OBJECT_DIR"] = "/just-bucket";
    expect(resolveRenderBucketName()).toBe("just-bucket");
  });
  it("throws when PRIVATE_OBJECT_DIR is unset", () => {
    delete process.env["PRIVATE_OBJECT_DIR"];
    expect(() => resolveRenderBucketName()).toThrow(/PRIVATE_OBJECT_DIR/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// mirrorRenderOutput — happy path
// ─────────────────────────────────────────────────────────────────────

describe("mirrorRenderOutput — image (no thumbnail branch)", () => {
  it("fetches, hashes, uploads, and returns the mirrored URL + key", async () => {
    const { uploader, uploads } = makeUploader("test-bucket");
    const { thumbnailer, calls: thumbCalls } = makeThumbnailer();
    const result = await mirrorRenderOutput({
      outputUrl: "https://api.mnmlai.dev/v1/images/abc.png",
      contentType: "image/png",
      renderId: "rnd-1",
      role: "primary",
      fetcher: makeFetcher(PNG_BYTES),
      uploader,
      thumbnailer,
    });

    expect(result.sha256).toBe(PNG_SHA);
    expect(result.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(result.mirroredObjectKey).toBe(
      `renders/rnd-1/primary-${PNG_SHA.slice(0, 16)}.png`,
    );
    expect(result.mirroredUrl).toBe(
      `gs://test-bucket/${result.mirroredObjectKey}`,
    );
    expect(result.thumbnailUrl).toBeUndefined();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      objectKey: result.mirroredObjectKey,
      contentType: "image/png",
    });
    // Thumbnail extractor MUST NOT have been called for an image.
    expect(thumbCalls).toHaveLength(0);
  });

  it("uploads the bytes verbatim (caller's contentType passes through)", async () => {
    const { uploader, uploads } = makeUploader();
    const { thumbnailer } = makeThumbnailer();
    await mirrorRenderOutput({
      outputUrl: "https://api.mnmlai.dev/v1/images/abc.webp",
      contentType: "image/webp",
      renderId: "rnd-2",
      role: "elevation-n",
      fetcher: makeFetcher(PNG_BYTES),
      uploader,
      thumbnailer,
    });
    expect(uploads[0]!.bytes.equals(PNG_BYTES)).toBe(true);
    expect(uploads[0]!.contentType).toBe("image/webp");
    expect(uploads[0]!.objectKey).toMatch(/\.webp$/);
  });
});

describe("mirrorRenderOutput — video (thumbnail branch)", () => {
  it("uploads main mp4 + ffmpeg-extracted JPEG thumbnail with companion key", async () => {
    const { uploader, uploads } = makeUploader("video-bucket");
    const { thumbnailer, calls: thumbCalls } = makeThumbnailer(THUMB_BYTES);
    const result = await mirrorRenderOutput({
      outputUrl: "https://api.mnmlai.dev/v1/videos/xyz.mp4",
      contentType: "video/mp4",
      renderId: "rnd-3",
      role: "video-primary",
      fetcher: makeFetcher(MP4_BYTES),
      uploader,
      thumbnailer,
    });

    // Main asset
    expect(result.sha256).toBe(MP4_SHA);
    expect(result.mirroredObjectKey).toBe(
      `renders/rnd-3/video-primary-${MP4_SHA.slice(0, 16)}.mp4`,
    );
    expect(result.mirroredUrl).toBe(
      `gs://video-bucket/${result.mirroredObjectKey}`,
    );
    // Thumbnail
    expect(result.thumbnailObjectKey).toBe(
      `renders/rnd-3/video-primary-thumb-${THUMB_SHA.slice(0, 16)}.jpg`,
    );
    expect(result.thumbnailUrl).toBe(
      `gs://video-bucket/${result.thumbnailObjectKey}`,
    );
    expect(result.thumbnailSizeBytes).toBe(THUMB_BYTES.byteLength);

    // Two uploads: main mp4, then thumb jpg
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.contentType).toBe("video/mp4");
    expect(uploads[1]!.contentType).toBe("image/jpeg");
    expect(uploads[1]!.bytes.equals(THUMB_BYTES)).toBe(true);

    // Thumbnailer received the original mp4 bytes
    expect(thumbCalls).toHaveLength(1);
    expect(thumbCalls[0]!.equals(MP4_BYTES)).toBe(true);
  });

  it("triggers the thumbnail branch for any video/* content type", async () => {
    const { uploader, uploads } = makeUploader();
    const { thumbnailer, calls } = makeThumbnailer(THUMB_BYTES);
    await mirrorRenderOutput({
      outputUrl: "https://example.test/clip.webm",
      contentType: "video/webm",
      renderId: "rnd-4",
      role: "video-primary",
      fetcher: makeFetcher(MP4_BYTES),
      uploader,
      thumbnailer,
    });
    expect(uploads).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────

describe("mirrorRenderOutput — error mapping", () => {
  it("maps non-2xx fetch response to fetch_failed", async () => {
    const { uploader } = makeUploader();
    const { thumbnailer } = makeThumbnailer();
    await expect(
      mirrorRenderOutput({
        outputUrl: "https://api.mnmlai.dev/v1/images/expired.png",
        contentType: "image/png",
        renderId: "rnd-1",
        role: "primary",
        fetcher: makeFetcher(PNG_BYTES, 410),
        uploader,
        thumbnailer,
      }),
    ).rejects.toMatchObject({
      name: "RenderMirrorError",
      code: "fetch_failed",
    });
  });

  it("maps thrown fetcher to fetch_failed (transport-side)", async () => {
    const { uploader } = makeUploader();
    const { thumbnailer } = makeThumbnailer();
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      mirrorRenderOutput({
        outputUrl: "https://api.mnmlai.dev/v1/images/abc.png",
        contentType: "image/png",
        renderId: "rnd-1",
        role: "primary",
        fetcher,
        uploader,
        thumbnailer,
      }),
    ).rejects.toMatchObject({
      code: "fetch_failed",
      message: expect.stringContaining("ECONNRESET"),
    });
  });

  it("maps uploader throw to upload_failed", async () => {
    const { thumbnailer } = makeThumbnailer();
    const uploader: ObjectUploader = {
      async upload() {
        throw new Error("403 forbidden");
      },
    };
    await expect(
      mirrorRenderOutput({
        outputUrl: "https://api.mnmlai.dev/v1/images/abc.png",
        contentType: "image/png",
        renderId: "rnd-1",
        role: "primary",
        fetcher: makeFetcher(PNG_BYTES),
        uploader,
        thumbnailer,
      }),
    ).rejects.toMatchObject({
      name: "RenderMirrorError",
      code: "upload_failed",
    });
  });

  it("maps thumbnailer throw to thumbnail_failed", async () => {
    const { uploader } = makeUploader();
    const thumbnailer: VideoThumbnailer = {
      async extractFirstFrameJpeg() {
        throw new Error("ffmpeg exited 1");
      },
    };
    await expect(
      mirrorRenderOutput({
        outputUrl: "https://api.mnmlai.dev/v1/videos/x.mp4",
        contentType: "video/mp4",
        renderId: "rnd-1",
        role: "video-primary",
        fetcher: makeFetcher(MP4_BYTES),
        uploader,
        thumbnailer,
      }),
    ).rejects.toMatchObject({
      code: "thumbnail_failed",
      message: expect.stringContaining("ffmpeg exited 1"),
    });
  });

  it("maps thumbnail upload failure to upload_failed (the second upload, not the first)", async () => {
    const { thumbnailer } = makeThumbnailer(THUMB_BYTES);
    let uploadCount = 0;
    const uploader: ObjectUploader = {
      async upload() {
        uploadCount++;
        if (uploadCount === 1) return { bucketName: "ok" };
        throw new Error("thumb-bucket 503");
      },
    };
    await expect(
      mirrorRenderOutput({
        outputUrl: "https://example.test/x.mp4",
        contentType: "video/mp4",
        renderId: "rnd-1",
        role: "video-primary",
        fetcher: makeFetcher(MP4_BYTES),
        uploader,
        thumbnailer,
      }),
    ).rejects.toMatchObject({
      code: "upload_failed",
      message: expect.stringContaining("thumbnail"),
    });
    expect(uploadCount).toBe(2);
  });

  it("RenderMirrorError survives instanceof + name + code shape", () => {
    const err = new RenderMirrorError("fetch_failed", "x");
    expect(err).toBeInstanceOf(RenderMirrorError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RenderMirrorError");
    expect(err.code).toBe("fetch_failed");
  });
});
