/**
 * /api/dev/atoms/retrieve — the operator-facing retrieval probe.
 *
 * Coverage:
 *   - 401 when the x-snapshot-secret header is missing/wrong
 *   - 400 when query is missing/empty
 *   - 400 when neither (or both) of engagementId/jurisdiction is provided
 *   - jurisdiction path returns the expected shape against seeded atoms
 *   - engagementId path resolves jurisdiction from the engagement's address
 *     using the SAME logic /api/chat uses (we assert the route imported it,
 *     by exercising a known address → known key mapping)
 *   - empty results path: empty atoms array AND empty assembledPromptBlock
 *     (must match buildChatPrompt's behavior — no `<reference_code_atoms>`
 *     when there are no atoms)
 *
 * The test env clears OPENAI_API_KEY so retrieval always takes the lexical
 * fallback path. That's intentional: the route's contract — shape, status
 * codes, jurisdiction resolution, prompt block assembly — is independent
 * of whether the underlying retrieval was vector or lexical. The probe is
 * the unit under test; the retrieval module is exercised by lib/codes' own
 * tests.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("devAtoms.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, codeAtomSources, codeAtoms } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const SECRET = "test-snapshot-secret";

async function seedGrandCountyAtoms(): Promise<{ atomIds: string[] }> {
  if (!ctx.schema) throw new Error("schema not ready");
  // Sources are global (jurisdiction lives on each atom, not the source).
  const [src] = await ctx.schema.db
    .insert(codeAtomSources)
    .values({
      sourceName: "grand_county_html",
      label: "Grand County HTML",
      sourceType: "html",
      licenseType: "public_record",
    })
    .returning({ id: codeAtomSources.id });

  // Two atoms whose body matches "setback" terms strongly enough that the
  // lexical fallback returns them in a deterministic order.
  const atomRows = await ctx.schema.db
    .insert(codeAtoms)
    .values([
      {
        sourceId: src.id,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionNumber: "R301.2(1)",
        sectionTitle: "Setbacks and Yard Requirements",
        body: "Front setback shall be twenty feet. Side setback shall be ten feet. Rear setback shall be fifteen feet.",
        bodyHtml: null,
        contentHash: "hash-1",
        sourceUrl: "https://example.com/r301",
      },
      {
        sourceId: src.id,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IWUIC",
        edition: "2006",
        sectionNumber: "303.2",
        sectionTitle: "Climatic Criteria",
        body: "Ground snow load shall be fifty pounds per square foot. Basic wind speed shall be one hundred ten mph.",
        bodyHtml: null,
        contentHash: "hash-2",
        sourceUrl: "https://example.com/iwuic",
      },
    ])
    .returning({ id: codeAtoms.id });

  return { atomIds: atomRows.map((r) => r.id) };
}

async function seedMoabEngagement(): Promise<{ id: string }> {
  if (!ctx.schema) throw new Error("schema not ready");
  // Address-only resolution — keyFromEngagement should pick this up via the
  // address-suffix matcher in lib/codes/jurisdictions.ts.
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: "Moab Test Residence",
      nameLower: `moab-test-${Math.random().toString(36).slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Main St, Moab, UT 84532",
    })
    .returning({ id: engagements.id });
  return { id: eng.id };
}

describe("POST /api/dev/atoms/retrieve — auth + validation", () => {
  it("401s when the x-snapshot-secret header is missing", async () => {
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .send({ jurisdiction: "grand_county_ut", query: "setbacks" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid snapshot secret" });
  });

  it("401s when the x-snapshot-secret header is wrong", async () => {
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", "not-the-secret")
      .send({ jurisdiction: "grand_county_ut", query: "setbacks" });
    expect(res.status).toBe(401);
  });

  it("400s when query is missing", async () => {
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ jurisdiction: "grand_county_ut" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid retrieval probe request" });
  });

  it("400s when both engagementId and jurisdiction are provided", async () => {
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({
        engagementId: "00000000-0000-0000-0000-000000000000",
        jurisdiction: "grand_county_ut",
        query: "setbacks",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly one/i);
  });

  it("400s when neither engagementId nor jurisdiction is provided", async () => {
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ query: "setbacks" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly one/i);
  });

  it("404s when engagementId does not exist", async () => {
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({
        engagementId: "00000000-0000-0000-0000-000000000000",
        query: "setbacks",
      });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Engagement not found" });
  });
});

describe("POST /api/dev/atoms/retrieve — jurisdiction path", () => {
  it("returns the spec'd shape with results sorted by similarity DESC", async () => {
    await seedGrandCountyAtoms();

    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ jurisdiction: "grand_county_ut", query: "setback" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      resolvedJurisdiction: "grand_county_ut",
      resolvedFromEngagement: false,
      query: "setback",
      queryEmbedding: {
        model: "text-embedding-3-small",
        dimension: 1536,
        // Test env clears OPENAI_API_KEY → lexical path → available=false.
        available: false,
      },
    });
    // Setback-titled atom should rank first under lexical scoring.
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].codeRef).toBe("R301.2(1)");
    // Ranks are 1-indexed and dense.
    res.body.results.forEach(
      (r: { rank: number }, i: number) => expect(r.rank).toBe(i + 1),
    );
    // Scores are non-increasing.
    for (let i = 1; i < res.body.results.length; i++) {
      expect(res.body.results[i].similarity).toBeLessThanOrEqual(
        res.body.results[i - 1].similarity,
      );
    }
    // Each result row carries the spec'd fields.
    const top = res.body.results[0];
    expect(top).toMatchObject({
      atomId: expect.any(String),
      codeRef: expect.any(String),
      bodyPreview: expect.any(String),
      sourceBook: "IRC_R301_2_1",
      sourceUrl: "https://example.com/r301",
      retrievalMode: "lexical",
    });
    // Body preview is server-truncated. Our seeded body is short, so it
    // shouldn't be truncated; assert there's no ellipsis when under cap.
    expect(top.bodyPreview).not.toContain("…");
    // Assembled prompt block contains the literal XML the LLM would see.
    expect(res.body.assembledPromptBlock).toContain("<reference_code_atoms>");
    expect(res.body.assembledPromptBlock).toContain(`<atom id="${top.atomId}"`);
    expect(res.body.assembledPromptBlock).toContain('mode="lexical"');
    expect(res.body.assembledPromptBlock).toContain("</reference_code_atoms>");
    // Echoes the canonical chat-path inclusion threshold so the probe UI
    // never drifts from server behavior. Value is owned by
    // `MIN_VECTOR_SCORE` in @workspace/codes; assert it's a sane cosine
    // similarity (probe doesn't filter, but the field must be present).
    expect(typeof res.body.inclusionThreshold).toBe("number");
    expect(res.body.inclusionThreshold).toBeGreaterThan(0);
    expect(res.body.inclusionThreshold).toBeLessThan(1);
  });

  it("returns empty results AND empty prompt block when no atoms match", async () => {
    // No seed — the per-file truncate already left code_atoms empty.
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ jurisdiction: "grand_county_ut", query: "setback" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    // Matches buildChatPrompt: no atoms → atomBlock is "" → no
    // `<reference_code_atoms>` tags emitted.
    expect(res.body.assembledPromptBlock).toBe("");
  });

  it("respects topN limit", async () => {
    await seedGrandCountyAtoms();
    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ jurisdiction: "grand_county_ut", query: "setback foot", topN: 1 });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(1);
  });
});

describe("POST /api/dev/atoms/retrieve — engagementId path", () => {
  it("resolves jurisdiction from the engagement's address (same as /api/chat)", async () => {
    await seedGrandCountyAtoms();
    const { id } = await seedMoabEngagement();

    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ engagementId: id, query: "setback" });

    expect(res.status).toBe(200);
    expect(res.body.resolvedJurisdiction).toBe("grand_county_ut");
    expect(res.body.resolvedFromEngagement).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  it("422s when the engagement exists but has no resolvable jurisdiction", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Unresolvable Engagement",
        nameLower: `unresolvable-${Math.random().toString(36).slice(2)}`,
        // No jurisdiction-bearing fields at all.
        jurisdiction: null,
        jurisdictionCity: null,
        jurisdictionState: null,
        address: null,
      })
      .returning({ id: engagements.id });

    const res = await request(getApp())
      .post("/api/dev/atoms/retrieve")
      .set("x-snapshot-secret", SECRET)
      .send({ engagementId: eng.id, query: "setback" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/jurisdiction/i);
  });
});
