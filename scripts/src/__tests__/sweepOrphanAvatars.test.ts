/**
 * Integration coverage for the orphan-avatar sweep — Task #312.
 *
 * Why this exists
 * ---------------
 * `sweepOrphanAvatars.ts` runs against object storage with `--apply`
 * and *deletes* whatever it considers orphaned. Unlike the briefing-
 * generation backfill (which only ever writes column values), a
 * regression here is destructive: a wrong WHERE clause, a swapped
 * comparison, or a missed avatar URL shape would silently delete
 * in-use avatars on the next post-merge run. There is no DB column
 * to roll back to once the bytes are gone from the bucket.
 *
 * The script wasn't covered by anything before this. We add a fixture-
 * driven test that:
 *
 *   1. Spins up a fresh DB schema via `withTestSchema` and seeds the
 *      `users` table with a representative cross-section of
 *      `avatar_url` shapes (canonical `/objects/...`, legacy
 *      `https://storage.googleapis.com/...`, NULL, external https,
 *      malformed) — this is exactly what
 *      `loadReferencedObjectNames` parses today.
 *
 *   2. Stands up an in-memory storage fake that satisfies the narrow
 *      `SweepStorage` interface the script now declares, and seeds
 *      the bucket with a mix of files: some referenced by a row,
 *      some not, plus a file outside the `uploads/` prefix that the
 *      sweep MUST NOT touch even if it's unreferenced.
 *
 *   3. Asserts the post-sweep bucket state — referenced files still
 *      exist, only orphans were deleted — rather than just the
 *      summary tally. That's the real safety property: an off-by-one
 *      in the summary is annoying; deleting the wrong file is a
 *      production incident.
 *
 * The test is gated on `DATABASE_URL` (or `TEST_DATABASE_URL`)
 * because `withTestSchema` needs a real Postgres to apply the DDL
 * fixture against. It can never touch real object storage because
 * it never constructs the production GCS client — the in-memory
 * fake is the only `SweepStorage` it ever instantiates.
 */

import { describe, it, expect, beforeAll } from "vitest";
// Type-only imports are erased at compile time, so they DO NOT
// trigger the @workspace/db module's top-level `DATABASE_URL` check
// (which would otherwise throw at file-load time even when the
// suite is supposed to skip).
import type { TestSchemaContext } from "@workspace/db/testing";
import type {
  SweepBucket,
  SweepDb,
  SweepFile,
  SweepStorage,
  CliOptions,
  SweepDeps,
  SweepSummary,
} from "../sweepOrphanAvatars";

/**
 * Explicit env gate. The task requires this suite to be opt-in on a
 * Postgres-backed environment (`DATABASE_URL` or `TEST_DATABASE_URL`).
 * Falling back to "let `withTestSchema` throw" would surface as a
 * red suite in any local checkout that doesn't have a database to
 * point at, even though the right outcome there is "skip — there's
 * nothing to test against". So we use `describe.skipIf` to render
 * the suite as skipped (not failed) when neither var is set.
 *
 * `describe.skipIf` rather than a top-level `if` block: keeps the
 * skip visible in the Vitest reporter (skipped count > 0), so a
 * misconfigured CI environment is loud rather than silently
 * collapsing the suite to zero tests.
 */
const HAS_DB_URL = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);
const describeIfDb = describe.skipIf(!HAS_DB_URL);

/**
 * Lazy holders for the runtime modules. Both `@workspace/db/testing`
 * and `../sweepOrphanAvatars` transitively evaluate
 * `@workspace/db/index.ts`, which throws at the top of the file if
 * `DATABASE_URL` is unset. To avoid that crash when the suite is
 * supposed to skip, we defer the actual `await import(...)` calls
 * into a `beforeAll` that only runs inside the `describe.skipIf`
 * block (Vitest skips hooks for skipped suites).
 */
let withTestSchema: (typeof import("@workspace/db/testing"))["withTestSchema"];
let sweep: (
  opts: CliOptions,
  deps?: SweepDeps,
) => Promise<SweepSummary>;

