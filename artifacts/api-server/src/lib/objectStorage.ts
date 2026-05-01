import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  /**
   * Server-side upload of a buffer into the private object dir under
   * a fresh `/objects/<uuid>` path. Used by write paths that mint
   * bytes themselves rather than receiving them from the browser via
   * a presigned URL — e.g. the DA-MV-1 DXF→glb route, where the
   * server holds the converter response in memory and needs to
   * persist it without round-tripping a presign / PUT cycle.
   *
   * Returns the canonical `/objects/<id>` path the rest of the
   * codebase uses (mirrors what
   * {@link normalizeObjectEntityPath}({@link getObjectEntityUploadURL})
   * would yield for a browser-side upload).
   */
  async uploadObjectEntityFromBuffer(
    bytes: Buffer,
    contentType: string,
  ): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    await file.save(bytes, {
      contentType,
      // Don't add the gzip resumable handshake for tiny payloads —
      // the converter glbs are typically <1 MiB and a single PUT is
      // measurably faster than the multi-step resumable flow.
      resumable: false,
    });
    return `/objects/uploads/${objectId}`;
  }

  /**
   * Read the full bytes of a stored object entity into a Buffer.
   *
   * Used by paths that need the raw content (rather than streaming
   * it through to a Response), e.g. the DA-MV-1 DXF→glb route which
   * loads the DXF into memory before handing it to the converter,
   * and the glb-bytes serve route which hashes the bytes for an
   * ETag before writing them to the response.
   *
   * For very large objects this is wasteful — but the briefing
   * source byte-size is capped (RequestUploadUrlBody.size, currently
   * 2 MiB at the request-URL door), so reading into memory is fine
   * for this use case. If a future caller needs to handle larger
   * objects, prefer streaming from {@link getObjectEntityFile}'s
   * `createReadStream()` directly.
   */
  async getObjectEntityBytes(rawPath: string): Promise<Buffer> {
    const objectFile = await this.getObjectEntityFile(
      this.normalizeObjectEntityPath(rawPath),
    );
    const stream = objectFile.createReadStream();
    const chunks: Array<Buffer> = [];
    try {
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 404) {
        throw new ObjectNotFoundError();
      }
      throw err;
    }
    return Buffer.concat(chunks);
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  /**
   * Best-effort delete for an avatar / attachment URL stored against a
   * domain row. The caller passes whatever they have on hand — the raw
   * value off `users.avatar_url`, etc. — and we figure out whether it
   * maps to one of *our* private object entities.
   *
   * Returns `true` if a delete was attempted (even if the object turned
   * out to be already gone), and `false` if the input isn't something we
   * own (empty, external URL, malformed `/objects/` path).
   *
   * "Already gone" (GCS 404) is collapsed into a successful no-op so
   * cleaning up the same row twice — or after a previously-failed
   * cleanup — doesn't surface as an error. Other GCS errors (permission
   * denied, transient 5xx) are re-thrown so the caller can decide
   * whether to log-and-ignore (right answer for admin profile edits —
   * the DB row is the source of truth and an orphaned object is exactly
   * the problem we're trying to mitigate, so a transient GCS blip
   * shouldn't 500 the surrounding admin write) or surface to the user.
   */
  async deleteObjectIfStored(rawPath: string | null | undefined): Promise<boolean> {
    if (!rawPath) return false;
    const normalized = this.normalizeObjectEntityPath(rawPath);
    if (!normalized.startsWith("/objects/")) {
      // Pasted external URL (e.g. https://example.com/me.png) — not ours
      // to delete. Same for `/storage/public-objects/...` style paths.
      return false;
    }

    const parts = normalized.slice(1).split("/");
    if (parts.length < 2) return false;

    // Guard the empty-entity-id edge case (e.g. a literal `/objects/`
    // input or a trailing slash) — without this we'd hand GCS a path
    // that resolves to the private-dir prefix itself, which is at best
    // a wasted 404 and at worst a foot-gun if the prefix ever maps to
    // a real object placeholder. Treat it as "not ours to delete".
    const entityId = parts.slice(1).join("/");
    if (!entityId) return false;
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);

    // `ignoreNotFound` collapses the "already gone" case (404 from GCS)
    // into a successful no-op. Other GCS errors propagate per the
    // contract above.
    await objectFile.delete({ ignoreNotFound: true });
    return true;
  }

  /**
   * Read the leading `byteLen` bytes of a stored object entity.
   *
   * Used by write paths that need to *sniff* a client-supplied avatar
   * — the presigned-URL endpoint locks down the declared `contentType`
   * to the image MIME allow-list, but the bytes themselves are PUT
   * directly to GCS so a non-browser caller can still declare
   * `image/jpeg` and upload arbitrary bytes (a JSON dump, an
   * executable, …). Pulling the head of the object lets a caller run
   * a magic-number check before persisting `users.avatar_url` against
   * the row.
   *
   * Returns `null` when the path isn't one of ours (external URL,
   * malformed path) — same convention as {@link getObjectEntitySize},
   * so callers can treat external resources as "skip the check".
   * Throws `ObjectNotFoundError` when the path conceptually resolves
   * to one of ours but the bytes aren't in the bucket.
   *
   * `byteLen` is a *hint* — GCS may return fewer bytes if the object
   * is shorter than that. Avatar magic-number sniffs only need the
   * first 16-32 bytes, but we leave the cap to the caller so the SVG
   * sniff can ask for a few hundred and still fit any realistic head
   * read.
   */
  async getObjectEntityHead(
    rawPath: string,
    byteLen: number,
  ): Promise<Buffer | null> {
    const normalized = this.normalizeObjectEntityPath(rawPath);
    if (!normalized.startsWith("/objects/")) return null;
    if (byteLen <= 0) return Buffer.alloc(0);

    const objectFile = await this.getObjectEntityFile(normalized);
    // GCS `start`/`end` are inclusive byte offsets, so reading the
    // first `byteLen` bytes is `[0, byteLen - 1]`.
    const stream = objectFile.createReadStream({ start: 0, end: byteLen - 1 });
    const chunks: Array<Buffer> = [];
    try {
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (err) {
      // Race window: `getObjectEntityFile` already confirmed the
      // object exists via a metadata HEAD, but the bytes can still
      // disappear before the read stream drains (a parallel admin
      // delete, an object-storage GC sweep, …). The Node GCS SDK
      // surfaces this as a stream error with `code === 404`.
      // Translate it back to `ObjectNotFoundError` so callers don't
      // have to discover the GCS-specific error shape and so the
      // route layer can respond 400 ("avatar object not found in
      // storage") consistently with the existence-check branch
      // instead of bubbling out as a 500.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 404) {
        throw new ObjectNotFoundError();
      }
      throw err;
    }
    return Buffer.concat(chunks);
  }

  /**
   * Look up the byte size of a stored object entity by its
   * `/objects/<id>` path.
   *
   * Used by write paths that accept a client-supplied avatar URL (e.g.
   * `PATCH /users/:id`, `POST /users`) so we can validate the *actual*
   * stored object size against a cap, rather than trusting the size the
   * client claimed when it requested the presigned URL. Without this
   * second check, a non-browser client could request a URL with
   * `size: 1024` and then PUT a 50 MiB file — the request-URL handler's
   * cap is on metadata, not bytes-on-disk, so it can't catch that on
   * its own.
   *
   * Returns `null` when the path isn't one of ours (external URL,
   * malformed path) — the caller should treat that as "skip the size
   * check, this is an external resource we don't host". Throws
   * `ObjectNotFoundError` if the object existed at the path conceptually
   * but isn't present in the bucket (e.g. presigned URL was issued but
   * the PUT never happened).
   */
  async getObjectEntitySize(rawPath: string): Promise<number | null> {
    const normalized = this.normalizeObjectEntityPath(rawPath);
    if (!normalized.startsWith("/objects/")) return null;

    const objectFile = await this.getObjectEntityFile(normalized);
    const [metadata] = await objectFile.getMetadata();
    const raw = metadata.size;
    if (raw === undefined || raw === null) return null;
    // GCS returns size as a string in some SDK paths and a number in
    // others; normalize to number so callers can compare against a
    // numeric cap without re-encoding the type discriminator.
    const asNumber = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(asNumber) ? asNumber : null;
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = (await response.json()) as {
    signed_url: string;
  };
  return signedURL;
}
