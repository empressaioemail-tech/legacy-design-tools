/**
 * Smart Files store probes (OPS-17 PLAN-ROW G-14) — the structural guarantees.
 *
 * These are the direct tests of the two doc-34 promises the brokerage schema
 * provably cannot carry:
 *   - "a document lives once and appears everywhere it belongs"
 *   - "revise once, current everywhere, and what it was before is still there"
 *
 * Written against a REAL Postgres (`withTestSchema` builds a throwaway schema
 * from the checked-in template). They exercise SQL directly rather than the
 * api-server store module, because the guarantees under test are properties of
 * the SCHEMA — a store-layer test could satisfy them with application-side
 * discipline and leave the table free to violate them. Testing at the schema
 * proves the database itself enforces it.
 *
 * Skips when no database is configured; CI provisions one and is authoritative.
 */

import { describe, it, expect } from "vitest";

import { withTestSchema } from "../../testing";

const HAS_DB = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const PG_UNIQUE_VIOLATION = "23505";
const PG_CHECK_VIOLATION = "23514";

const PROVENANCE = JSON.stringify({
  sourceUri: "https://example.gov/udc-2024.pdf",
  sourceLabel: "Bastrop County Clerk",
  retrievedAt: "2026-06-01T00:00:00.000Z",
  sourceVintage: "2024-03-12",
});

const JURISDICTION_ENTITY_ID = "smartfile:jurisdiction:48021:udc-2024";
const TENANT_ENTITY_ID = "smartfile:tenant:mox:unit-turn-sop";
const SITE_ENTITY_ID = "smartfile:site:parcel:48021:R12345:geotech";

interface SeedDocOptions {
  entityId: string;
  scopeType: string;
  scopeId: string;
  jurisdictionFips: string | null;
  docSlug: string;
  title: string;
}

const DEFAULT_JURISDICTION_SEED: SeedDocOptions = {
  entityId: JURISDICTION_ENTITY_ID,
  scopeType: "jurisdiction",
  scopeId: "48021",
  jurisdictionFips: "48021",
  docSlug: "udc-2024",
  title: "Unified Development Code",
};

