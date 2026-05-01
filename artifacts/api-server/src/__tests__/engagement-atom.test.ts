/**
 * Engagement atom contract + behavior tests (sprint A3).
 *
 * Mirrors `sheet-atom.test.ts`'s lifecycle (per-file Postgres schema,
 * `vi.mock("@workspace/db")` proxying `db` onto the test schema's drizzle
 * instance, lazy `db` proxy so the registration can be built at module
 * scope without crashing the schema-not-yet-open getter).
 *
 * Coverage:
 *   - `runAtomContractTests` — four-layer shape, defaultMode/supportedModes,
 *     composition resolution, inline-reference round-trip,
 *   - composition resolution: an engagement seeded with N snapshot rows
 *     resolves to a `relatedAtoms` list of length N, each typed as
 *     `entityType: "snapshot"`,
 *   - scope-awareness: the same engagement id returns different prose for
 *     `defaultScope()` (internal) vs. a `user`-audience scope, and only
 *     the second sets `scopeFiltered: true`,
 *   - missing-jurisdiction: an engagement with `jurisdiction` /
 *     `jurisdictionCity` / `latitude` all null returns 200, the prose
 *     contains "jurisdiction not yet resolved", `keyMetrics` does not
 *     include a zoning entry, and the call does not throw,
 *   - not-found: a random uuid returns the not-found shape with
 *     `typed.found === false`.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("engagement-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema, truncateAll } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, snapshots } = dbModule;
const { runAtomContractTests, createInMemoryEventService } = await import(
  "@workspace/empressa-atom/testing"
);
const { createAtomRegistry, defaultScope } = await import(
  "@workspace/empressa-atom"
);
const { makeEngagementAtom } = await import("../atoms/engagement.atom");
const { makeSnapshotAtom } = await import("../atoms/snapshot.atom");
const { makeSheetAtom } = await import("../atoms/sheet.atom");
const { makeParcelBriefingAtom } = await import(
  "../atoms/parcel-briefing.atom"
);
const { makeIntentAtom } = await import("../atoms/intent.atom");
const { makeBriefingSourceAtom } = await import(
  "../atoms/briefing-source.atom"
);

// Lazy `db` proxy: same trick as `sheet-atom.test.ts`. The mock above
// throws at property-access time when `ctx.schema` is null, so building
// the registration at module collection time would crash before
// `beforeAll` opens the schema. The Proxy defers all access to runtime.
const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "44444444-4444-4444-4444-444444444444";

async function seedEngagement(): Promise<void> {
  if (!ctx.schema) throw new Error("engagement-atom.test: ctx.schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Engagement Atom Contract",
    nameLower: "engagement-atom-contract",
    jurisdiction: "Moab, UT",
    jurisdictionCity: "Moab",
    jurisdictionState: "UT",
    address: "456 Engagement Way",
    projectType: "Single-family residential",
    zoningCode: "R-1",
    lotAreaSqft: "8500",
    revitDocumentPath: "C:/Projects/EngagementAtomContract.rvt",
    revitCentralGuid: "00000000-aaaa-bbbb-cccc-000000000001",
  });
}

describe("engagement atom (contract)", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    await seedEngagement();
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  const engagementAtom = makeEngagementAtom({
    db: lazyDb,
    history: createInMemoryEventService(),
  });

  // The contract suite's `composition references resolve in the registry`
  // step needs every non-forward-ref child registered. Engagement's
  // composition (post-DA-PI-1) is:
  //   - snapshot (concrete) → snapshot in turn composes sheet
  //   - submission (forwardRef:true) → skipped by validate()
  //   - parcel-briefing (concrete, DA-PI-1) → parcel-briefing in turn
  //     composes intent + briefing-source as concrete children, plus
  //     forward-refs to parcel and code-section
  //
  // So the `alsoRegister` set has to be:
  //   sheet, snapshot, intent, briefing-source, parcel-briefing.
  // The forward-ref edges on parcel-briefing (parcel, code-section) and
  // briefing-source (parcel) are skipped by validate() — no stubs
  // needed for those.
  runAtomContractTests(engagementAtom, {
    withFixture: { entityId: ENGAGEMENT_ID },
    alsoRegister: [
      makeSheetAtom({ db: lazyDb }),
      makeSnapshotAtom({ db: lazyDb }),
      makeIntentAtom(),
      makeBriefingSourceAtom(),
      makeParcelBriefingAtom(),
    ],
  });
});

describe("engagement atom (behavior)", () => {
  beforeAll(async () => {
    if (!ctx.schema) ctx.schema = await createTestSchema();
  });

  beforeEach(async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    await truncateAll(ctx.schema.pool, ["engagements", "snapshots", "sheets"]);
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  it("composition resolution: relatedAtoms includes one snapshot reference per row", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Composition Test",
        nameLower: "composition-test",
        jurisdiction: "Moab, UT",
        address: "1 Snapshot Lane",
      })
      .returning({ id: engagements.id });
    const N = 3;
    for (let i = 0; i < N; i++) {
      await db.insert(snapshots).values({
        engagementId: eng.id,
        projectName: "Composition Test",
        payload: { sheets: [], rooms: [] },
        sheetCount: i + 1,
        roomCount: 0,
        levelCount: 0,
        wallCount: 0,
      });
    }

    // Build a real registry containing every non-forward-ref child the
    // engagement atom (post-DA-PI-1) and its transitive children
    // declare. The `submission` composition edge is `forwardRef: true`
    // and is deliberately left absent — the resolver must produce zero
    // submission children (because `parentData` has no `submissions`
    // key) without the boot validator complaining either. The
    // `parcel-briefing` edge (DA-PI-1, concrete) similarly produces
    // zero children at lookup time because `parentData` has no
    // `activeBriefing` key — the data engine that populates it ships
    // in DA-PI-3.
    const registry = createAtomRegistry();
    registry.register(makeSheetAtom({ db: lazyDb }));
    registry.register(makeSnapshotAtom({ db: lazyDb }));
    registry.register(makeIntentAtom());
    registry.register(makeBriefingSourceAtom());
    registry.register(makeParcelBriefingAtom());
    const atom = makeEngagementAtom({ db: lazyDb, registry });
    registry.register(atom);
    // Sanity: validate must succeed with the forward-ref `submission`
    // edge present and `submission` deliberately absent.
    expect(registry.validate().ok).toBe(true);

    const summary = await atom.contextSummary(eng.id, defaultScope());

    expect(summary.relatedAtoms).toHaveLength(N);
    for (const ref of summary.relatedAtoms) {
      expect(ref.kind).toBe("atom");
      expect(ref.entityType).toBe("snapshot");
      // `resolveComposition` tags each child with the composition edge's
      // `childMode`, which is `"compact"` for the snapshot edge.
      expect(ref.mode).toBe("compact");
      expect(typeof ref.entityId).toBe("string");
      expect(ref.entityId.length).toBeGreaterThan(0);
    }
    // Sheet count tile sums sheetCount across snapshots: 1 + 2 + 3 = 6.
    const sheetMetric = summary.keyMetrics.find(
      (m) => m.label === "Sheet count",
    );
    expect(sheetMetric?.value).toBe(6);
    const snapshotMetric = summary.keyMetrics.find(
      (m) => m.label === "Snapshots",
    );
    expect(snapshotMetric?.value).toBe(N);
  });

  it("scope-awareness: user-audience differs from internal and sets scopeFiltered", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Scope Test",
        nameLower: "scope-test",
        jurisdiction: "Moab, UT",
        address: "1 Scope Way",
        projectType: "Mixed-use",
        revitDocumentPath: "C:/Projects/ScopeTest.rvt",
        revitCentralGuid: "11111111-aaaa-bbbb-cccc-000000000002",
      })
      .returning({ id: engagements.id });

    const atom = makeEngagementAtom({ db: lazyDb });
    const internal = await atom.contextSummary(eng.id, defaultScope());
    const user = await atom.contextSummary(eng.id, {
      audience: "user",
      requestor: { kind: "user", id: "applicant-x" },
    });

    expect(internal.scopeFiltered).toBe(false);
    expect(user.scopeFiltered).toBe(true);
    expect(internal.prose).not.toBe(user.prose);
    // Internal prose surfaces the Revit doc path; user prose must not.
    expect(internal.prose).toContain("ScopeTest.rvt");
    expect(user.prose).not.toContain("ScopeTest.rvt");
    // Internal payload exposes Revit binding fields; user payload omits them.
    expect(internal.typed.revitDocumentPath).toBe("C:/Projects/ScopeTest.rvt");
    expect(user.typed.revitDocumentPath).toBeUndefined();
    expect(user.typed.revitCentralGuid).toBeUndefined();
  });

  it("missing jurisdiction degrades gracefully", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Balsley Stand-In",
        nameLower: "balsley-stand-in",
        jurisdiction: null,
        jurisdictionCity: null,
        jurisdictionState: null,
        latitude: null,
        longitude: null,
        address: "Unknown",
        // zoningCode intentionally null so we can assert it's omitted.
        zoningCode: null,
      })
      .returning({ id: engagements.id });

    const atom = makeEngagementAtom({ db: lazyDb });
    const summary = await atom.contextSummary(eng.id, defaultScope());

    expect(summary.typed.found).toBe(true);
    expect(summary.prose).toContain("jurisdiction not yet resolved");
    const zoningMetric = summary.keyMetrics.find((m) => m.label === "Zoning");
    expect(zoningMetric).toBeUndefined();
  });

  it("not-found returns the structural shape with typed.found=false", async () => {
    const atom = makeEngagementAtom({ db: lazyDb });
    const summary = await atom.contextSummary(
      "00000000-0000-0000-0000-000000000000",
      defaultScope(),
    );
    expect(summary.typed).toEqual({
      id: "00000000-0000-0000-0000-000000000000",
      found: false,
    });
    expect(summary.relatedAtoms).toEqual([]);
    expect(summary.keyMetrics).toEqual([]);
    expect(summary.prose).toContain("could not be found");
    expect(summary.scopeFiltered).toBe(false);
  });
});
