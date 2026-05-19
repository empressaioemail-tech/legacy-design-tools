/**
 * Track B sprint — schema invariant tests for materializable_elements
 * and snapshot_ifc_files.
 *
 * Verifies the CHECK constraints at the DB level:
 *   - source_kind is one of the closed tuple
 *   - briefing-derived rows must have briefing_id
 *   - as-built-ifc / as-built-ifc-bundle rows must have
 *     source_snapshot_id + engagement_id + ifc_global_id + ifc_type
 * Plus the snapshot_ifc_files unique constraint on snapshot_id.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  createTestSchema,
  dropTestSchema,
  truncateAll,
  type TestSchemaContext,
} from "@workspace/db/testing";
import {
  engagements,
  parcelBriefings,
  snapshots,
  snapshotIfcFiles,
  materializableElements,
  type MaterializableElement,
} from "@workspace/db";
import { eq } from "drizzle-orm";

let schema: TestSchemaContext;

beforeAll(async () => {
  schema = await createTestSchema();
});

afterAll(async () => {
  await dropTestSchema(schema);
});

afterEach(async () => {
  await truncateAll(schema.pool, [
    "engagements",
    "parcel_briefings",
    "snapshots",
    "snapshot_ifc_files",
    "materializable_elements",
  ]);
});

async function seedEngagementSnapshot(): Promise<{
  engagementId: string;
  snapshotId: string;
}> {
  const [eng] = await schema.db
    .insert(engagements)
    .values({
      name: "Track B IFC Schema Test",
      nameLower: "track-b-ifc-schema-test",
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  const [snap] = await schema.db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: "Test",
      payload: {},
    })
    .returning();
  return { engagementId: eng.id, snapshotId: snap.id };
}

async function seedBriefing(engagementId: string): Promise<string> {
  const [b] = await schema.db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  return b.id;
}

describe("materializable_elements schema invariants (Track B)", () => {
  it("accepts a vanilla briefing-derived row (default source_kind backfills)", async () => {
    const { engagementId } = await seedEngagementSnapshot();
    const briefingId = await seedBriefing(engagementId);
    await schema.db.insert(materializableElements).values({
      briefingId,
      elementKind: "buildable-envelope",
      label: "Envelope A",
    });
    const rows = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.briefingId, briefingId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceKind).toBe("briefing-derived");
  });

  it("rejects briefing-derived rows that lack briefing_id (CHECK invariant)", async () => {
    const { engagementId } = await seedEngagementSnapshot();
    await expect(
      schema.db.insert(materializableElements).values({
        engagementId,
        sourceKind: "briefing-derived",
        elementKind: "buildable-envelope",
      }),
    ).rejects.toThrow(
      /provenance_invariants_check|check constraint|Failed query/i,
    );
  });

  it("rejects rows with an unknown source_kind (closed-tuple guard)", async () => {
    const { engagementId } = await seedEngagementSnapshot();
    const briefingId = await seedBriefing(engagementId);
    // Bypass the drizzle insert (which is type-narrowed) by using the raw
    // pool client; the source_kind CHECK constraint should reject the
    // value at the DB layer.
    await expect(
      schema.pool.query(
        `INSERT INTO materializable_elements (briefing_id, source_kind, element_kind)
         VALUES ($1, 'totally-fake', 'buildable-envelope')`,
        [briefingId],
      ),
    ).rejects.toBeTruthy();
  });

  it("accepts an as-built-ifc row with all required IFC fields", async () => {
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    await schema.db.insert(materializableElements).values({
      engagementId,
      sourceKind: "as-built-ifc",
      elementKind: "as-built-ifc",
      sourceSnapshotId: snapshotId,
      ifcGlobalId: "0_test_guid_22charsXX",
      ifcType: "IfcWall",
      label: "Wall A",
      locked: false,
    });
    const rows = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.engagementId, engagementId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.briefingId).toBeNull();
  });

  it("rejects as-built-ifc rows missing ifc_global_id", async () => {
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    await expect(
      schema.db.insert(materializableElements).values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcType: "IfcWall",
      }),
    ).rejects.toThrow(
      /provenance_invariants_check|check constraint|Failed query/i,
    );
  });

  it("rejects as-built-ifc rows missing source_snapshot_id", async () => {
    const { engagementId } = await seedEngagementSnapshot();
    await expect(
      schema.db.insert(materializableElements).values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        ifcGlobalId: "0_g",
        ifcType: "IfcWall",
      }),
    ).rejects.toThrow(
      /provenance_invariants_check|check constraint|Failed query/i,
    );
  });

  it("rejects as-built-ifc rows missing engagement_id", async () => {
    const { snapshotId } = await seedEngagementSnapshot();
    await expect(
      schema.db.insert(materializableElements).values({
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_g",
        ifcType: "IfcWall",
      }),
    ).rejects.toThrow(
      /provenance_invariants_check|check constraint|Failed query/i,
    );
  });

  it("accepts an as-built-ifc-bundle row alongside per-entity rows", async () => {
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    await schema.db.insert(materializableElements).values([
      {
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_e1",
        ifcType: "IfcWall",
      },
      {
        engagementId,
        sourceKind: "as-built-ifc-bundle",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: `bundle:${snapshotId}`,
        ifcType: "<bundle>",
        glbObjectPath: "/objects/uploads/test-glb",
      },
    ]);
    const rows = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.sourceSnapshotId, snapshotId));
    expect(rows).toHaveLength(2);
    const bundle = rows.find(
      (r: MaterializableElement) => r.sourceKind === "as-built-ifc-bundle",
    );
    expect(bundle?.glbObjectPath).toBe("/objects/uploads/test-glb");
  });

  it("cascades materializable_elements when its source snapshot is deleted", async () => {
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    await schema.db.insert(materializableElements).values({
      engagementId,
      sourceKind: "as-built-ifc",
      elementKind: "as-built-ifc",
      sourceSnapshotId: snapshotId,
      ifcGlobalId: "0_x",
      ifcType: "IfcDoor",
    });
    await schema.db.delete(snapshots).where(eq(snapshots.id, snapshotId));
    const rows = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.engagementId, engagementId));
    expect(rows).toHaveLength(0);
  });
});

/**
 * IFC re-ingest supersession (C.1.5) — verifies the schema-level
 * invariants for the append-and-supersede pattern that replaces the
 * prior delete-and-reinsert at `ifcIngest.ts` (see [[adr-001-atom-architecture]]
 * + the briefing-sources precedent).
 *
 * Schema-level only: the actual ingest call site is exercised via
 * `ifc-ingest-bim-model-atom.test.ts`; here we just confirm the new
 * columns, partial unique index, and self-FK behave as advertised.
 */