/** Insert a document at version 1 and return its uuid. */
async function seedDocument(
  pool: { query: (q: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  schemaName: string,
  opts: SeedDocOptions = DEFAULT_JURISDICTION_SEED,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO "${schemaName}".smart_file_documents
       (entity_id, scope_type, scope_id, jurisdiction_fips, doc_slug, title, access_policy, current_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'public-free', 1)
     RETURNING id`,
    [
      opts.entityId,
      opts.scopeType,
      opts.scopeId,
      opts.jurisdictionFips,
      opts.docSlug,
      opts.title,
    ],
  );
  const docId = rows[0].id as string;
  await pool.query(
    `INSERT INTO "${schemaName}".smart_file_versions
       (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance, computed_at)
     VALUES ($1, $2, 1, 'bafydoc-v1', 'application/pdf', 1024, $3::jsonb, now())`,
    [docId, opts.entityId, PROVENANCE],
  );
  return docId;
}

describe.skipIf(!HAS_DB)("smart files — store once, place many", () => {
  it("stores ONE document row however many places it appears", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);

      // Place the same document in three different locations.
      for (const [targetType, targetId] of [
        ["folder", "folder-planning"],
        ["parcel", "R123456"],
        ["meeting", "council-2026-06-09"],
      ] as const) {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_placements
             (document_id, document_entity_id, target_type, target_id)
           VALUES ($1, $2, $3, $4)`,
          [docId, JURISDICTION_ENTITY_ID, targetType, targetId],
        );
      }

      // Counting rule: rows in smart_file_documents matching this declared
      // entityId (measured, not derived). Must be exactly 1.
      const docs = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_documents WHERE entity_id = $1`,
        [JURISDICTION_ENTITY_ID],
      );
      // Counting rule: rows in smart_file_placements for this document.
      const placements = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_placements WHERE document_entity_id = $1`,
        [JURISDICTION_ENTITY_ID],
      );
      // Counting rule: rows in smart_file_versions for this document.
      const versions = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_versions WHERE document_entity_id = $1`,
        [JURISDICTION_ENTITY_ID],
      );

      expect(docs.rows[0].n).toBe(1);
      expect(placements.rows[0].n).toBe(3);
      // Placement must not mint versions either.
      expect(versions.rows[0].n).toBe(1);
    });
  });

  it("keeps the artifact count invariant when placed a FOURTH time", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      for (const targetId of ["a", "b", "c", "d"]) {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_placements
             (document_id, document_entity_id, target_type, target_id)
           VALUES ($1, $2, 'folder', $3)`,
          [docId, JURISDICTION_ENTITY_ID, targetId],
        );
      }
      const docs = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_documents WHERE entity_id = $1`,
        [JURISDICTION_ENTITY_ID],
      );
      expect(docs.rows[0].n).toBe(1);
    });
  });

  it("refuses a SECOND document row for the same declared entityId", async () => {
    // The store-once guarantee enforced by the DATABASE, not by caller
    // discipline. Without this, "lives once" is a convention.
    await withTestSchema(async ({ pool, schemaName }) => {
      await seedDocument(pool as any, schemaName);
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_documents
             (entity_id, scope_type, scope_id, jurisdiction_fips, doc_slug, title, access_policy)
           VALUES ($1, 'jurisdiction', '48021', '48021', 'udc-2024', 'Duplicate', 'public-free')`,
          [JURISDICTION_ENTITY_ID],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe(PG_UNIQUE_VIOLATION);
    });
  });

  it("refuses a duplicate placement at the same target", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_placements
           (document_id, document_entity_id, target_type, target_id)
         VALUES ($1, $2, 'folder', 'planning')`,
        [docId, JURISDICTION_ENTITY_ID],
      );
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_placements
             (document_id, document_entity_id, target_type, target_id)
           VALUES ($1, $2, 'folder', 'planning')`,
          [docId, JURISDICTION_ENTITY_ID],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      // Otherwise "placed in three locations" could legitimately read as four.
      expect(code).toBe(PG_UNIQUE_VIOLATION);
    });
  });
});

