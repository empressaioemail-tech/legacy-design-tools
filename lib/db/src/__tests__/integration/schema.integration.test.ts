/**
 * lib/db schema integration tests.
 *
 * Replays the production DDL into a temporary `test_<ts>_<rand>` schema and
 * exercises the contracts that downstream code depends on:
 *   - all expected tables exist
 *   - FK cascade from engagement → snapshots → sheets
 *   - UNIQUE (snapshot_id, sheet_number) prevents duplicate sheets
 *   - UNIQUE (content_hash) prevents duplicate atoms
 *   - UNIQUE (source_id, section_url) prevents duplicate queue rows
 *   - pgvector column accepts a 1536-dim embedding and round-trips it
 *   - cosine self-distance ≈ 0
 *   - queue defaults: status=pending, attempts=0, next_attempt_at set
 *
 * Drizzle wraps PG errors in DrizzleQueryError; the underlying pg error
 * (with .code) is on `.cause`. The expectPgError helper handles both.
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
import { withTestSchema } from "../../testing";

/**
 * Vitest's .rejects.toThrow only inspects message text, but Drizzle's
 * DrizzleQueryError stuffs the SQL into the message and the real PG
 * SQLSTATE code into the underlying `cause`. This helper unwraps it.
 */
async function expectPgError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the promise to reject").toBeDefined();
  // Drizzle: { cause: pgError }. Direct pg: pgError. Defensively try both.
  const pgErr = (err as { cause?: { code?: string }; code?: string }).cause ??
    (err as { code?: string });
  expect(pgErr.code).toBe(code);
}

const PG_UNIQUE_VIOLATION = "23505";

const minimalThumb = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // not a real PNG, schema only requires bytes

describe("lib/db schema integration", () => {
  it("creates every expected table in the test schema", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const res = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
        [schemaName],
      );
      const names = res.rows.map((r) => r.tablename);
      expect(names).toEqual([
        "atom_events",
        "code_atom_fetch_queue",
        "code_atom_sources",
        "code_atoms",
        "engagements",
        "findings_code_atoms",
        "sheets",
        "snapshots",
        "submissions",
        "users",
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
          projectName: "Test Snapshot",
          payload: { kind: "stub" },
        })
        .returning({ id: snapshots.id });
      await db.insert(sheets).values({
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: "A1",
        sheetName: "First Floor Plan",
        thumbnailPng: minimalThumb,
        thumbnailWidth: 100,
        thumbnailHeight: 100,
        fullPng: minimalThumb,
        fullWidth: 1000,
        fullHeight: 1000,
        sortOrder: 0,
      });

      const before = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM sheets`,
      );
      expect(Number(before.rows[0].c)).toBe(1);

      await db.delete(engagements).where(eq(engagements.id, eng.id));

      const snapsAfter = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM snapshots`,
      );
      expect(Number(snapsAfter.rows[0].c)).toBe(0);
      const sheetsAfter = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM sheets`,
      );
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
          projectName: "Dup Snap",
          payload: {},
        })
        .returning({ id: snapshots.id });
      const baseSheet = {
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: "A1",
        sheetName: "First",
        thumbnailPng: minimalThumb,
        thumbnailWidth: 1,
        thumbnailHeight: 1,
        fullPng: minimalThumb,
        fullWidth: 1,
        fullHeight: 1,
        sortOrder: 0,
      };
      await db.insert(sheets).values(baseSheet);
      await expectPgError(
        db.insert(sheets).values({ ...baseSheet, sheetName: "Duplicate" }),
        PG_UNIQUE_VIOLATION,
      );
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
      await expectPgError(
        db.insert(codeAtoms).values(baseAtom),
        PG_UNIQUE_VIOLATION,
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
      // Floating-point nudge from pgvector's normalisation: compare with tolerance.
      const expected = [0, 0.1, 0.2, 0.3, 0.4];
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]).toBeCloseTo(expected[i], 5);
      }
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
      const dist = await pool.query<{ d: string }>(
        `SELECT (embedding <=> $1::vector) AS d FROM code_atoms WHERE jurisdiction_key = $2 LIMIT 1`,
        [vecLit, "cos_jurisdiction"],
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
      await expectPgError(
        db.insert(codeAtomFetchQueue).values(baseRow),
        PG_UNIQUE_VIOLATION,
      );
    });
  });
});

// avoid unused import lint when sql isn't actively referenced
void sql;
