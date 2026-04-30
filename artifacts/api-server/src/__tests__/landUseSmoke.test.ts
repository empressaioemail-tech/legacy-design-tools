/**
 * Land Use corpus smoke test — warmup → probe, end-to-end, against the
 * real codepublishing.com pages and a real OpenAI embeddings call.
 *
 * What it verifies (one assertion per layer):
 *   1. Parser     — at least 150 LAND_USE atoms come out of a full warmup
 *                   pass. (Phase-2 manual run produced ~225; 150 is the
 *                   floor that catches a parser regression dropping a
 *                   whole article-worth of H3s.)
 *   2. Embedding  — every LAND_USE atom has a non-null embedding vector,
 *                   so the embedding pipeline didn't silently lose rows.
 *   3. Retrieval  — POST /api/dev/atoms/retrieve with the canonical
 *                   "what are the setbacks for this property" question
 *                   surfaces at least one of the three sections that
 *                   actually answer setbacks (Article 5 §5.4 Lot
 *                   Standards intro, §5.6 Required Yards, Article 10
 *                   Definitions for "yard"/"setback"). Catches embedding
 *                   model drift and jurisdiction registry desync.
 *
 * Gating:
 *   Skipped unless SMOKE_OPENAI_API_KEY is set. The vitest setupFile
 *   `test-env.ts` stashes the operator's OPENAI_API_KEY there before
 *   clearing OPENAI_API_KEY for offline determinism, so an operator who
 *   runs `pnpm test` with their key in env automatically opts in. A fresh
 *   CI box without the key passes without running this file's `it`.
 *
 * Cost:
 *   ~10 polite GETs to codepublishing.com (the source's MIN_GAP_MS is
 *   1s by default — the test's 5-minute timeout absorbs this) and one
 *   embedding batch per article. We deliberately seed only the LAND_USE
 *   `code_atom_sources` row so the other two grand_county_ut books
 *   (IRC HTML, IWUIC PDF) no-op via `source_row_missing` — the smoke test
 *   is scoped to the Land Use ingestion path and shouldn't depend on
 *   grandcountyutah.net availability.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

const SMOKE_KEY = process.env.SMOKE_OPENAI_API_KEY;

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("landUseSmoke.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const { codeAtomSources, codeAtoms } = await import("@workspace/db");
const {
  runWarmupForJurisdiction,
  drainQueue,
} = await import("@workspace/codes");
const { buildTestApp } = await import("./setup");

const SECRET = "test-snapshot-secret";

/**
 * The "right" answers for "what are the setbacks for this property"
 * (per the Phase-2 manual probe run). At least one of these MUST appear
 * in the top 10 retrieval results — the test fails loudly with the full
 * top-10 codeRefs in the assertion message if none do, so a regression
 * is debuggable from CI output without re-running the probe by hand.
 */
const EXPECTED_SECTION_REFS = new Set([
  "5.4#part1",
  "5.6#part1",
  "10.2#part10",
]);