describe.skipIf(!HAS_DB)("smart files — revise once, prior version retained", () => {
  it("makes the revision current at EVERY placement with no per-placement write", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      for (const targetId of ["p1", "p2", "p3"]) {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_placements
             (document_id, document_entity_id, target_type, target_id)
           VALUES ($1, $2, 'folder', $3)`,
          [docId, JURISDICTION_ENTITY_ID, targetId],
        );
      }

      // Revise once: supersede v1, insert v2, move the pointer.
      await pool.query(
        `UPDATE "${schemaName}".smart_file_versions
            SET superseded_at = now()
          WHERE document_id = $1 AND version = 1`,
        [docId],
      );
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_versions
           (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance, computed_at)
         VALUES ($1, $2, 2, 'bafydoc-v2', 'application/pdf', 2048, $3::jsonb, now())`,
        [docId, JURISDICTION_ENTITY_ID, PROVENANCE],
      );
      await pool.query(
        `UPDATE "${schemaName}".smart_file_documents
            SET current_version = 2, updated_at = now()
          WHERE id = $1`,
        [docId],
      );

      // Every placement resolves through the document pointer, so all three
      // read v2 without any placement row having been written.
      const resolved = await pool.query(
        `SELECT p.target_id, v.content_cid
           FROM "${schemaName}".smart_file_placements p
           JOIN "${schemaName}".smart_file_documents d ON d.id = p.document_id
           JOIN "${schemaName}".smart_file_versions v
             ON v.document_id = d.id AND v.version = d.current_version
          WHERE p.document_entity_id = $1
          ORDER BY p.target_id`,
        [JURISDICTION_ENTITY_ID],
      );
      expect(resolved.rows.map((r: any) => r.target_id)).toEqual([
        "p1",
        "p2",
        "p3",
      ]);
      for (const row of resolved.rows) {
        expect(row.content_cid).toBe("bafydoc-v2");
      }
    });
  });

  it("keeps the PRIOR version retrievable by version identity", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      await pool.query(
        `UPDATE "${schemaName}".smart_file_versions SET superseded_at = now()
          WHERE document_id = $1 AND version = 1`,
        [docId],
      );
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_versions
           (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance, computed_at)
         VALUES ($1, $2, 2, 'bafydoc-v2', 'application/pdf', 2048, $3::jsonb, now())`,
        [docId, JURISDICTION_ENTITY_ID, PROVENANCE],
      );

      // The pre-revision content is still there, fetched by version identity.
      const prior = await pool.query(
        `SELECT content_cid, superseded_at FROM "${schemaName}".smart_file_versions
          WHERE document_id = $1 AND version = 1`,
        [docId],
      );
      expect(prior.rows).toHaveLength(1);
      expect(prior.rows[0].content_cid).toBe("bafydoc-v1");
      // Supersession is a POSITIVE record, not an inference from the pointer.
      expect(prior.rows[0].superseded_at).not.toBeNull();

      // Nothing was destroyed: both versions coexist.
      const all = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_versions
          WHERE document_entity_id = $1`,
        [JURISDICTION_ENTITY_ID],
      );
      expect(all.rows[0].n).toBe(2);
    });
  });

  it("refuses to reuse a version identity", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_versions
             (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance)
           VALUES ($1, $2, 1, 'bafydoc-collide', 'application/pdf', 10, $3::jsonb)`,
          [docId, JURISDICTION_ENTITY_ID, PROVENANCE],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      // History cannot be overwritten by re-inserting a version number.
      expect(code).toBe(PG_UNIQUE_VIOLATION);
    });
  });
});

describe.skipIf(!HAS_DB)("smart files — the four columns, and closed sets", () => {
  it("has updated_at, version, cid and access_policy — the columns the brokerage table lacks", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const cols = await pool.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name IN ('smart_file_documents','smart_file_versions','smart_file_placements')`,
        [schemaName],
      );
      const byTable = new Map<string, Set<string>>();
      for (const r of cols.rows as any[]) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
        byTable.get(r.table_name)!.add(r.column_name);
      }
      // The premise of the whole lane, asserted against the built schema.
      expect(byTable.get("smart_file_documents")).toContain("updated_at");
      expect(byTable.get("smart_file_documents")).toContain("access_policy");
      expect(byTable.get("smart_file_documents")).toContain("scope_type");
      expect(byTable.get("smart_file_documents")).toContain("scope_id");
      expect(byTable.get("smart_file_versions")).toContain("version");
      expect(byTable.get("smart_file_versions")).toContain("content_cid");
    });
  });

  it("rejects an access policy outside the five-value union", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_documents
             (entity_id, scope_type, scope_id, jurisdiction_fips, doc_slug, title, access_policy)
           VALUES ('smartfile:jurisdiction:48021:bad-policy', 'jurisdiction', '48021', '48021', 'bad-policy', 'X', 'public')`,
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe(PG_CHECK_VIOLATION);
    });
  });

  it("rejects a placement target outside the closed set", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_placements
             (document_id, document_entity_id, target_type, target_id)
           VALUES ($1, $2, 'workspace', 'w1')`,
          [docId, JURISDICTION_ENTITY_ID],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      // 'workspace' is deliberately NOT a Smart Files placement target: this
      // family does not extend the brokerage workspace family (A-012).
      expect(code).toBe(PG_CHECK_VIOLATION);
    });
  });

  it("refuses a version with no provenance", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      let failed = false;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_versions
             (document_id, document_entity_id, version, content_cid, content_type, byte_size)
           VALUES ($1, $2, 9, 'bafydoc-x', 'application/pdf', 10)`,
          [docId, JURISDICTION_ENTITY_ID],
        );
      } catch {
        failed = true;
      }
      // An unsourced city document is a rumor, and NOT NULL is what makes that
      // structural rather than a convention.
      expect(failed).toBe(true);
    });
  });
});

describe.skipIf(!HAS_DB)("smart files — scope-keyed identity on all three scopes", () => {
  it("store-once / revise-once for jurisdiction scope", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName);
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_placements
           (document_id, document_entity_id, target_type, target_id)
         VALUES ($1, $2, 'folder', 'j1')`,
        [docId, JURISDICTION_ENTITY_ID],
      );
      await pool.query(
        `UPDATE "${schemaName}".smart_file_versions SET superseded_at = now()
          WHERE document_id = $1 AND version = 1`,
        [docId],
      );
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_versions
           (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance, computed_at)
         VALUES ($1, $2, 2, 'bafydoc-v2', 'application/pdf', 2048, $3::jsonb, now())`,
        [docId, JURISDICTION_ENTITY_ID, PROVENANCE],
      );
      const docs = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_documents WHERE entity_id = $1`,
        [JURISDICTION_ENTITY_ID],
      );
      expect(docs.rows[0].n).toBe(1);
    });
  });

  it("store-once / revise-once for tenant scope", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName, {
        entityId: TENANT_ENTITY_ID,
        scopeType: "tenant",
        scopeId: "mox",
        jurisdictionFips: null,
        docSlug: "unit-turn-sop",
        title: "Unit Turn SOP",
      });
      await pool.query(
        `UPDATE "${schemaName}".smart_file_versions SET superseded_at = now()
          WHERE document_id = $1 AND version = 1`,
        [docId],
      );
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_versions
           (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance, computed_at)
         VALUES ($1, $2, 2, 'bafydoc-v2', 'application/pdf', 2048, $3::jsonb, now())`,
        [docId, TENANT_ENTITY_ID, PROVENANCE],
      );
      const docs = await pool.query(
        `SELECT count(*)::int AS n FROM "${schemaName}".smart_file_documents WHERE entity_id = $1`,
        [TENANT_ENTITY_ID],
      );
      expect(docs.rows[0].n).toBe(1);
    });
  });

  it("store-once / revise-once for site scope with colons in scopeId", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const docId = await seedDocument(pool as any, schemaName, {
        entityId: SITE_ENTITY_ID,
        scopeType: "site",
        scopeId: "parcel:48021:R12345",
        jurisdictionFips: null,
        docSlug: "geotech",
        title: "Geotech Report",
      });
      await pool.query(
        `UPDATE "${schemaName}".smart_file_versions SET superseded_at = now()
          WHERE document_id = $1 AND version = 1`,
        [docId],
      );
      await pool.query(
        `INSERT INTO "${schemaName}".smart_file_versions
           (document_id, document_entity_id, version, content_cid, content_type, byte_size, provenance, computed_at)
         VALUES ($1, $2, 2, 'bafydoc-v2', 'application/pdf', 2048, $3::jsonb, now())`,
        [docId, SITE_ENTITY_ID, PROVENANCE],
      );
      const row = await pool.query(
        `SELECT scope_id FROM "${schemaName}".smart_file_documents WHERE entity_id = $1`,
        [SITE_ENTITY_ID],
      );
      expect(row.rows[0].scope_id).toBe("parcel:48021:R12345");
    });
  });

  it("refuses duplicate scope identity (scope_type, scope_id, doc_slug)", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      await seedDocument(pool as any, schemaName);
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_documents
             (entity_id, scope_type, scope_id, jurisdiction_fips, doc_slug, title, access_policy)
           VALUES ('smartfile:jurisdiction:48021:udc-2024-dup', 'jurisdiction', '48021', '48021', 'udc-2024', 'Dup', 'public-free')`,
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe(PG_UNIQUE_VIOLATION);
    });
  });
});