/**
 * Production sets PRIVATE_OBJECT_DIR to `/<bucket>/<sub-dir>`. We pick
 * a fixed value so the bucket name (`test-bucket`) and the object-name
 * prefix (`private/uploads/`) are obvious in test failures. The `sub`
 * dir below `private/` is intentional — exercises the
 * `parseObjectPath` + uploads-prefix-construction logic with a
 * non-trivial nesting rather than a degenerate `/<bucket>/uploads`.
 */
const TEST_PRIVATE_DIR = "/test-bucket/private";
const UPLOADS_PREFIX = "private/uploads/";

/**
 * In-memory implementation of the narrow `SweepStorage` surface the
 * sweep declares. Keeps the storage state in a `Map<string, "exists">`
 * keyed by object name; `delete` removes the entry (or no-ops with
 * `ignoreNotFound`). `getFiles({ prefix })` returns every key whose
 * name starts with the prefix.
 *
 * Exposed `seed`/`existing`/`deleteCalls` helpers let tests assert
 * the post-state (which files survived) AND the call shape (was
 * `ignoreNotFound: true` actually passed?). Both matter — the
 * latter guards against a refactor that drops the option and starts
 * blowing up on concurrent deletes.
 */
function createFakeStorage(bucketName: string): {
  storage: SweepStorage;
  seed: (objectName: string) => void;
  existing: () => string[];
  deleteCalls: () => Array<{
    objectName: string;
    options: { ignoreNotFound?: boolean } | undefined;
  }>;
} {
  const objects = new Map<string, true>();
  const deleteCalls: Array<{
    objectName: string;
    options: { ignoreNotFound?: boolean } | undefined;
  }> = [];

  const bucket: SweepBucket = {
    async getFiles({ prefix }) {
      const matched: SweepFile[] = [];
      // Sort for deterministic iteration order — the production sweep
      // order doesn't matter, but a stable test order makes failures
      // easier to read.
      const names = Array.from(objects.keys()).sort();
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        matched.push({
          name,
          async delete(options) {
            deleteCalls.push({ objectName: name, options });
            if (!objects.delete(name) && !options?.ignoreNotFound) {
              throw new Error(`object not found: ${name}`);
            }
            return undefined;
          },
        });
      }
      return [matched];
    },
  };

  const storage: SweepStorage = {
    bucket(name: string) {
      // The sweep is supposed to derive the bucket name from
      // `privateDir`. If a regression starts asking for a different
      // bucket, the test fails loudly here rather than silently
      // returning an empty file list.
      if (name !== bucketName) {
        throw new Error(
          `unexpected bucket request: got ${name}, expected ${bucketName}`,
        );
      }
      return bucket;
    },
  };

  return {
    storage,
    seed(objectName) {
      objects.set(objectName, true);
    },
    existing() {
      return Array.from(objects.keys()).sort();
    },
    deleteCalls() {
      return [...deleteCalls];
    },
  };
}

/**
 * Insert a `users` row with the given avatar value. The script reads
 * `users.avatar_url` directly, so we only populate the columns the
 * schema requires (id, display_name) plus avatar_url. Returns the
 * generated id mostly for failure diagnostics.
 */
