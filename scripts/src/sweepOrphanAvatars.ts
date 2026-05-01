/**
 * One-time sweep for orphaned avatar object entities in the private GCS
 * bucket.
 *
 * Background: Task #90 wired the api-server to delete the previous
 * `users.avatar_url` object whenever an admin replaces or clears a
 * profile avatar. That stops the bleed for new edits but does nothing
 * about the backlog of `/objects/uploads/<uuid>` objects that were
 * orphaned by every replace/clear that happened before the fix
 * shipped. This script walks the `uploads/` prefix of the private
 * bucket once, cross-references each object against the live
 * `users.avatar_url` set in Postgres, and reports (or, with `--apply`,
 * deletes) the unreferenced ones.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run sweep:orphan-avatars
 *   pnpm --filter @workspace/scripts run sweep:orphan-avatars -- --apply
 *
 * Defaults to a dry run that prints every object the sweep WOULD
 * delete without touching anything. Pass `--apply` (or `--no-dry-run`)
 * to actually delete.
 *
 * Scope: only objects under `<PRIVATE_OBJECT_DIR>/uploads/` are
 * considered. That prefix is what `getObjectEntityUploadURL` writes,
 * so it captures every avatar (and every other presigned upload that
 * lands via the same flow). Other prefixes inside the private bucket
 * (e.g. system-managed paths) are left strictly alone.
 *
 * Source-of-truth audit: at the time of writing, the only column in
 * the Drizzle schema that stores an `/objects/` path is
 * `users.avatar_url` — verified by ripgrep across `lib/db/src`. If a
 * future feature persists object paths in another table (engagement
 * attachments, submission packages, etc.), `loadReferencedObjectNames`
 * MUST be extended to include those columns BEFORE running this
 * sweep with `--apply`, or the sweep will treat those still-live
 * objects as orphans and delete them.
 *
 * Why a fresh GCS client init instead of importing
 * `objectStorageClient` from `artifacts/api-server`: workspace rules
 * forbid `scripts` from importing across to `artifacts/*`. Promoting
 * the client to a new shared lib for a single one-off cleanup script
 * was overkill, so the small Replit-sidecar credential init from
 * `artifacts/api-server/src/lib/objectStorage.ts` is mirrored here.
 * The same is true of the `parseObjectPath` helper and the
 * `normalizeObjectEntityPath` URL/path-shape handling — both live
 * inline so the script can run standalone.
 *
 * Safety:
 *  - Dry run is the default. The `--apply` switch is required to
 *    actually issue any GCS deletes.
 *  - Live `users.avatar_url` values are loaded BEFORE the bucket
 *    listing, so a row written between listing and delete is still
 *    safe (its object isn't in the listed set).
 *  - `ignoreNotFound: true` collapses 404s into a no-op so a parallel
 *    delete (e.g. by the api-server's own cleanup path) doesn't make
 *    the sweep fail.
 *  - Avatar URLs come in three shapes and are handled accordingly:
 *      (a) `/objects/<entityId>` — the canonical post-upload form.
 *          Resolved to `<PRIVATE_OBJECT_DIR>/<entityId>` and added to
 *          the referenced set.
 *      (b) `https://storage.googleapis.com/<PRIVATE_OBJECT_DIR>/...`
 *          — legacy direct GCS URLs that DO live in our private dir.
 *          Normalized into form (a), then added to the referenced
 *          set.
 *      (c) Anything else (pasted external https URLs, malformed
 *          paths) — not an object we own, so it can't possibly map
 *          to a bucket key the sweep is looking at. Skipped without
 *          contributing to the referenced set, which is safe because
 *          the bucket listing also won't include them.
 */

