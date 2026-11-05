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
import { ANON_TEST_SESSION_OWNER_ID } from "../lib/anonymousOwnerCookie";
import { hasSignedInUser } from "../lib/iccAccess";

process.env["SNAPSHOT_SECRET"] = "test-snapshot-secret";

const state = vi.hoisted(() => ({
  retrieveCalls: [] as Record<string, unknown>[],
  whereArgs: [] as unknown[],
  atomRow: null as Record<string, unknown> | null,
  listRows: [] as Record<string, unknown>[],
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
        orderBy: () => ({ limit: () => Object.assign(Promise.resolve(state.listRows), { offset: () => Promise.resolve(state.listRows) }) }),
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
  state.listRows = [];
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
    // G-309 Exhibit D §6: a signed-in caller still gets no ICC text.
    const icc = res.body.results.find((r: { atomId: string }) => r.atomId === "a-icc");
    expect(icc).toBeDefined();
    expect(icc).not.toHaveProperty("bodyPreview");
    expect(icc.citationOnly).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("PLANTED-ICC-BODY");
    const city = res.body.results.find((r: { atomId: string }) => r.atomId === "a-city");
    expect(city.bodyPreview).toBe("city text");
    expect(city.citationOnly).toBe(false);
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

describe("G-309 Exhibit D §6: no ICC text for a signed-in user", () => {
  const iccRow = () => ({
    id: "a-icc",
    jurisdictionKey: "bastrop_tx",
    codeBook: "IBC",
    edition: "2021",
    sectionNumber: "1612.3",
    sectionTitle: "Flood",
    parentSection: null,
    body: "PLANTED-ICC-BODY",
    bodyHtml: "<p>PLANTED-ICC-BODY</p>",
    sourceUrl: "https://codes.iccsafe.org/content/IBC2021P1/chapter-16",
    embedding: null,
    embeddingModel: null,
    fetchedAt: new Date(),
    metadata: null,
    sourceName: "codes.iccsafe.org",
  });
  const cityRow = () => ({
    ...iccRow(),
    id: "a-city",
    codeBook: "City Ordinance",
    sectionNumber: "14-02-008",
    sectionTitle: "Setbacks",
    body: "city text",
    bodyHtml: "<p>city text</p>",
    sourceUrl: "https://library.municode.com/x",
    sourceName: "municode",
  });

  it("atom by id: a signed-in ICC atom has no body, bodyPreview or bodyHtml; a city atom keeps them", async () => {
    state.atomRow = iccRow();
    const icc = await request(app()).get("/api/codes/atoms/a-icc").set("x-test-user", "u1");
    expect(icc.status).toBe(200);
    expect(icc.body.sectionNumber).toBe("1612.3");
    expect(icc.body.sourceUrl).toContain("iccsafe.org");
    for (const k of ["body", "bodyPreview", "bodyHtml"]) expect(icc.body).not.toHaveProperty(k);
    expect(icc.body.citationOnly).toBe(true);
    expect(JSON.stringify(icc.body)).not.toContain("PLANTED");

    state.atomRow = cityRow();
    const city = await request(app()).get("/api/codes/atoms/a-city").set("x-test-user", "u1");
    expect(city.status).toBe(200);
    expect(city.body.body).toBe("city text");
    expect(city.body.bodyHtml).toBe("<p>city text</p>");
    expect(city.body.bodyPreview).toBe("city text");
    expect(city.body.citationOnly).toBe(false);
  });

  it("atom by id: ICC metadata is reduced to structural keys; a city atom keeps its metadata", async () => {
    const meta = {
      kind: "icc_section",
      scrapedAt: "2026-01-01T00:00:00.000Z",
      partIndex: 2,
      footnote: "PLANTED-META-TEXT",
      excerpt: "PLANTED-META-TEXT",
      nested: { text: "PLANTED-META-TEXT" },
    };
    state.atomRow = { ...iccRow(), metadata: meta };
    const icc = await request(app()).get("/api/codes/atoms/a-icc").set("x-test-user", "u1");
    expect(icc.status).toBe(200);
    expect(icc.body.metadata).toEqual({
      kind: "icc_section",
      scrapedAt: "2026-01-01T00:00:00.000Z",
      partIndex: 2,
    });
    expect(JSON.stringify(icc.body)).not.toContain("PLANTED");

    state.atomRow = { ...cityRow(), metadata: meta };
    const city = await request(app()).get("/api/codes/atoms/a-city").set("x-test-user", "u1");
    expect(city.body.metadata).toEqual(meta);
  });

  it("an ICC title from a non-ICC source (by codeBook) is also citation-only", async () => {
    state.atomRow = { ...cityRow(), codeBook: "IRC" };
    const res = await request(app()).get("/api/codes/atoms/a-city").set("x-test-user", "u1");
    expect(res.status).toBe(200);
    for (const k of ["body", "bodyPreview", "bodyHtml"]) expect(res.body).not.toHaveProperty(k);
  });

  it("both list endpoints: signed-in ICC rows have no bodyPreview, city rows keep it", async () => {
    state.listRows = [iccRow(), cityRow()];
    const perJurisdiction = await request(app())
      .get("/api/codes/jurisdictions/bastrop_tx/atoms")
      .set("x-test-user", "u1");
    const global = await request(app()).get("/api/codes/atoms").set("x-test-user", "u1");
    for (const rows of [perJurisdiction.body, global.body.items] as Array<Array<Record<string, unknown>>>) {
      expect(rows).toHaveLength(2);
      expect(rows[0]).not.toHaveProperty("bodyPreview");
      expect(rows[0]!.citationOnly).toBe(true);
      expect(rows[1]!.bodyPreview).toBe("city text");
      expect(rows[1]!.citationOnly).toBe(false);
    }
    expect(JSON.stringify([perJurisdiction.body, global.body])).not.toContain("PLANTED");
  });
});

// The session middleware gives every unauthenticated browser a requestor
// { kind: "user", id: "anon_<hex>" }. That is not a signed-in user.
describe("anonymous-owner sessions are not signed in", () => {
  const RANDOM_ANON = "anon_" + "0123456789abcdef01234567";
  const anonIds = [ANON_TEST_SESSION_OWNER_ID, RANDOM_ANON];
  const sessionOf = (id?: string) =>
    ({ session: id === undefined ? { audience: "user" } : { audience: "user", requestor: { kind: "user", id } } }) as never;

  it("hasSignedInUser: verified user true; anon ids, empty id, no session false", () => {
    expect(hasSignedInUser(sessionOf("u_verified1"))).toBe(true);
    for (const id of anonIds) expect(hasSignedInUser(sessionOf(id))).toBe(false);
    expect(hasSignedInUser(sessionOf(""))).toBe(false);
    expect(hasSignedInUser(sessionOf())).toBe(false);
    expect(hasSignedInUser({} as never)).toBe(false);
  });

  it.each(anonIds)("POST /api/dev/atoms/retrieve gives the signed-out response to %s", async (id) => {
    const res = await request(app())
      .post("/api/dev/atoms/retrieve")
      .set(SECRET)
      .set("x-test-user", id)
      .send({ jurisdiction: "bastrop_tx", query: "flood" });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { atomId: string }) => r.atomId)).toEqual(["a-city"]);
    expect(state.retrieveCalls[0]!["includeIccModelCodeSupplement"]).toBe(false);
  });

  it.each(anonIds)("GET /api/codes/atoms/:id is 404 for an ICC atom for %s", async (id) => {
    state.atomRow = {
      id: "a-icc", jurisdictionKey: "bastrop_tx", codeBook: "IBC", edition: "2021",
      sectionNumber: "1612.3", sectionTitle: "Flood", parentSection: null,
      body: "PLANTED-ICC-BODY", bodyHtml: null,
      sourceUrl: "https://codes.iccsafe.org/content/IBC2021P1/chapter-16",
      embedding: null, embeddingModel: null, fetchedAt: new Date(), metadata: null,
      sourceName: "codes.iccsafe.org",
    };
    const res = await request(app()).get("/api/codes/atoms/a-icc").set("x-test-user", id);
    expect(res.status).toBe(404);
  });

  it.each(anonIds)("list endpoints exclude ICC rows in SQL for %s", async (id) => {
    await request(app()).get("/api/codes/atoms").set("x-test-user", id);
    await request(app()).get("/api/codes/jurisdictions/bastrop_tx/atoms").set("x-test-user", id);
    const sqls = state.whereArgs.map((w) => new PgDialect().sqlToQuery(w as never).sql);
    expect(sqls.length).toBeGreaterThanOrEqual(3);
    expect(sqls.every((q) => /iccsafe/.test(q) && /NOT/.test(q))).toBe(true);
  });
});
