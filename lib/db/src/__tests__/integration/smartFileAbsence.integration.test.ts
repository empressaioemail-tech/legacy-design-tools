/**
 * Smart Files TYPED ABSENCE probes (OPS-17 PLAN-ROW G-34).
 *
 * The load-bearing guarantee under test is the inherited spine constraint that
 * ONLY A POSITIVE DETERMINATION WRITES AN ABSENCE. That rule killed an entire
 * defect class on the jurisdiction spine, and it is only real if it is
 * STRUCTURAL: if the read path can synthesize "absent" from a zero-row query,
 * then every never-attempted lookup silently becomes a verified absence and the
 * rule is a convention nobody enforces.
 *
 * Written against a REAL Postgres (`withTestSchema` builds a throwaway schema
 * from the checked-in template), and exercising SQL directly rather than the
 * api-server store module, for the same reason the G-14 probes do: the
 * guarantees under test are properties of the SCHEMA. A store-layer test could
 * satisfy them with application-side discipline and leave the table free to
 * violate them. Testing at the schema proves the database itself enforces it.
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
const PG_NOT_NULL_VIOLATION = "23502";

const ENTITY_ID = "smartfile:jurisdiction:48021:str-ordinance";
const REAL_BASIS =
  "Searched the Bastrop County ordinance index 1998-2026 and the clerk record " +
  "series; no short-term-rental ordinance has been adopted.";

async function recordDetermination(
  pool: { query: (q: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  schemaName: string,
  over: Partial<{
    entityId: string;
    verdict: string;
    basis: string;
    instrument: string;
    determinedAt: string;
  }> = {},
) {
  return pool.query(
    `INSERT INTO "${schemaName}".smart_file_absence_determinations
       (entity_id, jurisdiction_fips, doc_slug, verdict, basis,
        determined_by, access_policy, determined_at)
     VALUES ($1, '48021', 'str-ordinance', $2, $3, $4, 'public-free',
             COALESCE($5::timestamptz, now()))
     RETURNING id, verdict, basis, determined_at`,
    [
      over.entityId ?? ENTITY_ID,
      over.verdict ?? "absent-verified",
      over.basis ?? REAL_BASIS,
      over.instrument ?? "g34-probe",
      over.determinedAt ?? null,
    ],
  );
}

describe.skipIf(!HAS_DB)(
  "smart files — only a POSITIVE determination writes an absence",
  () => {
    it("has NO determination row for a document nobody looked for", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        // The whole point: never having looked is the ABSENCE of a row, not a
        // row that says "absent". If a zero-row read could produce
        // `absent-verified`, every unexamined entityId in Texas would be a
        // verified absence.
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n
             FROM "${schemaName}".smart_file_absence_determinations
            WHERE entity_id = $1`,
          [ENTITY_ID],
        );
        expect(rows[0].n).toBe(0);
      });
    });

    it("distinguishes NEVER-LOOKED from VERIFIED-ABSENT by row existence alone", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        const neverLooked = "smartfile:jurisdiction:48021:never-sought-doc";

        await recordDetermination(pool, schemaName);

        const { rows } = await pool.query(
          `SELECT
             (SELECT count(*)::int FROM "${schemaName}".smart_file_absence_determinations
               WHERE entity_id = $1) AS determined,
             (SELECT count(*)::int FROM "${schemaName}".smart_file_absence_determinations
               WHERE entity_id = $2) AS never_looked`,
          [ENTITY_ID, neverLooked],
        );
        // One deliberately written row; one nothing. These are the two states
        // the single G-14 null could not tell apart.
        expect(rows[0].determined).toBe(1);
        expect(rows[0].never_looked).toBe(0);
      });
    });

    it("cannot record `not-sought` as a verdict — never-looking is not a determination", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        // A row saying "we did nothing" would make the table lie about what a
        // determination IS, and would re-open the door this design closes.
        await expect(
          recordDetermination(pool, schemaName, { verdict: "not-sought" }),
        ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
      });
    });

    it("keeps `lookup-failed` distinct from `absent-verified` in storage", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await recordDetermination(pool, schemaName, {
          entityId: "smartfile:jurisdiction:48021:doc-a",
          verdict: "absent-verified",
        });
        await recordDetermination(pool, schemaName, {
          entityId: "smartfile:jurisdiction:48021:doc-b",
          verdict: "lookup-failed",
          basis: "The county portal returned HTTP 503 on three attempts.",
        });

        const { rows } = await pool.query(
          `SELECT verdict, count(*)::int AS n
             FROM "${schemaName}".smart_file_absence_determinations
            GROUP BY verdict ORDER BY verdict`,
        );
        // A probe failure must never be counted as evidence of absence.
        expect(rows).toEqual([
          { verdict: "absent-verified", n: 1 },
          { verdict: "lookup-failed", n: 1 },
        ]);
      });
    });
  },
);

describe.skipIf(!HAS_DB)(
  "smart files — an absence carries its BASIS, enforced by the database",
  () => {
    it("accepts a determination with a real citation", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        const { rows } = await recordDetermination(pool, schemaName);
        expect(rows[0].basis).toBe(REAL_BASIS);
      });
    });

    it("REJECTS an empty basis at the DATABASE, not merely in app code", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        // A guardrail that does not survive a clone is not a guardrail. This
        // insert bypasses the store module entirely — raw SQL, exactly what a
        // future lane or a backfill script would write — and is still refused.
        await expect(
          recordDetermination(pool, schemaName, { basis: "" }),
        ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
      });
    });

    it("REJECTS a whitespace-only basis", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        // The obvious way around a `length > 0` check, closed by btrim.
        await expect(
          recordDetermination(pool, schemaName, { basis: "     " }),
        ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
      });
    });

    it("REJECTS a NULL basis", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await expect(
          pool.query(
            `INSERT INTO "${schemaName}".smart_file_absence_determinations
               (entity_id, jurisdiction_fips, doc_slug, verdict, basis,
                determined_by, access_policy)
             VALUES ($1, '48021', 'x', 'absent-verified', NULL, 'g34-probe', 'public-free')`,
            [ENTITY_ID],
          ),
        ).rejects.toMatchObject({ code: PG_NOT_NULL_VIOLATION });
      });
    });

    it("REJECTS an unattributable determination", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        // A determination nobody can be traced to cannot be re-verified.
        await expect(
          recordDetermination(pool, schemaName, { instrument: "  " }),
        ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
      });
    });

    it("REJECTS an access policy outside the five-value union", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await expect(
          pool.query(
            `INSERT INTO "${schemaName}".smart_file_absence_determinations
               (entity_id, jurisdiction_fips, doc_slug, verdict, basis,
                determined_by, access_policy)
             VALUES ($1, '48021', 'x', 'absent-verified', $2, 'g34-probe', 'public')`,
            [ENTITY_ID, REAL_BASIS],
          ),
        ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
      });
    });
  },
);

describe.skipIf(!HAS_DB)(
  "smart files — a determination is CURRENT, and re-determination refreshes it",
  () => {
    it("holds exactly ONE determination per entityId", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await recordDetermination(pool, schemaName);
        // A second bare INSERT must conflict rather than leaving a read to
        // choose among competing verdicts for the same document.
        await expect(
          recordDetermination(pool, schemaName),
        ).rejects.toMatchObject({ code: PG_UNIQUE_VIOLATION });
      });
    });

    it("moves determined_at FORWARD on re-determination, so the stamp is the LATEST looking", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await recordDetermination(pool, schemaName, {
          determinedAt: "2019-01-01T00:00:00.000Z",
        });

        await pool.query(
          `INSERT INTO "${schemaName}".smart_file_absence_determinations
             (entity_id, jurisdiction_fips, doc_slug, verdict, basis,
              determined_by, access_policy, determined_at)
           VALUES ($1, '48021', 'str-ordinance', 'absent-verified', $2,
                   'g34-probe', 'public-free', '2026-06-01T00:00:00.000Z')
           ON CONFLICT (entity_id) DO UPDATE SET
             basis = EXCLUDED.basis,
             determined_at = EXCLUDED.determined_at,
             updated_at = EXCLUDED.determined_at`,
          [ENTITY_ID, REAL_BASIS],
        );

        const { rows } = await pool.query(
          `SELECT determined_at, count(*) OVER ()::int AS n
             FROM "${schemaName}".smart_file_absence_determinations
            WHERE entity_id = $1`,
          [ENTITY_ID],
        );
        expect(rows[0].n).toBe(1);
        // Re-checking and getting the same answer still makes the claim
        // fresher: the claim is "we checked on this date", not "we first
        // checked". A determination that could not be refreshed would age into
        // permanent staleness and the indicator would be ignored.
        expect(new Date(rows[0].determined_at).toISOString()).toBe(
          "2026-06-01T00:00:00.000Z",
        );
      });
    });
  },
);

describe.skipIf(!HAS_DB)(
  "smart files — the STALE indicator on the ABSENCE path, BOTH directions",
  () => {
    /**
     * These assert the AGE the evaluator will be handed, computed by the
     * database from a real stored determination. The verdict arithmetic itself
     * is proven in both directions in the contract suite; what is proven HERE
     * is that a stored determination actually produces a stale-side and a
     * fresh-side age, so the indicator has something real to fire on.
     *
     * A fire-only test would pass a permanently-firing gate, so both sides are
     * asserted (DEV_PROCESS 2.2, and the G-14 finding that named this exact
     * trap).
     */
    const THRESHOLD_SECONDS = 30 * 24 * 60 * 60;

    it("an OLD determination ages past the threshold — the indicator can FIRE", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await recordDetermination(pool, schemaName, {
          determinedAt: "2019-01-01T00:00:00.000Z",
        });
        const { rows } = await pool.query(
          `SELECT EXTRACT(EPOCH FROM (now() - determined_at))::float8 AS age
             FROM "${schemaName}".smart_file_absence_determinations
            WHERE entity_id = $1`,
          [ENTITY_ID],
        );
        // "We checked in 2019" is not evidence about today.
        expect(rows[0].age).toBeGreaterThan(THRESHOLD_SECONDS);
      });
    });

    it("a RECENT determination stays inside the threshold — the indicator stays SILENT", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        await recordDetermination(pool, schemaName);
        const { rows } = await pool.query(
          `SELECT EXTRACT(EPOCH FROM (now() - determined_at))::float8 AS age
             FROM "${schemaName}".smart_file_absence_determinations
            WHERE entity_id = $1`,
          [ENTITY_ID],
        );
        // Without this direction, an always-stale absence would pass the test
        // above and every verified absence would render as untrustworthy.
        expect(rows[0].age).toBeLessThan(THRESHOLD_SECONDS);
      });
    });
  },
);

describe.skipIf(!HAS_DB)(
  "smart files — an absence determination is independent of the document tables",
  () => {
    it("records an absence for an entityId that has NO document row", async () => {
      await withTestSchema(async ({ pool, schemaName }) => {
        // The common case by definition: we are recording that the document
        // does not exist. An FK to smart_file_documents would make this
        // unrepresentable, which is why the table deliberately has none.
        await recordDetermination(pool, schemaName);
        const { rows } = await pool.query(
          `SELECT
             (SELECT count(*)::int FROM "${schemaName}".smart_file_documents
               WHERE entity_id = $1) AS docs,
             (SELECT count(*)::int FROM "${schemaName}".smart_file_absence_determinations
               WHERE entity_id = $1) AS determinations`,
          [ENTITY_ID],
        );
        expect(rows[0].docs).toBe(0);
        expect(rows[0].determinations).toBe(1);
      });
    });
  },
);
