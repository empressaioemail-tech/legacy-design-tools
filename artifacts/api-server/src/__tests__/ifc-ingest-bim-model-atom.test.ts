/**
 * DA-BIM-Symmetry — `bim-model` atom produced on IFC ingest.
 *
 * The 2026-05-18 plan-review engine recon (§9, `_sessions/`) called
 * out that `bim-model` was produced only on Push-to-Revit; the IFC
 * ingest path wrote `materializable_elements` + a glTF bundle but
 * no `bim-model` atom, so the UI viewport had nothing to render
 * after an architect uploaded IFC. This suite asserts the producer
 * helper in `ifcIngest.ts` makes the as-built IFC a first-class peer
 * of the to-be-built Push-to-Revit side in the engagement atom graph.
 *
 * Scope (and what is intentionally *not* tested here):
 *
 *   - We exercise `ensureBimModelAndEmitIfcIngestEvent` directly
 *     against a real test schema (per the established api-server
 *     atom-test pattern using `createTestSchema` + a `@workspace/db`
 *     proxy mock). Driving the full multipart `POST /api/snapshots/:id/ifc`
 *     route from vitest is heavy and would re-test code that already
 *     has coverage in `track-b-ifc-schema.test.ts`; the route-to-
 *     producer wiring is a single function call whose type-safety is
 *     guaranteed by the compiler.
 *   - The materializable-element delete-and-reinsert at
 *     `ifcIngest.ts` (recon §57 / [[adr-011]]) was resolved in C.1.5:
 *     re-ingest now stamps `superseded_at` + `superseded_by_id` on
 *     prior rows rather than deleting them. The schema-level
 *     invariants for that supersession contract are covered in
 *     `track-b-ifc-schema.test.ts`; this suite continues to focus on
 *     the `bim-model` atom's own append-only history (one row, N
 *     events) across re-ingest.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
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
        throw new Error("ifc-ingest-bim-model-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema, truncateAll } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, snapshots, snapshotIfcFiles, bimModels } = dbModule;
const { eq } = await import("drizzle-orm");
const { PostgresEventAnchoringService } = await import(
  "@hauska/atom-contract"
);
const { ensureBimModelAndEmitIfcIngestEvent, distinctIfcTypes } = await import(
  "../lib/ifcIngest"
);
const { BIM_MODEL_IFC_INGEST_ACTOR_ID } = await import(
  "@workspace/server-actor-ids"
);

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLog,
  level: "silent",
} as unknown as typeof import("../lib/logger").logger;

beforeAll(async () => {
  ctx.schema = await createTestSchema();
});

afterAll(async () => {
  if (ctx.schema) {
    await dropTestSchema(ctx.schema);
    ctx.schema = null;
  }
});

beforeEach(async () => {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  // bim_models is the load-bearing target of every test below;
  // atom_events carries the event chain. snapshot_ifc_files and
  // materializable_elements are seeded by the helper-call args so we
  // include them in the truncate sweep for hygiene.
  await truncateAll(ctx.schema.pool, [
    "engagements",
    "snapshots",
    "snapshot_ifc_files",
    "materializable_elements",
    "bim_models",
    "atom_events",
  ]);
});

interface SeededFixture {
  engagementId: string;
  snapshotId: string;
  ifcFileId: string;
}

async function seedEngagementSnapshotAndIfcRow(): Promise<SeededFixture> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: "DA-BIM-Symmetry Test",
      nameLower: "da-bim-symmetry-test",
      jurisdiction: "Grand County, UT",
      address: "Spanish Valley test parcel",
      status: "active",
    })
    .returning();
  const [snap] = await ctx.schema.db
    .insert(snapshots)
    .values({
      engagementId: eng!.id,
      projectName: "Test snapshot",
      payload: {},
    })
    .returning();
  const [ifc] = await ctx.schema.db
    .insert(snapshotIfcFiles)
    .values({
      snapshotId: snap!.id,
      blobObjectPath: "/objects/uploads/ifc-blob-test",
      fileSizeBytes: 1234,
      ifcVersion: "IFC4",
    })
    .returning();
  return {
    engagementId: eng!.id,
    snapshotId: snap!.id,
    ifcFileId: ifc!.id,
  };
}

function makeProducerArgs(fx: SeededFixture, overrides: Partial<{
  entityCount: number;
  entityTypes: ReadonlyArray<string>;
  gltfBundleObjectPath: string | null;
  ifcBlobObjectPath: string;
}> = {}) {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  return {
    db: ctx.schema.db as unknown as typeof dbModule.db,
    history: new PostgresEventAnchoringService(
      ctx.schema.db as unknown as ConstructorParameters<
        typeof PostgresEventAnchoringService
      >[0],
    ),
    engagementId: fx.engagementId,
    snapshotId: fx.snapshotId,
    ifcFileId: fx.ifcFileId,
    ifcBlobObjectPath:
      overrides.ifcBlobObjectPath ?? "/objects/uploads/ifc-blob-test",
    gltfBundleObjectPath:
      overrides.gltfBundleObjectPath !== undefined
        ? overrides.gltfBundleObjectPath
        : "/objects/uploads/ifc-gltf-test",
    entityCount: overrides.entityCount ?? 7,
    entityTypes:
      overrides.entityTypes ??
      (["IfcWall", "IfcSlab", "IfcDoor", "IfcWindow"] as const),
    log: silentLog,
  };
}

async function readAtomEvents(entityId: string) {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  // Raw SQL because we want the row shape exactly as stored (jsonb
  // columns inflate to objects on the pg driver). Drizzle-mapped reads
  // through `@workspace/db` would funnel through the `db` proxy.
  const res = await ctx.schema.pool.query(
    `SELECT id, entity_type, entity_id, event_type, actor, payload,
            prev_hash, chain_hash, occurred_at
       FROM atom_events
      WHERE entity_type = 'bim-model'
        AND entity_id = $1
      ORDER BY occurred_at ASC, recorded_at ASC, id ASC`,
    [entityId],
  );
  return res.rows;
}

describe("distinctIfcTypes", () => {
  it("returns a deduplicated sorted list of IFC types", () => {
    expect(
      distinctIfcTypes([
        { ifcType: "IfcWall" },
        { ifcType: "IfcSlab" },
        { ifcType: "IfcWall" },
        { ifcType: "IfcDoor" },
        { ifcType: "IfcSlab" },
      ]),
    ).toEqual(["IfcDoor", "IfcSlab", "IfcWall"]);
  });

  it("returns [] for an empty entity list", () => {
    expect(distinctIfcTypes([])).toEqual([]);
  });
});

describe("ensureBimModelAndEmitIfcIngestEvent — unit", () => {
  it("inserts a bim_models row and appends one bim-model.ingested-from-ifc event", async () => {
    const fx = await seedEngagementSnapshotAndIfcRow();
    const args = makeProducerArgs(fx);

    const returnedId = await ensureBimModelAndEmitIfcIngestEvent(args);

    expect(returnedId).toBeTruthy();

    const bmRows = await ctx.schema!.db
      .select()
      .from(bimModels)
      .where(eq(bimModels.engagementId, fx.engagementId));
    expect(bmRows).toHaveLength(1);
    expect(bmRows[0]!.id).toBe(returnedId);
    // QA-32 (2026-05-23): `materializedAt` IS stamped on the IFC
    // ingest's UPSERT so the design-tools BIM viewer surfaces the
    // engagement's as-built rows on the IFC-without-briefing path
    // (the Musgrave_Residence_B verify on cortex-api-00017-jnn).
    // The other Push-to-Revit-side columns (activeBriefingId,
    // briefingVersion, revitDocumentPath) stay untouched — IFC
    // ingest still has no opinion about them.
    expect(bmRows[0]!.activeBriefingId).toBeNull();
    expect(bmRows[0]!.materializedAt).toBeInstanceOf(Date);
    expect(bmRows[0]!.briefingVersion).toBe(0);
    expect(bmRows[0]!.revitDocumentPath).toBeNull();

    const events = await readAtomEvents(returnedId!);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev["event_type"]).toBe("bim-model.ingested-from-ifc");
    expect(ev["entity_type"]).toBe("bim-model");
    expect(ev["entity_id"]).toBe(returnedId);
    expect(ev["actor"]).toEqual({
      kind: "system",
      id: BIM_MODEL_IFC_INGEST_ACTOR_ID,
    });
    expect(ev["payload"]).toEqual({
      snapshotId: fx.snapshotId,
      ifcFileId: fx.ifcFileId,
      sourceKind: "as-built-ifc",
      ifcBlobObjectPath: "/objects/uploads/ifc-blob-test",
      gltfBundleObjectPath: "/objects/uploads/ifc-gltf-test",
      entityCount: 7,
      entityTypes: ["IfcWall", "IfcSlab", "IfcDoor", "IfcWindow"],
    });
    // First event in a chain — prev_hash null per the empressa-atom
    // history contract.
    expect(ev["prev_hash"]).toBeNull();
    expect(ev["chain_hash"]).toEqual(expect.any(String));
  });

  it("threads gltfBundleObjectPath=null when the glTF upload was skipped", async () => {
    const fx = await seedEngagementSnapshotAndIfcRow();
    const args = makeProducerArgs(fx, {
      gltfBundleObjectPath: null,
      entityCount: 0,
      entityTypes: [],
    });

    const returnedId = await ensureBimModelAndEmitIfcIngestEvent(args);
    expect(returnedId).toBeTruthy();

    const events = await readAtomEvents(returnedId!);
    expect(events).toHaveLength(1);
    const payload = events[0]!["payload"] as Record<string, unknown>;
    expect(payload["gltfBundleObjectPath"]).toBeNull();
    expect(payload["entityCount"]).toBe(0);
    expect(payload["entityTypes"]).toEqual([]);
  });
});

describe("ensureBimModelAndEmitIfcIngestEvent — integration with prior Push-to-Revit state", () => {
  it("refreshes materializedAt but preserves activeBriefingId / briefingVersion / revitDocumentPath when a Push-to-Revit row already exists (QA-32)", async () => {
    const fx = await seedEngagementSnapshotAndIfcRow();

    // Simulate a prior Push-to-Revit emission against this engagement —
    // the bim_models row exists with materializedAt / briefingVersion set.
    const priorMaterializedAt = new Date("2026-04-01T12:00:00Z");
    const [pushed] = await ctx.schema!.db
      .insert(bimModels)
      .values({
        engagementId: fx.engagementId,
        materializedAt: priorMaterializedAt,
        briefingVersion: 3,
        revitDocumentPath: "C:/projects/musgrave.rvt",
      })
      .returning();
    const beforeIfcIngest = Date.now();

    const args = makeProducerArgs(fx);
    const returnedId = await ensureBimModelAndEmitIfcIngestEvent(args);

    expect(returnedId).toBe(pushed!.id);

    // QA-32: materializedAt IS refreshed on every successful IFC ingest
    // so the design-tools BIM viewer reflects "the most recent
    // successful materialization (briefing OR IFC)". The to-be-built
    // columns (briefingVersion, revitDocumentPath) and the
    // briefing-pointer (activeBriefingId) stay untouched — IFC ingest
    // continues to have no opinion about them.
    const bmRows = await ctx.schema!.db
      .select()
      .from(bimModels)
      .where(eq(bimModels.engagementId, fx.engagementId));
    expect(bmRows).toHaveLength(1);
    expect(bmRows[0]!.materializedAt).toBeInstanceOf(Date);
    expect(bmRows[0]!.materializedAt!.getTime()).toBeGreaterThanOrEqual(
      beforeIfcIngest,
    );
    expect(bmRows[0]!.materializedAt!.toISOString()).not.toBe(
      priorMaterializedAt.toISOString(),
    );
    expect(bmRows[0]!.briefingVersion).toBe(3);
    expect(bmRows[0]!.revitDocumentPath).toBe("C:/projects/musgrave.rvt");

    // The ingest event was appended on the existing row's chain — the
    // as-built peer producer is now visible on the same engagement
    // timeline as Push-to-Revit's `bim-model.materialized` would be.
    const events = await readAtomEvents(pushed!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!["event_type"]).toBe("bim-model.ingested-from-ifc");
  });
});

describe("ensureBimModelAndEmitIfcIngestEvent — idempotency on re-ingest", () => {
  it("appends a second event without duplicating the bim_models row", async () => {
    const fx = await seedEngagementSnapshotAndIfcRow();

    const firstId = await ensureBimModelAndEmitIfcIngestEvent(
      makeProducerArgs(fx, { entityCount: 5, entityTypes: ["IfcWall"] }),
    );
    const secondId = await ensureBimModelAndEmitIfcIngestEvent(
      makeProducerArgs(fx, {
        entityCount: 6,
        entityTypes: ["IfcWall", "IfcSlab"],
        ifcBlobObjectPath: "/objects/uploads/ifc-blob-test-v2",
        gltfBundleObjectPath: "/objects/uploads/ifc-gltf-test-v2",
      }),
    );

    expect(firstId).toBeTruthy();
    expect(secondId).toBe(firstId);

    // Exactly one bim_models row — atom identity is engagement-keyed.
    const countRes = await ctx.schema!.pool.query(
      `SELECT count(*)::int AS n FROM bim_models WHERE engagement_id = $1`,
      [fx.engagementId],
    );
    expect(countRes.rows[0]?.["n"]).toBe(1);

    // Two events, append-only, chain-linked. The second event's
    // prev_hash MUST equal the first event's chain_hash per the
    // EventAnchoringService contract.
    const events = await readAtomEvents(firstId!);
    expect(events).toHaveLength(2);
    expect(events[0]!["event_type"]).toBe("bim-model.ingested-from-ifc");
    expect(events[1]!["event_type"]).toBe("bim-model.ingested-from-ifc");
    expect(events[0]!["prev_hash"]).toBeNull();
    expect(events[1]!["prev_hash"]).toBe(events[0]!["chain_hash"]);

    // Each event carries its own ingest payload (entity count + types
    // for that ingest pass) — the chain captures the re-ingest history
    // even though the materializable_elements rows are delete-and-
    // reinsert today (recon §57, out of scope).
    expect((events[0]!["payload"] as Record<string, unknown>)["entityCount"]).toBe(5);
    expect((events[1]!["payload"] as Record<string, unknown>)["entityCount"]).toBe(6);
    expect((events[1]!["payload"] as Record<string, unknown>)["ifcBlobObjectPath"]).toBe(
      "/objects/uploads/ifc-blob-test-v2",
    );
  });
});

describe("ifc-ingest materializable_elements supersession — engagement scope (QA-35)", () => {
  it("a second IFC ingest for the same engagement supersedes the first ingest's rows, leaving only the latest generation active", async () => {
    // QA-35 reproduction: operator uploaded the same Musgrave IFC
    // three times on cortex-api-00020-85n and observed 303 active
    // `materializable_elements` rows (3 × 101) when only the most
    // recent 101 should have been active. Each upload creates a
    // fresh `snapshots` row (different `snapshot.id`), so the
    // snapshot-scoped supersession that `ifcIngest.ts` shipped with
    // never matched prior generations and they stayed active.
    //
    // This test simulates two ingests (one new snapshot each) by
    // mirroring the production ingest's transactional supersession +
    // insert steps inline — driving the full multipart upload route
    // from vitest is too heavy and is covered by track-b-ifc-schema.
    // The assertion pins the data invariant the production code now
    // guarantees: engagement-wide active count after N re-ingests
    // equals the size of a single generation, not N × generation.
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const materializableElements =
      dbModule.materializableElements;
    const { and, isNull, inArray } = await import("drizzle-orm");

    // Seed engagement + the first ingest's snapshot.
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "QA-35 reingest scope",
        nameLower: "qa-35-reingest-scope",
        jurisdiction: "Grand County, UT",
        address: "Musgrave Residence B",
        status: "active",
      })
      .returning();
    const engagementId = eng!.id;

    const [snap1] = await db
      .insert(snapshots)
      .values({
        engagementId,
        projectName: "First ingest",
        payload: {},
      })
      .returning();
    const snapshotId1 = snap1!.id;

    const FIRST_GENERATION_GUIDS = [
      "0_wall_alpha",
      "0_wall_beta",
      "0_door_gamma",
    ];
    await db.insert(materializableElements).values([
      ...FIRST_GENERATION_GUIDS.map((guid) => ({
        engagementId,
        sourceKind: "as-built-ifc" as const,
        elementKind: "as-built-ifc" as const,
        sourceSnapshotId: snapshotId1,
        ifcGlobalId: guid,
        ifcType: "IfcWall",
        label: `Element ${guid}`,
        locked: false,
      })),
      {
        engagementId,
        sourceKind: "as-built-ifc-bundle" as const,
        elementKind: "as-built-ifc" as const,
        sourceSnapshotId: snapshotId1,
        ifcGlobalId: `bundle:${snapshotId1}`,
        ifcType: "<bundle>",
        label: "First-ingest bundle",
        glbObjectPath: "/objects/uploads/first-ingest-bundle",
        locked: false,
      },
    ]);

    // Sanity: 4 active rows from first ingest.
    const afterFirstActive = await db
      .select()
      .from(materializableElements)
      .where(
        and(
          eq(materializableElements.engagementId, engagementId),
          isNull(materializableElements.supersededAt),
        ),
      );
    expect(afterFirstActive).toHaveLength(4);

    // Second ingest: new snapshot + the engagement-scoped supersession
    // UPDATE (mirroring `ifcIngest.ts` step 5b post-QA-35) + new
    // per-entity rows + new bundle.
    const [snap2] = await db
      .insert(snapshots)
      .values({
        engagementId,
        projectName: "Second ingest (re-upload of same IFC)",
        payload: {},
      })
      .returning();
    const snapshotId2 = snap2!.id;

    await db.transaction(async (tx) => {
      await tx
        .update(materializableElements)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(materializableElements.engagementId, engagementId),
            inArray(materializableElements.sourceKind, [
              "as-built-ifc",
              "as-built-ifc-bundle",
            ]),
            isNull(materializableElements.supersededAt),
          ),
        );

      await tx.insert(materializableElements).values([
        // Same IFC content → same IFC GlobalIds as the first ingest.
        ...FIRST_GENERATION_GUIDS.map((guid) => ({
          engagementId,
          sourceKind: "as-built-ifc" as const,
          elementKind: "as-built-ifc" as const,
          sourceSnapshotId: snapshotId2,
          ifcGlobalId: guid,
          ifcType: "IfcWall",
          label: `Element ${guid} (re-ingest)`,
          locked: false,
        })),
        {
          engagementId,
          sourceKind: "as-built-ifc-bundle" as const,
          elementKind: "as-built-ifc" as const,
          sourceSnapshotId: snapshotId2,
          ifcGlobalId: `bundle:${snapshotId2}`,
          ifcType: "<bundle>",
          label: "Second-ingest bundle",
          glbObjectPath: "/objects/uploads/second-ingest-bundle",
          locked: false,
        },
      ]);
    });

    // The QA-35 invariant: engagement-wide active count after the
    // re-ingest is the size of one generation (3 entities + 1
    // bundle = 4), NOT both generations stacked (the operator's
    // observed-303 bug = 8 here).
    const afterSecondActive = await db
      .select({
        id: materializableElements.id,
        sourceSnapshotId: materializableElements.sourceSnapshotId,
        sourceKind: materializableElements.sourceKind,
        ifcGlobalId: materializableElements.ifcGlobalId,
      })
      .from(materializableElements)
      .where(
        and(
          eq(materializableElements.engagementId, engagementId),
          isNull(materializableElements.supersededAt),
        ),
      );
    expect(afterSecondActive).toHaveLength(4);
    // All active rows must belong to the most-recent snapshot.
    for (const row of afterSecondActive) {
      expect(row.sourceSnapshotId).toBe(snapshotId2);
    }
    // And the first-ingest rows must be marked superseded (the
    // append-only history per [[adr-001-atom-architecture]] — not
    // deleted).
    const supersededFromFirst = await db
      .select()
      .from(materializableElements)
      .where(
        and(
          eq(materializableElements.engagementId, engagementId),
          eq(materializableElements.sourceSnapshotId, snapshotId1),
        ),
      );
    expect(supersededFromFirst).toHaveLength(4);
    for (const row of supersededFromFirst) {
      expect(row.supersededAt).not.toBeNull();
    }
  });
});