describe("materializable_elements IFC supersession (C.1.5)", () => {
  it("permits inserting a new active row once a prior row is flagged superseded (partial unique index respects superseded_at IS NULL)", async () => {
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    // First active row for (snapshot, ifc_global_id).
    const [prior] = await schema.db
      .insert(materializableElements)
      .values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_door_1",
        ifcType: "IfcDoor",
      })
      .returning();

    // A second active row with the same identity must be rejected by
    // the partial unique index. Drizzle wraps the pg error such that
    // `.message` only carries the failed-query prefix (the constraint
    // name lives on the underlying pg error's `.constraint` field);
    // asserting `.rejects.toThrow()` without a regex is enough to
    // prove the index fires.
    await expect(
      schema.db.insert(materializableElements).values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_door_1",
        ifcType: "IfcDoor",
      }),
    ).rejects.toThrow();

    // After superseding the prior row, the same identity is available again.
    await schema.db
      .update(materializableElements)
      .set({ supersededAt: new Date() })
      .where(eq(materializableElements.id, prior.id));

    const [replacement] = await schema.db
      .insert(materializableElements)
      .values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_door_1",
        ifcType: "IfcDoor",
      })
      .returning();

    // Patch the supersession link the way ifcIngest does.
    await schema.db
      .update(materializableElements)
      .set({ supersededById: replacement.id })
      .where(eq(materializableElements.id, prior.id));

    const rows = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.sourceSnapshotId, snapshotId));
    expect(rows).toHaveLength(2);
    const priorRefetched = rows.find((r: MaterializableElement) => r.id === prior.id);
    const replacementRefetched = rows.find(
      (r: MaterializableElement) => r.id === replacement.id,
    );
    expect(priorRefetched?.supersededAt).not.toBeNull();
    expect(priorRefetched?.supersededById).toBe(replacement.id);
    expect(replacementRefetched?.supersededAt).toBeNull();
    expect(replacementRefetched?.supersededById).toBeNull();
  });

  it("does not constrain briefing-derived rows (partial index scoped to IFC source_kinds only)", async () => {
    // briefing-derived rows do not participate in supersession; the
    // partial unique index must NOT apply to them, so two briefing-
    // derived rows with the same briefing+kind insert cleanly.
    const { engagementId } = await seedEngagementSnapshot();
    const briefingId = await seedBriefing(engagementId);
    await schema.db.insert(materializableElements).values([
      {
        briefingId,
        elementKind: "buildable-envelope",
        label: "A",
      },
      {
        briefingId,
        elementKind: "buildable-envelope",
        label: "B",
      },
    ]);
    const rows = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.briefingId, briefingId));
    expect(rows).toHaveLength(2);
  });

  it("the bimModels viewer-read filter (supersededAt IS NULL) returns only the active generation after a re-ingest cycle", async () => {
    // Mirror the read at `routes/bimModels.ts:loadAsBuiltIfcElementsForEngagement`
    // — `superseded_at IS NULL` AND the IFC source_kinds — to confirm
    // the dispatch's invariant (d): the viewer must see only the active
    // generation after a re-ingest, even though prior rows survive for
    // history.
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    const ingestNow = new Date();
    await schema.db.insert(materializableElements).values([
      // Two prior superseded rows (an entity row + bundle).
      {
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_door_1",
        ifcType: "IfcDoor",
        label: "Door (prior)",
        supersededAt: ingestNow,
      },
      {
        engagementId,
        sourceKind: "as-built-ifc-bundle",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: `bundle:${snapshotId}`,
        ifcType: "<bundle>",
        label: "Bundle (prior)",
        glbObjectPath: "/objects/uploads/prior-bundle",
        supersededAt: ingestNow,
      },
      // The two active replacements emitted by the re-ingest.
      {
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_door_1",
        ifcType: "IfcDoor",
        label: "Door (current)",
      },
      {
        engagementId,
        sourceKind: "as-built-ifc-bundle",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: `bundle:${snapshotId}`,
        ifcType: "<bundle>",
        label: "Bundle (current)",
        glbObjectPath: "/objects/uploads/current-bundle",
      },
    ]);

    // The viewer's read filter — same predicate as
    // `routes/bimModels.ts:loadAsBuiltIfcElementsForEngagement`.
    const { and, isNull, inArray } = await import("drizzle-orm");
    const visible = await schema.db
      .select()
      .from(materializableElements)
      .where(
        and(
          eq(materializableElements.engagementId, engagementId),
          eq(materializableElements.sourceSnapshotId, snapshotId),
          inArray(materializableElements.sourceKind, [
            "as-built-ifc-bundle",
            "as-built-ifc",
          ]),
          isNull(materializableElements.supersededAt),
        ),
      );
    expect(visible).toHaveLength(2);
    const labels = visible.map((r: MaterializableElement) => r.label).sort();
    expect(labels).toEqual(["Bundle (current)", "Door (current)"]);
  });

  it("supersededById self-FK is set to null when the superseder row is deleted (ON DELETE SET NULL)", async () => {
    const { engagementId, snapshotId } = await seedEngagementSnapshot();
    const [prior] = await schema.db
      .insert(materializableElements)
      .values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_wall_1",
        ifcType: "IfcWall",
      })
      .returning();

    await schema.db
      .update(materializableElements)
      .set({ supersededAt: new Date() })
      .where(eq(materializableElements.id, prior.id));

    const [replacement] = await schema.db
      .insert(materializableElements)
      .values({
        engagementId,
        sourceKind: "as-built-ifc",
        elementKind: "as-built-ifc",
        sourceSnapshotId: snapshotId,
        ifcGlobalId: "0_wall_1",
        ifcType: "IfcWall",
      })
      .returning();
    await schema.db
      .update(materializableElements)
      .set({ supersededById: replacement.id })
      .where(eq(materializableElements.id, prior.id));

    // Deleting the superseder (e.g. a future cleanup pass) must not
    // cascade-delete the prior row — the FK is ON DELETE SET NULL so
    // the prior row's supersededAt flag is preserved even when its
    // forward pointer is severed.
    await schema.db
      .delete(materializableElements)
      .where(eq(materializableElements.id, replacement.id));

    const refetched = await schema.db
      .select()
      .from(materializableElements)
      .where(eq(materializableElements.id, prior.id));
    expect(refetched).toHaveLength(1);
    expect(refetched[0]?.supersededAt).not.toBeNull();
    expect(refetched[0]?.supersededById).toBeNull();
  });
});