async function seedUser(
  ctx: TestSchemaContext,
  id: string,
  avatarUrl: string | null,
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO users (id, display_name, avatar_url)
       VALUES ($1, $2, $3)`,
    [id, `User ${id}`, avatarUrl],
  );
}

/**
 * Cast the test schema's Drizzle handle to the narrow `SweepDb`
 * surface the script accepts. They are runtime-compatible — both
 * are produced by `drizzle(pool, { schema })` with the same schema
 * object — and `SweepDb` is just `Pick<typeof db, "select">`, so the
 * cast carries no behaviour change. Wrapped in a helper so the cast
 * lives in exactly one place.
 */
function asSweepDb(ctx: TestSchemaContext): SweepDb {
  return ctx.db as unknown as SweepDb;
}

describeIfDb("sweepOrphanAvatars — Task #312", () => {
  beforeAll(async () => {
    // `@workspace/db/index.ts` evaluates a hard `DATABASE_URL` check
    // at the top of the module. The suite is documented as enabled
    // when EITHER `DATABASE_URL` OR `TEST_DATABASE_URL` is set, so
    // forward the latter into the former before triggering the
    // dynamic import. Without this, a CI that only sets
    // `TEST_DATABASE_URL` would skip the gate (HAS_DB_URL=true) but
    // then crash on import. Idempotent (`??=`), so a real
    // `DATABASE_URL` is left untouched.
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

    // Pull the runtime modules in here, not at top-level. See the
    // comment on the `let withTestSchema/sweep` declarations for
    // why this matters (DATABASE_URL throw-on-import in @workspace/
    // db). Both modules export a stable surface so re-binding the
    // outer `let`s once per file is safe.
    const dbTesting = await import("@workspace/db/testing");
    withTestSchema = dbTesting.withTestSchema;
    const script = await import("../sweepOrphanAvatars");
    sweep = script.sweep;
  });

  it("deletes only orphaned uploads and leaves referenced ones intact", async () => {
    await withTestSchema(async (ctx) => {
      // Five users covering every avatar shape the script handles:
      //
      //  - canonical `/objects/<entityId>` — the post-upload form
      //  - legacy `https://storage.googleapis.com/...` URL inside
      //    our private dir — must be normalised, not skipped
      //  - NULL avatar_url — should not contribute any reference
      //  - external https URL — not an object we own, should not
      //    contribute and should not crash the sweep
      //  - malformed `/objects/` value (no entityId) — must be
      //    skipped without contributing or crashing
      //
      // Together these cover every branch in `avatarUrlToObjectName`
      // / `normalizeObjectEntityPath`. If a refactor drops one of
      // them and a real avatar gets misclassified as orphaned, this
      // test fails on the corresponding `existing()` assertion below.
      const referencedEntityA = "uploads/avatar-A-uuid";
      const referencedEntityB = "uploads/avatar-B-uuid";
      await seedUser(ctx, "u-canonical", `/objects/${referencedEntityA}`);
      await seedUser(
        ctx,
        "u-legacy-url",
        `https://storage.googleapis.com/test-bucket/private/${referencedEntityB}`,
      );
      await seedUser(ctx, "u-no-avatar", null);
      await seedUser(
        ctx,
        "u-external",
        "https://cdn.example.com/somebody-elses.png",
      );
      // `/objects/` with nothing after it — `avatarUrlToObjectName`
      // must return null, NOT throw. If a regression starts treating
      // this as a malformed-entity error and aborts the sweep, the
      // test fails on the thrown error below rather than on an
      // assertion.
      await seedUser(ctx, "u-malformed", "/objects/");

      const fake = createFakeStorage("test-bucket");
      // Two files actually referenced by users above — must survive.
      fake.seed(`private/${referencedEntityA}`);
      fake.seed(`private/${referencedEntityB}`);
      // Three uploads with no row pointing at them — these are the
      // genuine orphans the sweep was written to delete.
      fake.seed("private/uploads/orphan-1");
      fake.seed("private/uploads/orphan-2");
      fake.seed("private/uploads/orphan-3");
      // A file outside the `uploads/` prefix. The script restricts
      // its scan to `<dir>/uploads/` so this MUST NOT appear in the
      // bucket listing the sweep sees, and therefore MUST survive.
      // Guards against a regression that broadens the prefix.
      fake.seed("private/system/keep-me");

      const summary = await sweep(
        { dryRun: false },
        {
          storage: fake.storage,
          db: asSweepDb(ctx),
          privateDir: TEST_PRIVATE_DIR,
        },
      );

      expect(summary).toMatchObject({
        privateDir: TEST_PRIVATE_DIR,
        bucketName: "test-bucket",
        uploadsPrefix: UPLOADS_PREFIX,
        // Four rows had a non-null avatar_url (canonical, legacy,
        // external, malformed); only the canonical + legacy ones
        // resolve to objects we actually own.
        liveAvatarRows: 4,
        liveReferencedObjects: 2,
        // Five files live under `uploads/` (two referenced + three
        // orphans); the system file is outside the prefix so it
        // isn't scanned.
        bucketObjectsScanned: 5,
        orphans: 3,
        deleted: 3,
        failed: 0,
        dryRun: false,
      });

      // The real safety property: which bytes survived? Asserting
      // post-state (rather than just the tally) is what catches a
      // regression that miscounts but happens to delete the right
      // set, OR vice-versa. `existing()` returns names sorted, so
      // "system/" lexically precedes "uploads/".
      expect(fake.existing()).toEqual([
        "private/system/keep-me",
        `private/${referencedEntityA}`,
        `private/${referencedEntityB}`,
      ]);

      // Belt-and-braces: every delete went through the
      // `ignoreNotFound: true` path. If a refactor drops that
      // option, a parallel delete from the api-server's own
      // cleanup hook would start failing the sweep mid-run. Pinned
      // because the comment in the script promises this behaviour.
      const deleteCalls = fake.deleteCalls();
      expect(deleteCalls).toHaveLength(3);
      for (const call of deleteCalls) {
        expect(call.options?.ignoreNotFound).toBe(true);
        expect(call.objectName.startsWith(UPLOADS_PREFIX)).toBe(true);
      }
      expect(deleteCalls.map((c) => c.objectName).sort()).toEqual([
        "private/uploads/orphan-1",
        "private/uploads/orphan-2",
        "private/uploads/orphan-3",
      ]);
    });
  });

  it("dry-run reports orphans without issuing any deletes", async () => {
    await withTestSchema(async (ctx) => {
      // Single referenced + single orphan is enough — we're not
      // re-validating the URL-shape matrix here, just the dry-run
      // gate. The previous test covers shape coverage.
      await seedUser(ctx, "u-canonical", "/objects/uploads/avatar-A-uuid");

      const fake = createFakeStorage("test-bucket");
      fake.seed("private/uploads/avatar-A-uuid");
      fake.seed("private/uploads/orphan-x");

      const summary = await sweep(
        { dryRun: true },
        {
          storage: fake.storage,
          db: asSweepDb(ctx),
          privateDir: TEST_PRIVATE_DIR,
        },
      );

      expect(summary).toMatchObject({
        orphans: 1,
        // Dry-run MUST report the orphan but MUST NOT have deleted
        // anything. If a future refactor accidentally falls through
        // into the delete branch, `deleted` flips off zero and this
        // assertion catches it before the bucket suffers.
        deleted: 0,
        failed: 0,
        dryRun: true,
      });

      // The orphan is still in the bucket — the real "did we touch
      // anything?" check, since `summary.deleted` is just a counter
      // the script controls.
      expect(fake.existing()).toEqual([
        "private/uploads/avatar-A-uuid",
        "private/uploads/orphan-x",
      ]);
      expect(fake.deleteCalls()).toEqual([]);
    });
  });

  it("with no avatar rows, sweeps every uploads/ file but still respects the prefix boundary", async () => {
    // With zero user rows the referenced set is empty by definition,
    // so every file under `<dir>/uploads/` is fair game and the
    // sweep MUST delete them all — that's the documented behaviour
    // (it's how a fresh-install or fully-reset DB looks). The
    // safety property the test pins is the OTHER half: anything
    // outside the `uploads/` prefix is protected by the prefix
    // restriction, not by the referenced-set check, and MUST
    // survive even when the referenced set is empty. A regression
    // that broadens the scan beyond `uploads/` would pass an
    // orphan-counting test but fail this one.
    await withTestSchema(async (ctx) => {
      const fake = createFakeStorage("test-bucket");
      fake.seed("private/uploads/maybe-orphan");
      // System file outside `uploads/` MUST survive even when the
      // referenced set is empty — the prefix restriction is what
      // protects it, not the referenced-set check.
      fake.seed("private/system/keep-me");

      const summary = await sweep(
        { dryRun: false },
        {
          storage: fake.storage,
          db: asSweepDb(ctx),
          privateDir: TEST_PRIVATE_DIR,
        },
      );

      expect(summary).toMatchObject({
        liveAvatarRows: 0,
        liveReferencedObjects: 0,
        bucketObjectsScanned: 1,
        orphans: 1,
        deleted: 1,
      });
      expect(fake.existing()).toEqual(["private/system/keep-me"]);
    });
  });
});