import { Storage } from "@google-cloud/storage";
import { isNotNull } from "drizzle-orm";
import { db as defaultDb, pool, users } from "@workspace/db";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const objectStorageClient = new Storage({
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

export interface CliOptions {
  dryRun: boolean;
}

/**
 * Minimal storage surface the sweep actually uses. Defined as a
 * standalone interface (rather than typing against `@google-cloud/
 * storage`'s `Storage` directly) so the integration test can inject
 * an in-memory fake without having to satisfy the entire GCS client
 * type. The real `Storage` class structurally satisfies this — it
 * has a `bucket()` method that returns a `Bucket` whose `getFiles()`
 * resolves to `[File[], ...]`, and each `File` has `name: string`
 * and a `delete(opts)` method — so the production caller passes its
 * real client in untouched (with one cast at the boundary).
 *
 * Kept narrow on purpose: any expansion forces the test fake to grow
 * too, which is the point — a future refactor that starts calling,
 * say, `bucket.deleteFiles()` directly will fail to typecheck against
 * this interface and force whoever wrote it to update both prod and
 * the test.
 */
export interface SweepFile {
  name: string;
  delete(opts?: { ignoreNotFound?: boolean }): Promise<unknown>;
}
export interface SweepBucket {
  getFiles(opts: { prefix: string }): Promise<[SweepFile[]]>;
}
export interface SweepStorage {
  bucket(name: string): SweepBucket;
}

/**
 * Drizzle surface the sweep needs — narrowed to just `.select()` so
 * tests can pass the `withTestSchema` db in without satisfying the
 * full Drizzle type surface. The production `db` from `@workspace/db`
 * structurally satisfies this.
 */
export type SweepDb = Pick<typeof defaultDb, "select">;

export interface SweepDeps {
  storage?: SweepStorage;
  db?: SweepDb;
  /**
   * `/<bucket>/<sub-dir>` path the sweep should scan. Defaults to
   * the `PRIVATE_OBJECT_DIR` env var when omitted (which is what the
   * production CLI does); tests pass an explicit value so they don't
   * have to mutate process env.
   */
  privateDir?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  // Apply-mode is opt-in; anything else (including no flags) keeps the
  // sweep in dry-run mode. `--no-dry-run` is accepted as a more verbose
  // alias for symmetry with other scripts.
  const apply = argv.includes("--apply") || argv.includes("--no-dry-run");
  return { dryRun: !apply };
}

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. Required to know which bucket / " +
        "prefix to sweep.",
    );
  }
  return dir;
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  let p = path;
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/");
  if (parts.length < 3) {
    throw new Error(
      `Invalid object path '${path}': must contain at least a bucket name`,
    );
  }
  const bucketName = parts[1];
  const objectName = parts.slice(2).join("/");
  return { bucketName, objectName };
}

/**
 * Mirror of `ObjectStorageService.normalizeObjectEntityPath`. Converts
 * a raw `users.avatar_url` value into the canonical `/objects/<id>`
 * shape we can then map back to a bucket object. Anything that doesn't
 * live in our private dir is returned untouched and will be filtered
 * out by the caller.
 */
function normalizeObjectEntityPath(rawPath: string, privateDir: string): string {
  if (!rawPath.startsWith("https://storage.googleapis.com/")) {
    return rawPath;
  }
  let entityDir = privateDir;
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const url = new URL(rawPath);
  const rawObjectPath = url.pathname;
  if (!rawObjectPath.startsWith(entityDir)) {
    return rawObjectPath;
  }
  const entityId = rawObjectPath.slice(entityDir.length);
  return `/objects/${entityId}`;
}

/**
 * Convert a stored `avatar_url` into the bucket object name (the part
 * after `<bucket>/`) so it can be compared against listed bucket
 * objects. Returns null if the value isn't an object we own (external
 * URL, malformed path, missing entity id).
 */
function avatarUrlToObjectName(
  rawUrl: string,
  privateDir: string,
  expectedBucket: string,
): string | null {
  const normalized = normalizeObjectEntityPath(rawUrl, privateDir);
  if (!normalized.startsWith("/objects/")) return null;
  const parts = normalized.slice(1).split("/");
  if (parts.length < 2) return null;
  const entityId = parts.slice(1).join("/");
  if (!entityId) return null;
  let entityDir = privateDir;
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const fullPath = `${entityDir}${entityId}`;
  let parsed: { bucketName: string; objectName: string };
  try {
    parsed = parseObjectPath(fullPath);
  } catch {
    return null;
  }
  if (parsed.bucketName !== expectedBucket) return null;
  return parsed.objectName;
}

