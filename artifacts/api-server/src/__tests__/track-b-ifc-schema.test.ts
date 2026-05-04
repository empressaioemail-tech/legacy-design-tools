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
  type TestSchema,
} from "@workspace/db/testing";
import {
  engagements,
  parcelBriefings,
  snapshots,
  snapshotIfcFiles,
  materializableElements,
} from "@workspace/db";
import { eq } from "drizzle-orm";

let schema: TestSchema;

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
    ).rejects.toThrow(/provenance_invariants_check|check constraint/i);
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
    ).rejects.toThrow(/provenance_invariants_check|check constraint/i);
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
    ).rejects.toThrow(/provenance_invariants_check|check constraint/i);
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
    ).rejects.toThrow(/provenance_invariants_check|check constraint/i);
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
    const bundle = rows.find((r) => r.sourceKind === "as-built-ifc-bundle");
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
