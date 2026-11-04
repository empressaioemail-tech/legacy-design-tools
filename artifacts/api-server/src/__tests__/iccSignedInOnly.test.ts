/**
 * G-309 wave 2 (F13): /api/dev/atoms/retrieve and /api/codes/* never return
 * ICC results to a caller who is not a signed-in user.
 *
 * No database: @workspace/db and @workspace/codes are faked. The routes are
 * mounted on a bare express app whose stub middleware sets req.session from
 * the x-test-user header (a signed-in user) or leaves it anonymous.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";

process.env["SNAPSHOT_SECRET"] = "test-snapshot-secret";

const state = vi.hoisted(() => ({
  retrieveCalls: [] as Record<string, unknown>[],
  whereArgs: [] as unknown[],
  atomRow: null as Record<string, unknown> | null,
}));

function fakeAtoms() {
  return [
    {
      id: "a-city",
      codeBook: "City Ordinance",
      edition: "2026",
      sectionNumber: "14-02-008",
      sectionTitle: "Setbacks",
      body: "city text",
      sourceUrl: "https://library.municode.com/x",
      score: 3,
      retrievalMode: "lexical",
      codeSource: "jurisdiction",
    },
    {
      id: "a-icc",
      codeBook: "IBC",
      edition: "2021",
      sectionNumber: "1612.3",
      sectionTitle: "Flood",
      body: "PLANTED-ICC-BODY",
      sourceUrl: "https://codes.iccsafe.org/content/IBC2021P1/chapter-16",
      score: 2,
      retrievalMode: "lexical",
      codeSource: "icc-model-code",
    },
  ];
}

vi.mock("@workspace/codes", () => ({
  keyFromEngagement: () => "bastrop_tx",
  retrieveAtomsForQuestion: async (opts: Record<string, unknown>) => {
    state.retrieveCalls.push(opts);
    return fakeAtoms();
  },
  formatReferenceCodeAtoms: (atoms: Array<{ body: string }>) =>
    atoms.map((a) => a.body).join("|"),
  isEmbeddingAvailable: () => false,
  EMBEDDING_MODEL: "m",
  EMBEDDING_DIMENSIONS: 1,
  MIN_VECTOR_SCORE: 0.5,
  embedTexts: async () => [],
  enqueueWarmupForJurisdiction: async () => ({}),
  drainQueue: async () => ({}),
  getJurisdiction: () => ({ key: "bastrop_tx" }),
  listJurisdictions: () => [],
}));

vi.mock("@workspace/db", () => {
  const col = new Proxy({}, { get: () => ({}) });
  const make = () => {
    const chain: Record<string, unknown> = {};
    const result = () => (state.atomRow ? [state.atomRow] : []);
    chain.select = () => chain;
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = (w: unknown) => {
      state.whereArgs.push(w);
      return Object.assign(Promise.resolve([{ n: 0 }]), {
        orderBy: () => ({ limit: () => Object.assign(Promise.resolve([]), { offset: () => Promise.resolve([]) }) }),
        limit: () => Promise.resolve(result()),
      });
    };
    return chain;
  };
  return {
    db: make(),
    engagements: col,
    codeAtoms: col,
    codeAtomSources: col,
    codeAtomFetchQueue: col,
  };
});

vi.mock("../lib/provenanceEnvelope", () => ({
  buildProvenanceFromCodeAtom: () => ({}),
}));

const { default: devAtomsRouter } = await import("../routes/devAtoms");
const { default: codesRouter } = await import("../routes/codes");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    const u = req.header("x-test-user");
    (req as unknown as { session: unknown }).session = u
      ? { audience: "user", requestor: { kind: "user", id: u }, tenantId: "t" }
      : { audience: "user", tenantId: "t" };
    next();
  });
  a.use("/api", devAtomsRouter);
  a.use("/api", codesRouter);
  return a;
}

const SECRET = { "x-snapshot-secret": "test-snapshot-secret" };

beforeEach(() => {
  state.retrieveCalls = [];
  state.whereArgs = [];
  state.atomRow = null;
});

describe("POST /api/dev/atoms/retrieve", () => {
  const body = { jurisdiction: "bastrop_tx", query: "flood" };

  it("returns no ICC result, and does not ask for the ICC supplement, without a signed-in user", async () => {
    const res = await request(app()).post("/api/dev/atoms/retrieve").set(SECRET).send(body);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { atomId: string }) => r.atomId)).toEqual(["a-city"]);
    expect(JSON.stringify(res.body)).not.toContain("PLANTED-ICC-BODY");
    expect(JSON.stringify(res.body)).not.toContain("iccsafe");
    expect(state.retrieveCalls[0]!["includeIccModelCodeSupplement"]).toBe(false);
  });

  it("still returns the ICC citation for a signed-in user", async () => {
    const res = await request(app())
      .post("/api/dev/atoms/retrieve")
      .set(SECRET)
      .set("x-test-user", "u1")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { atomId: string }) => r.atomId)).toEqual(["a-city", "a-icc"]);
    expect(state.retrieveCalls[0]!["includeIccModelCodeSupplement"]).toBeUndefined();
  });
});

describe("GET /api/codes/*", () => {
  const sqlOf = (w: unknown) => new PgDialect().sqlToQuery(w as never).sql;

  it("atom by id: 404 for an ICC atom without a signed-in user, 200 with one", async () => {
    state.atomRow = {
      id: "a-icc",
      jurisdictionKey: "bastrop_tx",
      codeBook: "IBC",
      edition: "2021",
      sectionNumber: "1612.3",
      sectionTitle: "Flood",
      parentSection: null,
      body: "PLANTED-ICC-BODY",
      bodyHtml: null,
      sourceUrl: "https://codes.iccsafe.org/content/IBC2021P1/chapter-16",
      embedding: null,
      embeddingModel: null,
      fetchedAt: new Date(),
      metadata: null,
      sourceName: "codes.iccsafe.org",
    };
    const anon = await request(app()).get("/api/codes/atoms/a-icc");
    expect(anon.status).toBe(404);
    expect(JSON.stringify(anon.body)).not.toContain("PLANTED");
    const user = await request(app()).get("/api/codes/atoms/a-icc").set("x-test-user", "u1");
    expect(user.status).toBe(200);
  });

  it("atom by id: a non-ICC atom is served to anyone", async () => {
    state.atomRow = {
      id: "a-city",
      jurisdictionKey: "bastrop_tx",
      codeBook: "IBC",
      edition: "2021",
      sectionNumber: "14-02-008",
      sectionTitle: "Setbacks",
      parentSection: null,
      body: "city text",
      bodyHtml: null,
      sourceUrl: "https://library.municode.com/x",
      embedding: null,
      embeddingModel: null,
      fetchedAt: new Date(),
      metadata: null,
      sourceName: "municode",
    };
    const anon = await request(app()).get("/api/codes/atoms/a-city");
    expect(anon.status).toBe(200);
  });

  it("lists exclude ICC rows in SQL without a signed-in user, and not with one", async () => {
    await request(app()).get("/api/codes/atoms");
    await request(app()).get("/api/codes/jurisdictions/bastrop_tx/atoms");
    const anonSql = state.whereArgs.map(sqlOf);
    expect(anonSql.length).toBeGreaterThanOrEqual(3);
    expect(anonSql.every((s) => /iccsafe/.test(s) && /NOT/.test(s))).toBe(true);

    state.whereArgs = [];
    await request(app()).get("/api/codes/atoms").set("x-test-user", "u1");
    await request(app()).get("/api/codes/jurisdictions/bastrop_tx/atoms").set("x-test-user", "u1");
    expect(state.whereArgs.map(sqlOf).some((s) => /iccsafe/.test(s))).toBe(false);
  });
});
