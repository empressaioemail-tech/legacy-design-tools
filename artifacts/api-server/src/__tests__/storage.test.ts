/**
 * /api/storage/uploads/request-url — server-side cap on presigned-URL
 * requests.
 *
 * The browser-facing avatar flow already client-side-resizes, so the
 * point of these tests is the *other* clients: a future mobile app, a
 * curl script, or an integration that could ask for a URL for an
 * arbitrarily large object and bloat the storage bill. The route must
 * refuse those requests with a clear `413` *before* it hands out a
 * presigned URL — once we've signed the URL, the upload is out of our
 * control.
 *
 * We deliberately do NOT exercise the happy path here: the success
 * branch calls into the real GCS-backed `ObjectStorageService`, which
 * needs `PRIVATE_OBJECT_DIR` + sidecar credentials and isn't worth
 * stubbing for a validation-only suite. The schema parse / size cap
 * paths short-circuit before any GCS call, so the test app doesn't
 * touch storage.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  RequestUploadUrlBody,
  requestUploadUrlBodySizeMax,
} from "@workspace/api-zod";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("storage.test: ctx.schema not initialized");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("POST /api/storage/uploads/request-url", () => {
  it("rejects requests larger than the per-asset cap with a 413", async () => {
    const oversize = requestUploadUrlBodySizeMax + 1;
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({
        name: "huge.jpg",
        size: oversize,
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(413);
    // The error must mention both the offending size and the cap so the
    // caller can adjust without reading docs. This is the "clear 4xx"
    // half of the task acceptance criteria.
    expect(res.body.error).toContain(String(oversize));
    expect(res.body.error).toContain(String(requestUploadUrlBodySizeMax));
  });

  it("rejects requests at exactly cap+1 bytes (boundary)", async () => {
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({
        name: "edge.jpg",
        size: requestUploadUrlBodySizeMax + 1,
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(413);
  });

  it("returns 400 for malformed bodies (missing required fields)", async () => {
    // Missing `contentType`. The size cap check passes (size is well
    // under the limit), so we fall through to the schema parse and get
    // a generic 400 — distinct from the size-specific 413 above.
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({ name: "ok.jpg", size: 1024 });

    expect(res.status).toBe(400);
  });

  it("returns 400 (not 413) when size is non-numeric", async () => {
    // The 413 short-circuit is gated on `typeof size === "number"`;
    // anything else has to flow through the schema parse so the caller
    // gets a validation error, not a misleading "too large" message.
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({
        name: "weird.jpg",
        size: "not-a-number",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(400);
  });

  it("rejects non-image contentType with a 415 naming the allowed types", async () => {
    // The avatar uploader is the only consumer today and always sends
    // `image/jpeg`, so a non-image type can only come from a non-browser
    // caller trying to park an arbitrary blob (e.g. a JSON dump that
    // sneaks under the 2 MiB cap) in object storage. The route must
    // refuse those with a clear `415` *before* any presigned URL is
    // handed out.
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({
        name: "payload.json",
        size: 1024,
        contentType: "application/json",
      });

    expect(res.status).toBe(415);
    expect(res.body.error).toContain("application/json");
    // Must enumerate the allow-list so the caller can fix without
    // having to read docs — same shape as the size-cap error.
    for (const allowed of RequestUploadUrlBody.shape.contentType.options) {
      expect(res.body.error).toContain(allowed);
    }
  });

  it("accepts every image MIME type in the allow-list (boundary)", async () => {
    // Pin the allow-list itself: if a future spec change drops a type,
    // this test fails so we notice. We can't assert 200 (the success
    // branch needs real GCS — see the file header) but we can assert
    // the request makes it past *both* validation gates, i.e. it is
    // neither a 413 nor a 415 nor a 400.
    for (const contentType of RequestUploadUrlBody.shape.contentType.options) {
      const res = await request(getApp())
        .post("/api/storage/uploads/request-url")
        .send({ name: `ok.${contentType.split("/")[1]}`, size: 1024, contentType });

      expect([413, 415, 400]).not.toContain(res.status);
    }
  });

  it("returns 415 (not 400) when contentType is a string but disallowed", async () => {
    // The 415 short-circuit is gated on `typeof contentType === "string"`;
    // a string that isn't in the allow-list must surface as 415 rather
    // than being lumped in with generic schema errors. This mirrors the
    // 413-vs-400 distinction for `size`.
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({
        name: "doc.pdf",
        size: 1024,
        contentType: "application/pdf",
      });

    expect(res.status).toBe(415);
  });

  it("returns 400 (not 415) when contentType is the wrong type entirely", async () => {
    // The 415 short-circuit only fires for string content types; a
    // missing or non-string contentType has to flow through the schema
    // parse so the caller gets a generic validation error, not a
    // misleading "unsupported media type" message.
    const res = await request(getApp())
      .post("/api/storage/uploads/request-url")
      .send({
        name: "weird.jpg",
        size: 1024,
        contentType: 42,
      });

    expect(res.status).toBe(400);
  });
});