export interface SweepSummary {
  privateDir: string;
  bucketName: string;
  uploadsPrefix: string;
  liveAvatarRows: number;
  liveReferencedObjects: number;
  bucketObjectsScanned: number;
  orphans: number;
  deleted: number;
  failed: number;
  dryRun: boolean;
}

async function loadReferencedObjectNames(
  privateDir: string,
  bucketName: string,
  db: SweepDb,
): Promise<Set<string>> {
  const rows = await db
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(isNotNull(users.avatarUrl));
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.avatarUrl) continue;
    const objectName = avatarUrlToObjectName(
      row.avatarUrl,
      privateDir,
      bucketName,
    );
    if (objectName) out.add(objectName);
  }
  return out;
}

export async function sweep(
  opts: CliOptions,
  deps: SweepDeps = {},
): Promise<SweepSummary> {
  const storage =
    deps.storage ?? (objectStorageClient as unknown as SweepStorage);
  const db = deps.db ?? (defaultDb as SweepDb);
  const privateDir = deps.privateDir ?? getPrivateObjectDir();
  const { bucketName, objectName: privateDirObjectName } =
    parseObjectPath(privateDir);

  // `uploads/` is the only sub-prefix the upload flow writes to (see
  // `getObjectEntityUploadURL`), so that's the only thing we touch.
  const uploadsObjectPrefix = privateDirObjectName.endsWith("/")
    ? `${privateDirObjectName}uploads/`
    : `${privateDirObjectName}/uploads/`;

  // eslint-disable-next-line no-console
  console.log(
    `sweepOrphanAvatars: scanning gs://${bucketName}/${uploadsObjectPrefix} ` +
      `(dryRun=${opts.dryRun})`,
  );

  // Snapshot DB state BEFORE listing the bucket so a row written
  // between snapshot and listing isn't a candidate for deletion.
  const referenced = await loadReferencedObjectNames(
    privateDir,
    bucketName,
    db,
  );

  const liveRowCount = await db
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(isNotNull(users.avatarUrl))
    .then((rows) => rows.length);

  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: uploadsObjectPrefix });

  const summary: SweepSummary = {
    privateDir,
    bucketName,
    uploadsPrefix: uploadsObjectPrefix,
    liveAvatarRows: liveRowCount,
    liveReferencedObjects: referenced.size,
    bucketObjectsScanned: files.length,
    orphans: 0,
    deleted: 0,
    failed: 0,
    dryRun: opts.dryRun,
  };

  for (const file of files) {
    if (referenced.has(file.name)) continue;
    summary.orphans++;
    if (opts.dryRun) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] would delete gs://${bucketName}/${file.name}`);
      continue;
    }
    try {
      await file.delete({ ignoreNotFound: true });
      summary.deleted++;
      // eslint-disable-next-line no-console
      console.log(`deleted gs://${bucketName}/${file.name}`);
    } catch (err) {
      summary.failed++;
      // eslint-disable-next-line no-console
      console.error(
        `failed to delete gs://${bucketName}/${file.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let exitCode = 0;
  try {
    const summary = await sweep(opts);
    // eslint-disable-next-line no-console
    console.log("sweepOrphanAvatars: done", summary);
    if (summary.failed > 0) exitCode = 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("sweepOrphanAvatars: fatal error", err);
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {
      /* best-effort */
    });
  }
  process.exit(exitCode);
}

// Only invoke main() when this module is executed as the script's
// entrypoint (i.e. `tsx sweepOrphanAvatars.ts`). Without this guard,
// merely `import`-ing the module — as the integration test does to
// reach the exported `sweep()` — would run the CLI, hit
// `process.exit()` inside Vitest, and abort the test runner.
const invokedAsEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /sweepOrphanAvatars\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (invokedAsEntrypoint) {
  void main();
}
