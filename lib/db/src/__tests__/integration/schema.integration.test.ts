/**
 * lib/db schema integration tests.
 *
 * Replays the production DDL into a temporary `test_<ts>_<rand>` schema and
 * exercises:
 *   - all expected tables exist
 *   - FK cascade from engagement → snapshots → sheets
 *   - UNIQUE (snapshot_id, sheet_number) prevents duplicates
 *   - UNIQUE (content_hash) prevents duplicate atoms
 *   - pgvector column accepts a 1536-dim embedding and round-trips it
 *
 * The withTestSchema helper sets search_path so the same table names that
 * Drizzle uses unqualified in production resolve into the test schema.
 */

import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  engagements,
  snapshots,
  sheets,
  codeAtomSources,
  codeAtoms,
  codeAtomFetchQueue,
} from "../../schema";
import { withTestSchema } from "../utils";

describe("lib/db schema integration", () => {
  it("creates every expected table in the test schema", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const res = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
        [schemaName],
      );
      const names = res.rows.map((r) => r.tablename);
      expect(names).toEqual([
        "code_atom_fetch_queue",
        "code_atom_sources",
        "code_atoms",
        "engagements",
        "findings_code_atoms",
        "sheets",
        "snapshots",
      ]);
    });
  });

  it("cascades engagement → snapshot → sheet on delete", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [eng] = await db
        .insert(engagements)
        .values({
          name: "Test Engagement",
          nameLower: "test engagement",
          jurisdiction: "Moab, UT",
          address: "1 Main St, Moab, UT 84532",
          status: "active",
        })
        .returning({ id: engagements.id });
      const [snap] = await db
        .insert(snapshots)
        .values({
          engagementId: eng.id,
          driveFileId: "drive_test_1",
          revisionId: "rev_1",
          name: "Test Snapshot",
        })
        .returning({ id: snapshots.id });
      await db.insert(sheets).values({
        snapshotId: snap.id,
        sheetNumber: "A1",
        title: "First Floor Plan",
      });

      const before = await pool.query<{ c: string }>(`SELECT COUNT(*)::text c FROM sheets`);
      expect(Number(before.rows[0].c)).toBe(1);

      await db.delete(engagements).where(eq(engagements.id, eng.id));

      const snapsAfter = await pool.query<{ c: string }>(`SELECT COUNT(*)::text c FROM snapshots`);
      expect(Number(snapsAfter.rows[0].c)).toBe(0);
      const sheetsAfter = await pool.query<{ c: string }>(`SELECT COUNT(*)::text c FROM sheets`);
      expect(Number(sheetsAfter.rows[0].c)).toBe(0);
    });
  });

  it("rejects duplicate (snapshot_id, sheet_number)", async () => {
    await withTestSchema(async ({ db }) => {
      const [eng] = await db
        .insert(engagements)
        .values({
          name: "Dup Sheet Engagement",
          nameLower: "dup sheet engagement",
          jurisdiction: "Moab, UT",
          address: "x",
          status: "active",
        })
        .returning({ id: engagements.id });
      const [snap] = await db
        .insert(snapshots)
        .values({
          engagementId: eng.id,
          driveFileId: "drive_dup",
          revisionId: "rev_dup",
          name: "Dup Snap",
        })
        .returning({ id: snapshots.id });
      await db.insert(sheets).values({
        snapshotId: snap.id,
        sheetNumber: "A1",
        title: "First",
      });
      await expect(
        db.insert(sheets).values({
          snapshotId: snap.id,
          sheetNumber: "A1",
          title: "Duplicate",
        }),
      ).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it("rejects duplicate code_atoms.content_hash", async () => {
    await withTestSchema(async ({ db }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_source",
          label: "Test Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });

      const baseAtom = {
        sourceId: src.id,
        jurisdictionKey: "test_jurisdiction",
        codeBook: "TEST_BOOK",
        edition: "Test 2025",
        sectionNumber: "1.1",
        sectionTitle: "Section One",
        body: "Body text",
        sourceUrl: "https://example.com/1.1",
        contentHash: "deadbeef".repeat(8), // 64-char fake sha256
      };
      await db.insert(codeAtoms).values(baseAtom);
      await expect(db.insert(codeAtoms).values(baseAtom)).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });

  it("stores and round-trips a 1536-dim pgvector embedding", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "vector_source",
          label: "Vector Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });

      const vec = Array.from({ length: 1536 }, (_, i) => (i % 7) / 10);
      await db.insert(codeAtoms).values({
        sourceId: src.id,
        jurisdictionKey: "vec_jurisdiction",
        codeBook: "VEC_BOOK",
        edition: "Vec 2025",
        body: "vector body",
        sourceUrl: "https://example.com/v",
        contentHash: "v".repeat(64),
        embedding: vec,
        embeddingModel: "text-embedding-3-small",
        embeddedAt: new Date(),
      });

      // Round-trip via raw SQL: pgvector returns "[0.0,0.1,...]" text format.
      const raw = await pool.query<{ embedding: string }>(
        `SELECT embedding::text AS embedding FROM code_atoms WHERE jurisdiction_key = $1 LIMIT 1`,
        ["vec_jurisdiction"],
      );
      expect(raw.rows).toHaveLength(1);
      const parsed = JSON.parse(raw.rows[0].embedding) as number[];
      expect(parsed).toHaveLength(1536);
      expect(parsed.slice(0, 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    });
  });

  it("self-similarity via cosine distance is 0", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "cos_source",
          label: "Cos Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const vec = Array.from({ length: 1536 }, (_, i) => (i % 11) / 13);
      const vecLit = `[${vec.join(",")}]`;
      await db.insert(codeAtoms).values({
        sourceId: src.id,
        jurisdictionKey: "cos_jurisdiction",
        codeBook: "COS_BOOK",
        edition: "Cos 2025",
        body: "cos body",
        sourceUrl: "https://example.com/c",
        contentHash: "c".repeat(64),
        embedding: vec,
      });
      const dist = await db.execute<{ d: string }>(
        sql.raw(
          `SELECT (embedding <=> '${vecLit}'::vector) AS d FROM code_atoms WHERE jurisdiction_key = 'cos_jurisdiction' LIMIT 1`,
        ),
      );
      expect(Number(dist.rows[0].d)).toBeCloseTo(0, 5);
    });
  });

  it("queue row defaults: status=pending, attempts=0, next_attempt_at set", async () => {
    await withTestSchema(async ({ db }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "queue_source",
          label: "Queue Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const [row] = await db
        .insert(codeAtomFetchQueue)
        .values({
          sourceId: src.id,
          jurisdictionKey: "qj",
          codeBook: "QB",
          edition: "Q 2025",
          sectionUrl: "https://example.com/q1",
        })
        .returning();
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
    });
  });

  it("rejects duplicate (source_id, section_url) on the queue", async () => {
    await withTestSchema(async ({ db }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "queue_dedupe_source",
          label: "Queue Dedupe",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const baseRow = {
        sourceId: src.id,
        jurisdictionKey: "j",
        codeBook: "B",
        edition: "E",
        sectionUrl: "https://example.com/dup",
      };
      await db.insert(codeAtomFetchQueue).values(baseRow);
      await expect(db.insert(codeAtomFetchQueue).values(baseRow)).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });
});
