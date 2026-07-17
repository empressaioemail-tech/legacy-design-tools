import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  requestUploadUrlBodySizeMax,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Allowed `contentType` values, sourced from the generated zod enum so the
 * route handler and the OpenAPI spec can't drift apart. `.options` is the
 * runtime-readable list zod exposes for `z.enum([...])`.
 */
const allowedContentTypes = RequestUploadUrlBody.shape.contentType.options;

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 *
 * The endpoint refuses requests above {@link requestUploadUrlBodySizeMax} (the
 * `RequestUploadUrlBody.size` cap from the OpenAPI spec, currently 2 MiB).
 * Avatar uploads from the Plan Review UI are client-side-resized to ~20 KB
 * before they get here, so this cap is well above any legitimate request —
 * its purpose is to keep a non-browser client (mobile, curl, integration)
 * from asking for a URL for an arbitrarily large object and bloating
 * storage.  We do the size check explicitly before the schema parse so the
 * caller gets a clear `413` ("Asset too large") instead of being lumped in
 * with generic `400` schema errors.
 *
 * For the same reason we also pre-check `contentType` against the image
 * MIME allow-list and return a clear `415` ("Unsupported Media Type") when
 * a non-image type slips through. Today the only consumer is the avatar
 * uploader, whose client-side resize always emits `image/jpeg`, so a
 * non-image request can only come from a non-browser caller trying to park
 * an arbitrary blob in object storage under the upload code path.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const rawSize = req.body?.size;
  if (typeof rawSize === "number" && rawSize > requestUploadUrlBodySizeMax) {
    res.status(413).json({
      error: `Upload too large: ${rawSize} bytes exceeds the ${requestUploadUrlBodySizeMax}-byte cap for this endpoint.`,
    });
    return;
  }

  const rawContentType = req.body?.contentType;
  if (
    typeof rawContentType === "string" &&
    !allowedContentTypes.includes(rawContentType as (typeof allowedContentTypes)[number])
  ) {
    res.status(415).json({
      error: `Unsupported contentType "${rawContentType}". Allowed types: ${allowedContentTypes.join(", ")}.`,
    });
    return;
  }

  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 *
 * SECURITY — RESIDUAL ANONYMOUS-READ EXPOSURE (flagged, partially hardened).
 *
 * This route is mounted with NO gate/auth middleware (see routes/index.ts) and
 * this api-server has no session/passport auth (`req.isAuthenticated()` never
 * exists — the old "uncomment for replit-auth" ACL example was dead code and
 * has been removed). Its only real callers are browser-initiated `<img>` /
 * `<a>` / `<iframe>` GETs that cannot attach a header credential:
 *   - Plan Review avatars  — `<img src="/api/storage/objects/uploads/avatar-…">`
 *   - Encumbrance PDF view — `pdfServeUrl()` → `/api/storage/objects/uploads/…`
 *     (artifacts/api-server/src/lib/encumbranceWire.ts)
 * Gating it behind the brokerage key (`X-Hauska-Key` / Bearer) would break both,
 * with no session-cookie fallback available — so it is NOT gated here.
 *
 * Hardening applied without breaking those flows: the route now serves ONLY a
 * flat `uploads/<entity>` entity path (single path segment under `uploads/`,
 * no nested prefixes, no traversal). This blocks namespace-escape / traversal
 * but does NOT close the core hole: any caller who knows or guesses an
 * `/objects/uploads/<uuid>` still reads the object anonymously, and terrain
 * mesh/IFC objects are written under the SAME `uploads/<uuid>` namespace.
 *
 * The terrain use case no longer depends on this route: the authorized,
 * engagement-scoped path is
 *   GET /api/brokerage/v1/place/:placeKey/site-topography/{mesh,ifc}
 * (brokeragePlaceHydrology.ts), which derives the object path from the caller's
 * authorized engagement and inherits the brokerage gate.
 *
 * FOLLOW-UP (app-auth owner): close this fully by moving avatars + encumbrance
 * PDF serving to a per-object short-lived signed URL (signObjectEntityGetUrl)
 * or a session-authenticated app route, then remove this anonymous route.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;

    // Hardening: only a flat `uploads/<entity>` path is servable here. Reject
    // anything with traversal, empty segments, or a non-`uploads/` prefix so
    // the ungated surface can't be walked into other object namespaces. The
    // legit browser callers (avatars, encumbrance PDFs) all live at
    // `uploads/<uuid|avatar-…>`.
    const uploadsMatch = /^uploads\/([^/]+)$/.exec(wildcardPath);
    if (!uploadsMatch || wildcardPath.includes("..")) {
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