describe.skipIf(!SMOKE_KEY)(
  "Land Use smoke: warmup → setbacks probe (real network + embeddings)",
  () => {
    let app: Express;

    beforeAll(async () => {
      // Restore the OpenAI key the global setupFile stashed for us so
      // the embeddings module's vector path activates for this file
      // only.
      process.env.OPENAI_API_KEY = SMOKE_KEY;
      ctx.schema = await createTestSchema();
      app = await buildTestApp();
      // Seed only the LAND_USE source row; the other two books in the
      // jurisdiction config will fail at loadSourceRow() with
      // `source_row_missing` and be skipped by enqueueWarmupForJurisdiction
      // — which is what we want, the smoke test is scoped to LAND_USE.
      await ctx.schema.db.insert(codeAtomSources).values({
        sourceName: "grand_county_landuse_html",
        label: "Grand County, UT — Land Use Code (HTML)",
        sourceType: "html",
        licenseType: "public_record",
      });
    });

    afterAll(async () => {
      if (ctx.schema) {
        await dropTestSchema(ctx.schema);
        ctx.schema = null;
      }
      // Match the global setupFile's contract: leave OPENAI_API_KEY unset
      // for any subsequent test that reads it.
      delete process.env.OPENAI_API_KEY;
    });

    it(
      "ingests >= 150 LAND_USE atoms (all embedded) and the setbacks probe surfaces an expected section in the top 10",
      { timeout: 5 * 60 * 1000 },
      async () => {
        if (!ctx.schema) throw new Error("schema not ready");

        // Phase 1: warmup. enqueue + drain(100) processes all 10 article
        // queue rows in one pass since the LAND_USE TOC has exactly 10
        // entries.
        const result = await runWarmupForJurisdiction("grand_county_ut");
        // The LAND_USE book must have enqueued at least one article. The
        // other two books error with `source_row_missing` (intentional —
        // see beforeAll). We deliberately don't pin the exact enqueued
        // count here: codepublishing.com can add or split TOC entries
        // without that being a regression we care about. The downstream
        // `landUse.length >= 150` assertion is the real signal that the
        // ingestion pipeline produced enough content.
        const landUseBook = result.enqueue.perBook.find(
          (b) => b.sourceName === "grand_county_landuse_html",
        );
        expect(landUseBook?.error).toBeUndefined();
        expect(landUseBook?.enqueued ?? 0).toBeGreaterThanOrEqual(1);

        // Belt-and-suspenders: keep draining until the queue is quiet, in
        // case any row deferred (e.g. transient codepublishing.com 5xx
        // requeued for retry).
        for (let i = 0; i < 5; i++) {
          const d = await drainQueue(undefined, 50, "grand_county_ut");
          if (d.picked === 0) break;
        }

        // Phase 2: corpus assertions. Filter to LAND_USE atoms and check
        // both the count floor and that every one carries an embedding
        // vector — null embeddings would silently degrade chat answers
        // to lexical-only retrieval.
        const atomRows = await ctx.schema.db
          .select({
            id: codeAtoms.id,
            codeBook: codeAtoms.codeBook,
            sectionNumber: codeAtoms.sectionNumber,
            embedding: codeAtoms.embedding,
          })
          .from(codeAtoms)
          .where(eq(codeAtoms.jurisdictionKey, "grand_county_ut"));
        const landUse = atomRows.filter((a) => a.codeBook === "LAND_USE");
        expect(landUse.length).toBeGreaterThanOrEqual(150);
        const unembedded = landUse.filter((a) => a.embedding === null);
        expect(
          unembedded.length,
          `${unembedded.length} LAND_USE atoms have a null embedding (refs: ${unembedded
            .slice(0, 10)
            .map((a) => a.sectionNumber)
            .join(", ")})`,
        ).toBe(0);

        // Phase 3: retrieval probe. Same surface /api/chat hits — XORed
        // with our jurisdiction key to skip the engagement-resolution
        // path. Vector path must be live (asserted via queryEmbedding
        // .available so a future regression that quietly falls back to
        // lexical fails this test loudly).
        const res = await request(app)
          .post("/api/dev/atoms/retrieve")
          .set("x-snapshot-secret", SECRET)
          .send({
            jurisdiction: "grand_county_ut",
            query: "what are the setbacks for this property",
            topN: 10,
          });
        expect(res.status).toBe(200);
        expect(res.body.queryEmbedding.available).toBe(true);
        expect(res.body.results.length).toBeGreaterThan(0);

        const refs: string[] = res.body.results.map(
          (r: { codeRef: string }) => r.codeRef,
        );
        const matches = refs.filter((r) => EXPECTED_SECTION_REFS.has(r));
        expect(
          matches.length,
          `none of {${[...EXPECTED_SECTION_REFS].join(", ")}} appeared in top 10. Got: ${JSON.stringify(refs)}`,
        ).toBeGreaterThanOrEqual(1);
      },
    );
  },
);
