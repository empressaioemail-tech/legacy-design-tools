/**
 * G-309 ingest guard: no writer persists section text for an ICC-title atom.
 *
 * Function-boundary tests (no Postgres): the db handle is a recording fake so
 * we can assert exactly what each write path hands to INSERT / UPDATE. Text in
 * these tests is synthetic ("PLANTED-ICC-...") placeholder text, never real
 * code text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  // Importing the real schema module builds a pg Pool; it connects lazily, so a
  // placeholder DSN is enough. No test here opens a connection.
  process.env.DATABASE_URL ??= "postgres://placeholder:placeholder@127.0.0.1:1/placeholder";
  return {
    existing: [] as unknown[],
    writes: [] as Array<{ op: "insert" | "update"; values: Record<string, unknown> }>,
  };
});

vi.mock("@workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  const fake = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = Promise.resolve(mocks.existing) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>;
          };
          rows.limit = () => Promise.resolve(mocks.existing);
          return rows;
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        mocks.writes.push({ op: "insert", values });
        return { returning: async () => [{ ...baseRow(), ...values }] };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.writes.push({ op: "update", values });
        return {
          where: () => ({
            returning: async () => [{ ...baseRow(), ...(mocks.existing[0] as object), ...values }],
          }),
        };
      },
    }),
  };
  return { ...actual, db: fake };
});

vi.mock("./embeddings", () => ({
  embedTexts: async (texts: string[]) => ({
    vectors: texts.map(() => null),
    embeddedAny: false,
    skipReason: "no_api_key" as const,
  }),
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIMENSIONS: 1536,
}));

function baseRow() {
  const now = new Date();
  return {
    id: "reasoning:x:y",
    jurisdictionKey: "j",
    codeRef: "c",
    edition: "e",
    editionSlug: "e",
    sources: [],
    reasoning: null,
    assertedConfidence: "0.5",
    verificationState: "verified",
    snippet: null,
    displayMode: "deeplink",
    calibratedConfidence: null,
    sourceSetVersion: 1,
    calibrationStale: false,
    accessPolicy: "platform-internal",
    createdAt: now,
    updatedAt: now,
  };
}

import {
  guardCodeAtomText,
  guardReasoningText,
  logIccTextRefused,
  ICC_TEXT_REFUSED_EVENT,
} from "./iccIngestGuard";
import { buildCodeAtomRow } from "./orchestrator";
import {
  upsertReasoningAtomFromWebFetch,
  upsertReasoningAtomCorpusOverlay,
  upsertReasoningAtomDeeplinkOnly,
} from "./reasoningAtoms/persist";
import { rollbackReasoningVerification } from "./reasoningAtoms/snapshot";
import { reasoningSummaryFromFetch } from "./reasoningAtoms/snippet";

const PLANTED = "PLANTED-ICC-section-text-000";
const NOW = new Date("2026-01-01T00:00:00Z");

const queueRow = (over: Record<string, string> = {}) => ({
  sourceId: "src-1",
  jurisdictionKey: "bastrop_tx",
  codeBook: "IBC",
  edition: "2021",
  sourceName: "municode_bastrop",
  ...over,
});
const cand = (over: Record<string, unknown> = {}) => ({
  sectionRef: "1004.5",
  sectionTitle: "Title only",
  body: PLANTED,
  bodyHtml: `<p>${PLANTED}</p>`,
  sourceUrl: "https://example.test/ibc/1004.5",
  ...over,
});

beforeEach(() => {
  mocks.existing = [];
  mocks.writes = [];
});

describe("code_atoms: orchestrator row builder", () => {
  it("ICC-title atom keeps citation fields, loses text and vector", () => {
    const { row, refused } = buildCodeAtomRow(queueRow(), cand() as never, [0.1, 0.2], NOW);
    expect(refused).toBe(true);
    expect(row.body).toBe("");
    expect(row.bodyHtml).toBeNull();
    expect(row.embedding).toBeNull();
    expect(row.embeddingModel).toBeNull();
    expect(row.embeddedAt).toBeNull();
    // citation fields kept
    expect(row.codeBook).toBe("IBC");
    expect(row.sectionNumber).toBe("1004.5");
    expect(row.sectionTitle).toBe("Title only");
    expect(row.edition).toBe("2021");
    expect(row.sourceUrl).toBe("https://example.test/ibc/1004.5");
    expect(row.contentHash).toMatch(/\S/);
    expect(JSON.stringify(row)).not.toContain("PLANTED-ICC");
  });

  it("ICC source host on a non-ICC book is blanked too", () => {
    const { row, refused } = buildCodeAtomRow(
      queueRow({ codeBook: "City Code" }),
      cand({ sourceUrl: "https://codes.iccsafe.org/content/x" }) as never,
      null,
      NOW,
    );
    expect(refused).toBe(true);
    expect(row.body).toBe("");
  });

  it("non-ICC atom persists text unchanged", () => {
    const { row, refused } = buildCodeAtomRow(
      queueRow({ codeBook: "Local Zoning Ordinance" }),
      cand({ body: "ordinary city text", bodyHtml: "<p>ordinary</p>", sectionRef: "Sec. 4" }) as never,
      [0.5],
      NOW,
    );
    expect(refused).toBe(false);
    expect(row.body).toBe("ordinary city text");
    expect(row.bodyHtml).toBe("<p>ordinary</p>");
    expect(row.embedding).toEqual([0.5]);
    expect(row.embeddingModel).toBe("text-embedding-3-small");
  });

  it("content_hash is the same whether or not the text was blanked", () => {
    const a = buildCodeAtomRow(queueRow(), cand() as never, null, NOW).row.contentHash;
    const b = buildCodeAtomRow(queueRow(), cand() as never, [1], NOW).row.contentHash;
    expect(a).toBe(b);
  });
});

describe("guardCodeAtomText (shared by every code_atoms writer)", () => {
  it("blanks an ICC-title row and passes a plain row through", () => {
    const icc = guardCodeAtomText(
      { body: PLANTED, bodyHtml: PLANTED, embedding: [1], embeddingModel: "m", embeddedAt: NOW },
      { codeBook: "IRC" },
    );
    expect(icc.refused).toBe(true);
    expect(icc.row).toMatchObject({ body: "", bodyHtml: null, embedding: null, embeddingModel: null, embeddedAt: null });
    const plain = guardCodeAtomText({ body: "x", embedding: [1] }, { codeBook: "Local" });
    expect(plain.refused).toBe(false);
    expect(plain.row.body).toBe("x");
  });
});

const webResult = (over: Record<string, unknown> = {}) => ({
  sourceUrl: "https://example.test/section",
  sourceName: "municode",
  edition: "2021",
  retrievedAt: NOW.toISOString(),
  verified: true,
  confidence: 0.9,
  text: PLANTED,
  ...over,
});
// edition is the reasoning_atoms code-book field ("<code> <edition>").
const target = (codeRef: string, edition = "2021") => ({
  codeRef,
  edition,
  editionSlug: edition.toLowerCase().replace(/\s+/g, "-"),
});
const expectedReasoning = (codeRef: string, edition: string, sourceName = "municode") =>
  reasoningSummaryFromFetch({ codeRef, edition, verified: true, sourceName });

describe("reasoning_atoms write paths: snippet nulled, reasoning untouched", () => {
  it("icc-title (edition IBC) INSERT: snippet null, reasoning byte-identical to the template", async () => {
    await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: "bastrop_tx",
      target: target("1004.5", "IBC 2021") as never,
      result: webResult() as never,
    });
    const w = mocks.writes[0];
    expect(w.op).toBe("insert");
    expect(w.values.snippet).toBeNull();
    expect(w.values.reasoning).toBe(expectedReasoning("1004.5", "IBC 2021"));
    expect(JSON.stringify(w.values)).not.toContain("PLANTED-ICC");
  });

  it("icc-source-link (FBC edition, iccsafe link) INSERT: snippet null, reasoning preserved", async () => {
    await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: "miami_beach_fl",
      target: target("M601.6", "FBC 2023") as never,
      result: webResult({ sourceUrl: "https://codes.iccsafe.org/content/x" }) as never,
    });
    const w = mocks.writes[0];
    expect(w.values.snippet).toBeNull();
    expect(w.values.reasoning).toBe(expectedReasoning("M601.6", "FBC 2023"));
  });

  it("icc-source-link UPDATE: snippet null, reasoning preserved", async () => {
    mocks.existing = [
      { ...baseRow(), snippet: PLANTED, reasoning: "prior", sources: [], verificationState: "unverified-web-source" },
    ];
    await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: "miami_beach_fl",
      target: target("M601.6", "FBC 2023") as never,
      result: webResult({ sourceUrl: "https://codes.iccsafe.org/content/x" }) as never,
    });
    const w = mocks.writes[0];
    expect(w.op).toBe("update");
    expect(w.values.snippet).toBeNull();
    expect(w.values.reasoning).toBe(expectedReasoning("M601.6", "FBC 2023"));
  });

  it("TAS row with no ICC link keeps its snippet and reasoning", async () => {
    await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: "miami_beach_fl",
      target: target("404.2", "TAS 2012") as never,
      result: webResult({ text: "ordinary city text" }) as never,
    });
    const w = mocks.writes[0];
    expect(w.values.snippet).toBe("ordinary city text");
    expect(w.values.reasoning).toBe(expectedReasoning("404.2", "TAS 2012"));
  });

  it("code_ref and edition_slug never classify: ref IBC-looking, edition TAS, no ICC link", async () => {
    await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: "miami_beach_fl",
      target: { codeRef: "IBC 1004", edition: "TAS 2012", editionSlug: "ibc-2021" } as never,
      result: webResult({ text: "ordinary city text" }) as never,
    });
    expect(mocks.writes[0].values.snippet).toBe("ordinary city text");
  });

  it("corpus-overlay and deeplink-only: reasoning kept for ICC rows (fixed literal), snippet null", async () => {
    await upsertReasoningAtomCorpusOverlay({
      jurisdictionKey: "bastrop_tx",
      target: target("R301", "IRC 2021") as never,
      corpusSourceUrl: "https://example.test/x",
      corpusAtomId: "atom-1",
    });
    await upsertReasoningAtomDeeplinkOnly({
      jurisdictionKey: "bastrop_tx",
      target: target("903", "IFC 2021") as never,
      deeplinkUrl: "https://example.test/y",
    });
    for (const w of mocks.writes) {
      expect(typeof w.values.reasoning).toBe("string");
      expect((w.values.reasoning as string).length).toBeGreaterThan(0);
    }
    expect(mocks.writes[1].values.snippet).toBeNull();
  });

  it("rollback from a snapshot cannot restore planted ICC snippets; reasoning restored as written", async () => {
    const mkRow = (id: string, edition: string, sources: unknown[] = []) => ({
      id,
      edition,
      jurisdictionKey: "miami_beach_fl",
      verificationState: "verified",
      snippet: PLANTED,
      reasoning: `reasoning-${id}`,
      sources: sources as never,
      assertedConfidence: "0.5",
    });
    await rollbackReasoningVerification({
      jurisdictionKey: "miami_beach_fl",
      capturedAt: NOW.toISOString(),
      rows: [
        mkRow("title", "IBC 2021"),
        mkRow("link", "FBC 2023", [{ url: "https://codes.iccsafe.org/x", verified: true }]),
        mkRow("tas", "TAS 2012"),
      ],
    });
    expect(mocks.writes[0].values.snippet).toBeNull();
    expect(mocks.writes[0].values.reasoning).toBe("reasoning-title");
    expect(mocks.writes[1].values.snippet).toBeNull();
    expect(mocks.writes[1].values.reasoning).toBe("reasoning-link");
    expect(mocks.writes[2].values.snippet).toBe(PLANTED); // TAS row, no ICC link: not ICC
    expect(mocks.writes[2].values.reasoning).toBe("reasoning-tas");
  });

  it("guardReasoningText leaves a plain row alone", () => {
    const r = guardReasoningText({ snippet: "a" }, { edition: "TAS 2012", jurisdictionKey: "j" });
    expect(r.refused).toBe(false);
    expect(r.values).toEqual({ snippet: "a" });
  });
});

describe("icc_text_refused_at_ingest log event", () => {
  it("carries source and count only, no text", async () => {
    const calls: Array<[unknown, string]> = [];
    const log = { info: (o: unknown, m: string) => calls.push([o, m]) };
    await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: "bastrop_tx",
      target: target("1004.5", "IBC 2021") as never,
      result: webResult() as never,
      logger: log,
    });
    expect(calls).toHaveLength(1);
    const [obj, msg] = calls[0];
    expect(msg).toBe(ICC_TEXT_REFUSED_EVENT);
    expect(obj).toEqual({
      event: "icc_text_refused_at_ingest",
      source: "persist.upsertReasoningAtomFromWebFetch.insert",
      count: 1,
    });
    expect(JSON.stringify(calls)).not.toContain("PLANTED-ICC");
  });

  it("is silent for a zero count", () => {
    const calls: unknown[] = [];
    logIccTextRefused({ info: (o) => calls.push(o) }, "x", 0);
    expect(calls).toHaveLength(0);
  });
});
