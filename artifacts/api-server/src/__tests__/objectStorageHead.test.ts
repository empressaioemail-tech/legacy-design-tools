/**
 * `ObjectStorageService.getObjectEntityHead` — bounded head-byte read
 * used by the avatar image-signature gate.
 *
 * The route-level tests in `users.test.ts` mock the whole storage
 * service away (so the avatar gate can exercise its branches without
 * needing a real bucket), which means the real `getObjectEntityHead`
 * implementation has no test coverage from that side. This file pins
 * the implementation directly: path normalization, byte concatenation
 * across multiple stream chunks, and — crucially — translation of a
 * race-window 404 from the read stream into `ObjectNotFoundError`.
 *
 * The underlying `@google-cloud/storage` client is stubbed via
 * `vi.spyOn(objectStorageClient, "bucket")` so the suite stays fully
 * offline (no sidecar, no network, no PRIVATE_OBJECT_DIR-resident
 * fixture object).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  objectStorageClient,
} from "../lib/objectStorage";

const PRIVATE_DIR = "/test-bucket/private";

let bucketSpy: ReturnType<typeof vi.spyOn> | null = null;
let originalPrivateDir: string | undefined;

interface FileStub {
  exists: ReturnType<typeof vi.fn>;
  createReadStream: ReturnType<typeof vi.fn>;
}

function installBucketStub(file: FileStub): void {
  const fileFactory = vi.fn(() => file);
  const bucket = { file: fileFactory } as unknown as ReturnType<
    typeof objectStorageClient.bucket
  >;
  bucketSpy = vi
    .spyOn(objectStorageClient, "bucket")
    .mockReturnValue(bucket);
}

function makeFileStub(opts: {
  exists?: boolean;
  // Either an array of chunks to emit and then `end`, or a function
  // that returns a Readable that errors. Lets us exercise both the
  // happy path (chunked read) and the race-window 404.
  stream: Readable | (() => Readable);
}): FileStub {
  return {
    exists: vi.fn().mockResolvedValue([opts.exists ?? true]),
    createReadStream: vi.fn(() =>
      typeof opts.stream === "function" ? opts.stream() : opts.stream,
    ),
  };
}

beforeEach(() => {
  originalPrivateDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = PRIVATE_DIR;
});

afterEach(() => {
  bucketSpy?.mockRestore();
  bucketSpy = null;
  if (originalPrivateDir === undefined) {
    delete process.env.PRIVATE_OBJECT_DIR;
  } else {
    process.env.PRIVATE_OBJECT_DIR = originalPrivateDir;
  }
});

describe("ObjectStorageService.getObjectEntityHead — short-circuits", () => {
  it("returns null for an external https URL not hosted by us", async () => {
    // External avatar URLs (legacy paste-URL admin path) must skip
    // the sniff entirely — the route layer treats `null` as "this
    // isn't ours, leave it alone". No bucket stub is needed because
    // the path filter short-circuits before any GCS call.
    const svc = new ObjectStorageService();
    const out = await svc.getObjectEntityHead(
      "https://example.com/some-image.png",
      32,
    );
    expect(out).toBeNull();
  });

  it("returns null for a malformed local path (no `/objects/` prefix)", async () => {
    const svc = new ObjectStorageService();
    const out = await svc.getObjectEntityHead("/not-objects/foo", 32);
    expect(out).toBeNull();
  });

  it("returns an empty buffer when byteLen is 0 (skips the stream entirely)", async () => {
    // No stub installed: a 0-byte read must not even open a stream,
    // so the absence of a bucket spy here doubles as the assertion
    // that no GCS call was attempted.
    const svc = new ObjectStorageService();
    const out = await svc.getObjectEntityHead("/objects/uploads/foo", 0);
    expect(out).toEqual(Buffer.alloc(0));
  });

  it("returns an empty buffer for a negative byteLen too", async () => {
    const svc = new ObjectStorageService();
    const out = await svc.getObjectEntityHead("/objects/uploads/foo", -10);
    expect(out).toEqual(Buffer.alloc(0));
  });
});

describe("ObjectStorageService.getObjectEntityHead — happy path", () => {
  it("concatenates multiple stream chunks into a single buffer", async () => {
    // Real GCS streams chunk arbitrarily. The implementation must
    // accumulate every chunk before returning so callers see the
    // contiguous head bytes regardless of how the SDK splits them.
    const stream = Readable.from([
      Buffer.from([0x89, 0x50]),
      Buffer.from([0x4e, 0x47]),
      Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]),
    ]);
    installBucketStub(makeFileStub({ stream }));

    const svc = new ObjectStorageService();
    const out = await svc.getObjectEntityHead(
      "/objects/uploads/png-fixture",
      8,
    );
    expect(out).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("requests inclusive `[0, byteLen - 1]` from createReadStream", async () => {
    // GCS `start`/`end` are inclusive byte offsets — passing
    // `end: byteLen` would over-read by one byte, which is harmless
    // but the contract is "first N bytes" and the call shape is
    // load-bearing for anyone tracing storage cost.
    const stream = Readable.from([Buffer.from([0xff, 0xd8, 0xff])]);
    const file = makeFileStub({ stream });
    installBucketStub(file);

    const svc = new ObjectStorageService();
    await svc.getObjectEntityHead("/objects/uploads/jpeg-fixture", 1024);
    expect(file.createReadStream).toHaveBeenCalledWith({
      start: 0,
      end: 1023,
    });
  });

  it("decodes a string-typed chunk into a buffer (defensive)", async () => {
    // The GCS SDK can hand back Buffers or strings depending on
    // encoding mode. The implementation defensively coerces to
    // Buffer so a misconfigured stream doesn't poison the magic-
    // number sniff downstream.
    const stream = Readable.from(["GIF89a"]);
    installBucketStub(makeFileStub({ stream }));

    const svc = new ObjectStorageService();
    const out = await svc.getObjectEntityHead(
      "/objects/uploads/gif-fixture",
      6,
    );
    expect(out).toEqual(Buffer.from("GIF89a", "ascii"));
  });
});

describe("ObjectStorageService.getObjectEntityHead — error mapping", () => {
  it("throws ObjectNotFoundError when the existence check says the object is gone", async () => {
    // Pre-stream branch: `getObjectEntityFile` already returned
    // false from `exists()`, so the read never even starts.
    installBucketStub(
      makeFileStub({ exists: false, stream: Readable.from([]) }),
    );

    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityHead("/objects/uploads/already-gone", 32),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("translates a race-window 404 from the read stream into ObjectNotFoundError", async () => {
    // The exact case the try/catch in `getObjectEntityHead` exists
    // to handle: `exists()` returned true (so `getObjectEntityFile`
    // happily returned a File), but the bytes vanished before the
    // stream drained — a parallel admin delete or a GC sweep. The
    // GCS SDK surfaces this as a stream `error` event with `code:
    // 404`. The route layer relies on `ObjectNotFoundError` to
    // respond 400 instead of bubbling the GCS-shaped error as a
    // 500.
    installBucketStub(
      makeFileStub({
        stream: () => {
          const r = new Readable({ read() {} });
          // Defer the error so the consumer enters the `for await`
          // loop before it fires — mirrors how the real SDK fails
          // mid-stream rather than synchronously at construction.
          process.nextTick(() => {
            const err = Object.assign(new Error("Not Found"), {
              code: 404,
            });
            r.destroy(err);
          });
          return r;
        },
      }),
    );

    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityHead("/objects/uploads/race-deleted", 32),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("re-throws non-404 read errors unchanged so they surface as 500s", async () => {
    // Posture check: a 503/transient GCS outage during a read is
    // NOT a missing object, and translating it to ObjectNotFoundError
    // would silently corrupt the route's 400/500 response shape.
    // The implementation only special-cases `code === 404`.
    const cause = Object.assign(new Error("Service Unavailable"), {
      code: 503,
    });
    installBucketStub(
      makeFileStub({
        stream: () => {
          const r = new Readable({ read() {} });
          process.nextTick(() => r.destroy(cause));
          return r;
        },
      }),
    );

    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityHead("/objects/uploads/transient-blip", 32),
    ).rejects.toBe(cause);
  });
});
