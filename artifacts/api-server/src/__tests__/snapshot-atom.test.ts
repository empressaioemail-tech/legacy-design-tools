/**
 * Snapshot atom contract test (A2 sprint).
 *
 * Two suites in this file:
 *   1. The framework's `runAtomContractTests` against `makeSnapshotAtom`,
 *      with `alsoRegister: [makeSheetAtom(...)]` so the contract suite's
 *      composition-resolution validation finds `sheet` and passes.
 *   2. Composition resolution cases that the contract suite doesn't
 *      cover: a snapshot with two child sheets must surface both as
 *      `relatedAtoms`; a snapshot with zero sheets must return an empty
 *      array (not undefined, not throw); an unknown id must return
 *      `typed.found: false` rather than throwing.
 *
 * Lifecycle mirrors `sheet-atom.test.ts`: one per-file Postgres schema,
 * `vi.mock("@workspace/db")` proxies `db` to the test schema's drizzle
 * instance, and the registry is built lazily so contextSummary calls
 * read from the live test schema.
 */

import { describe, beforeAll, afterAll, it, expect, vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("snapshot-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, snapshots, sheets } = dbModule;
const { runAtomContractTests, createTestRegistry } = await import(
  "@workspace/empressa-atom/testing"
);
const { createAtomRegistry } = await import("@workspace/empressa-atom");
const { makeSheetAtom } = await import("../atoms/sheet.atom");
const { makeSnapshotAtom, SNAPSHOT_EVENT_TYPES } = await import(
  "../atoms/snapshot.atom"
);

// Lazy `db` proxy — same pattern as sheet-atom.test.ts. Atom factories
// are constructed at module scope so we need a placeholder that defers
// every drizzle property access until `ctx.schema` is populated by
// `beforeAll`.
const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "44444444-4444-4444-4444-444444444444";
const SNAPSHOT_ID = "55555555-5555-5555-5555-555555555555";
const SHEET_ID_A = "66666666-6666-6666-6666-666666666661";
const SHEET_ID_B = "66666666-6666-6666-6666-666666666662";
const EMPTY_SNAPSHOT_ID = "77777777-7777-7777-7777-777777777777";

const TINY_PNG = Buffer.from([0]);

async function seedSnapshotWithTwoSheets(): Promise<void> {
  if (!ctx.schema) throw new Error("snapshot-atom.test: ctx.schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Snapshot Atom Contract",
    nameLower: "snapshot-atom-contract",
    jurisdiction: "Moab, UT",
    address: "9 Snapshot Way",
    revitCentralGuid: "CONTRACT-GUID",
    revitDocumentPath: "/contract/path.rvt",
  });
  await db.insert(snapshots).values({
    id: SNAPSHOT_ID,
    engagementId: ENGAGEMENT_ID,
    projectName: "Snapshot Atom Contract",
    payload: { sheets: [], rooms: [] },
    sheetCount: 2,
    roomCount: 0,
    levelCount: 1,
    wallCount: 12,
  });
  await db.insert(sheets).values([
    {
      id: SHEET_ID_A,
      snapshotId: SNAPSHOT_ID,
      engagementId: ENGAGEMENT_ID,
      sheetNumber: "A101",
      sheetName: "First Floor",
      viewCount: 3,
      revisionNumber: null,
      revisionDate: null,
      thumbnailPng: TINY_PNG,
      thumbnailWidth: 64,
      thumbnailHeight: 48,
      fullPng: TINY_PNG,
      fullWidth: 1024,
      fullHeight: 768,
      sortOrder: 0,
    },
    {
      id: SHEET_ID_B,
      snapshotId: SNAPSHOT_ID,
      engagementId: ENGAGEMENT_ID,
      sheetNumber: "A102",
      sheetName: "Second Floor",
      viewCount: 2,
      revisionNumber: null,
      revisionDate: null,
      thumbnailPng: TINY_PNG,
      thumbnailWidth: 64,
      thumbnailHeight: 48,
      fullPng: TINY_PNG,
      fullWidth: 1024,
      fullHeight: 768,
      sortOrder: 1,
    },
  ]);

  // Also seed a snapshot with no child sheets so the empty-composition
  // case has a stable id to look up.
  await db.insert(snapshots).values({
    id: EMPTY_SNAPSHOT_ID,
    engagementId: ENGAGEMENT_ID,
    projectName: "Snapshot Atom Contract (empty)",
    payload: { sheets: [] },
    sheetCount: 0,
    roomCount: null,
    levelCount: null,
    wallCount: null,
  });
}

describe("snapshot atom (contract)", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    await seedSnapshotWithTwoSheets();
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  // No `registry` dep here: the contract suite calls contextSummary
  // exactly once with `defaultScope()` and only inspects the four-layer
  // shape, not composition contents. Composition resolution is exercised
  // separately below where we hand-build a registry containing both atoms.
  const snapshotAtom = makeSnapshotAtom({ db: lazyDb });

  runAtomContractTests(snapshotAtom, {
    withFixture: { entityId: SNAPSHOT_ID },
    // `alsoRegister` is required so the contract suite's
    // `composition references resolve in the registry` assertion finds
    // the `sheet` child registration. Without it that step would fail.
    alsoRegister: [makeSheetAtom({ db: lazyDb })],
  });
});