describe("snapshot_ifc_files schema invariants (Track B)", () => {
  it("accepts a row with required fields and defaults the timestamps", async () => {
    const { snapshotId } = await seedEngagementSnapshot();
    const [row] = await schema.db
      .insert(snapshotIfcFiles)
      .values({
        snapshotId,
        blobObjectPath: "/objects/uploads/test-blob",
        fileSizeBytes: 12345,
      })
      .returning();
    expect(row).toBeTruthy();
    expect(row?.parsedAt).toBeNull();
    expect(row?.parseError).toBeNull();
    expect(row?.uploadedAt).toBeInstanceOf(Date);
  });

  it("enforces UNIQUE(snapshot_id) — one IFC per snapshot", async () => {
    const { snapshotId } = await seedEngagementSnapshot();
    await schema.db
      .insert(snapshotIfcFiles)
      .values({
        snapshotId,
        blobObjectPath: "/objects/uploads/blob-1",
        fileSizeBytes: 100,
      });
    await expect(
      schema.db.insert(snapshotIfcFiles).values({
        snapshotId,
        blobObjectPath: "/objects/uploads/blob-2",
        fileSizeBytes: 200,
      }),
    ).rejects.toBeTruthy();
  });

  it("cascades when its parent snapshot is deleted", async () => {
    const { snapshotId } = await seedEngagementSnapshot();
    await schema.db.insert(snapshotIfcFiles).values({
      snapshotId,
      blobObjectPath: "/objects/uploads/blob-x",
      fileSizeBytes: 50,
    });
    await schema.db.delete(snapshots).where(eq(snapshots.id, snapshotId));
    const rows = await schema.db
      .select()
      .from(snapshotIfcFiles)
      .where(eq(snapshotIfcFiles.snapshotId, snapshotId));
    expect(rows).toHaveLength(0);
  });
});
