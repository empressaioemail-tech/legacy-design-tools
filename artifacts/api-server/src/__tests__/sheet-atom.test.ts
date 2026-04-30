/**
 * Sheet atom contract test.
 *
 * Wraps the framework's `runAtomContractTests` against `makeSheetAtom`.
 * The contract suite asserts the four-layer ContextSummary shape, the
 * default-mode/supported-modes invariant, composition resolution, and
 * inline-reference round-trip — see `runAtomContractTests` for the
 * exhaustive list of properties.
 *
 * Lifecycle: a single per-file Postgres schema is opened (`createTestSchema`),
 * an engagement + snapshot + sheet row is seeded, and the registration is
 * built against the test-schema `db`. The `@workspace/db` import is mocked
 * the same way `chat.test.ts` mocks it so the production code path
 * (including `getAtomRegistry`) actually reads from the test schema.
 */

import { describe, beforeAll, afterAll, vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("sheet-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, snapshots, sheets } = dbModule;
const { runAtomContractTests } = await import(
  "@workspace/empressa-atom/testing"
);
const { makeSheetAtom } = await import("../atoms/sheet.atom");

// Lazy `db` proxy: the `@workspace/db` mock above exposes `db` as a getter
// that throws while `ctx.schema` is null. Building the registration at
// describe-collection time would otherwise crash before `beforeAll` opens
// the schema. The Proxy forwards every property access (drizzle's
// `select`/`insert`/etc.) onto whatever `dbModule.db` resolves to at call
// time — by then the schema exists and the getter returns it.
const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

// A fixed UUID is used as the seed entityId so the contract suite calls
// `contextSummary(SHEET_ID, defaultScope())` against a row we know exists.
// The shape is whatever drizzle accepts for a uuid column — any RFC4122
// formatted string works.
const SHEET_ID = "11111111-1111-1111-1111-111111111111";
const SNAPSHOT_ID = "22222222-2222-2222-2222-222222222222";
const ENGAGEMENT_ID = "33333333-3333-3333-3333-333333333333";

// One-byte placeholder PNG payload — the contract suite only inspects the
// summary, never the bytes, so the smallest valid Buffer is enough to
// satisfy NOT NULL on `thumbnail_png` / `full_png`.
const TINY_PNG = Buffer.from([0]);

async function seedSheetRow(): Promise<void> {
  if (!ctx.schema) throw new Error("sheet-atom.test: ctx.schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Sheet Atom Contract",
    nameLower: "sheet-atom-contract",
    jurisdiction: "Moab, UT",
    address: "123 Atom Test Way",
  });
  await db.insert(snapshots).values({
    id: SNAPSHOT_ID,
    engagementId: ENGAGEMENT_ID,
    projectName: "Sheet Atom Contract",
    payload: { sheets: [], rooms: [] },
    sheetCount: 1,
    roomCount: 0,
    levelCount: 0,
    wallCount: 0,
  });
  await db.insert(sheets).values({
    id: SHEET_ID,
    snapshotId: SNAPSHOT_ID,
    engagementId: ENGAGEMENT_ID,
    sheetNumber: "A101",
    sheetName: "First Floor Plan",
    viewCount: 4,
    revisionNumber: "2",
    revisionDate: "2026-04-01",
    thumbnailPng: TINY_PNG,
    thumbnailWidth: 64,
    thumbnailHeight: 48,
    fullPng: TINY_PNG,
    fullWidth: 1024,
    fullHeight: 768,
    sortOrder: 0,
  });
}

describe("sheet atom (contract)", () => {
  // The contract suite is structured as a `describe` block emitted by
  // `runAtomContractTests`. Vitest discovers nested describes lazily, so
  // we open the schema, build the registration against the live test db,
  // and seed the row in `beforeAll` BEFORE invoking the helper. The
  // helper's per-test `setUp` (`fixture.setUp`) fires inside the `it`
  // body, after our beforeAll has already run.
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    await seedSheetRow();
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  // The registration captures the lazy `db` proxy declared at module
  // scope so contextSummary calls land on `ctx.schema.db` at runtime.
  const sheetAtom = makeSheetAtom({ db: lazyDb });

  runAtomContractTests(sheetAtom, {
    withFixture: { entityId: SHEET_ID },
  });
});