describe("snapshot atom (composition + behavior)", () => {
  beforeAll(async () => {
    if (!ctx.schema) {
      ctx.schema = await createTestSchema();
      await seedSnapshotWithTwoSheets();
    }
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  it("resolves child sheet references via composition (two children)", async () => {
    // Build a real registry containing both atoms and pass it as the
    // snapshot's registry view, so `resolveComposition` finds `sheet`
    // at lookup time.
    const registry = createAtomRegistry();
    registry.register(makeSheetAtom({ db: lazyDb }));
    const snapshotAtom = makeSnapshotAtom({ db: lazyDb, registry });
    registry.register(snapshotAtom);

    const summary = await snapshotAtom.contextSummary(SNAPSHOT_ID, {
      audience: "internal",
    });

    // First related atom is the engagement parent ref; the rest are the
    // sheet children resolved by the framework. Two child sheets exist.
    expect(summary.relatedAtoms.length).toBe(3);
    expect(summary.relatedAtoms[0]).toMatchObject({
      kind: "atom",
      entityType: "engagement",
      entityId: ENGAGEMENT_ID,
    });
    const sheetRefs = summary.relatedAtoms.slice(1);
    const ids = sheetRefs.map((r) => r.entityId).sort();
    expect(ids).toEqual([SHEET_ID_A, SHEET_ID_B].sort());
    for (const ref of sheetRefs) {
      expect(ref.entityType).toBe("sheet");
      // The `childMode` on the composition edge is `compact`, so the
      // resolver tags every synthesized reference with that mode.
      expect(ref.mode).toBe("compact");
    }

    // Sanity: the typed payload + prose carry the engagement / project
    // identity so this isn't a degenerate empty render.
    expect(summary.typed.found).toBe(true);
    expect(summary.typed.engagementId).toBe(ENGAGEMENT_ID);
    expect(summary.prose).toContain("Snapshot Atom Contract");
    // Counts from the seeded row should appear as keyMetrics.
    const metricLabels = summary.keyMetrics.map((m) => m.label);
    expect(metricLabels).toContain("Sheets");
    expect(metricLabels).toContain("Levels");
    expect(metricLabels).toContain("Walls");
  });

  it("returns relatedAtoms with only the engagement parent when the snapshot has zero child sheets", async () => {
    const registry = createAtomRegistry();
    registry.register(makeSheetAtom({ db: lazyDb }));
    const snapshotAtom = makeSnapshotAtom({ db: lazyDb, registry });
    registry.register(snapshotAtom);

    const summary = await snapshotAtom.contextSummary(EMPTY_SNAPSHOT_ID, {
      audience: "internal",
    });

    // Empty composition → engagement parent only, no sheet children.
    // The brief specifies the array must be present (not undefined) and
    // contextSummary must not throw.
    expect(Array.isArray(summary.relatedAtoms)).toBe(true);
    expect(summary.relatedAtoms).toHaveLength(1);
    expect(summary.relatedAtoms[0]).toMatchObject({
      kind: "atom",
      entityType: "engagement",
      entityId: ENGAGEMENT_ID,
    });

    // Null counts on the row are omitted from keyMetrics rather than
    // emitted as `value: null`.
    const labels = summary.keyMetrics.map((m) => m.label);
    expect(labels).toContain("Sheets");
    expect(labels).not.toContain("Levels");
    expect(labels).not.toContain("Rooms");
    expect(labels).not.toContain("Walls");
  });

  it("returns typed.found=false for an unknown snapshot id rather than throwing", async () => {
    // Even with no registry passed in, the not-found branch must not
    // touch composition at all and must return a 200-shape envelope.
    const snapshotAtom = makeSnapshotAtom({ db: lazyDb });
    const summary = await snapshotAtom.contextSummary(
      "00000000-0000-0000-0000-000000000000",
      { audience: "internal" },
    );
    expect(summary.typed).toEqual({
      id: "00000000-0000-0000-0000-000000000000",
      found: false,
    });
    expect(summary.relatedAtoms).toEqual([]);
    expect(summary.keyMetrics).toEqual([]);
    expect(typeof summary.historyProvenance.latestEventAt).toBe("string");
    expect(summary.historyProvenance.latestEventId).toBe("");
  });

  it("declares the snapshot.* event vocabulary as a stable export", () => {
    // Framework gap: `AtomRegistration` has no `emits`/`eventTypes`
    // field yet, so we expose declared event types as an exported const
    // until the framework grows that surface (see Phase 4 report).
    expect(SNAPSHOT_EVENT_TYPES).toEqual([
      "snapshot.created",
      "snapshot.received",
      "snapshot.referenced-in-submission",
    ]);
  });

  it("describeForPrompt advertises both sheet and snapshot after registration", () => {
    // Sanity check that the chat path's `describeForPrompt()` call sees
    // both atoms in the vocabulary it returns to the prompt builder.
    const registry = createTestRegistry([
      makeSheetAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
    ]);
    const desc = registry.describeForPrompt();
    const types = desc.map((d) => d.entityType).sort();
    expect(types).toEqual(["sheet", "snapshot"]);
    const snap = desc.find((d) => d.entityType === "snapshot");
    expect(snap?.composes).toEqual(["sheet"]);
  });
});
