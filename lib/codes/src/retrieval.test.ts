/**
 * retrieval.ts unit tests with @workspace/db and ./embeddings mocked out.
 *
 * The drizzle query builder is chainable and thenable; we mock it with a
 * Proxy that lets every chained call return another chainable, with `await`
 * resolving to whatever rows the test queued via `mocks.dbResponses.push()`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbResponses: [] as unknown[][],
  embedQueryResult: null as number[] | null,
  embedQuerySpy: undefined as undefined | ((q: string) => void),
}));

function chainable(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        const rows = mocks.dbResponses.shift() ?? [];
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => chainable();
    },
  });
}

vi.mock("@workspace/db", () => ({
  db: { select: () => chainable() },
  codeAtoms: {},
  codeAtomSources: {},
}));

vi.mock("./embeddings", () => ({
  embedQuery: vi.fn(async (q: string) => {
    mocks.embedQuerySpy?.(q);
    return mocks.embedQueryResult;
  }),
}));

import {
  retrieveAtomsForQuestion,
  getAtomsByIds,
  MIN_VECTOR_SCORE,
} from "./retrieval";

beforeEach(() => {
  mocks.dbResponses = [];
  mocks.embedQueryResult = null;
  mocks.embedQuerySpy = undefined;
});

const stubAtomRow = (overrides: Record<string, unknown> = {}) => ({
  id: "atom-1",
  sourceName: "grand_county_html",
  jurisdictionKey: "grand_county_ut",
  codeBook: "IRC_R301_2_1",
  edition: "IRC 2021",
  sectionNumber: "R301.2(1)",
  sectionTitle: "Climatic and Geographic Design Criteria",
  body: "ground snow load 50 psf wind 110 mph",
  sourceUrl: "https://example.com/r301",
  distance: 0.2,
  ...overrides,
});

describe("retrieveAtomsForQuestion: vector path", () => {
  it("returns vector results when embedQuery succeeds and rows exist", async () => {
    mocks.embedQueryResult = Array.from({ length: 1536 }, () => 0);
    mocks.dbResponses.push([stubAtomRow({ distance: 0.1 })]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "ground snow load",
    });
    expect(out).toHaveLength(1);
    expect(out[0].retrievalMode).toBe("vector");
    expect(out[0].score).toBeCloseTo(0.9, 5); // 1 - 0.1
    expect(out[0].id).toBe("atom-1");
  });

  it("calls embedQuery with the user's question", async () => {
    let called: string | null = null;
    mocks.embedQuerySpy = (q) => {
      called = q;
    };
    mocks.embedQueryResult = [0];
    mocks.dbResponses.push([stubAtomRow()]);
    await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "what is the design wind speed?",
    });
    expect(called).toBe("what is the design wind speed?");
  });

  it("falls through to lexical when embedQuery returns null", async () => {
    mocks.embedQueryResult = null;
    // Vector path is skipped entirely; only the lexical select runs.
    mocks.dbResponses.push([
      {
        id: "atom-2",
        sourceName: "src",
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC",
        edition: "IRC 2021",
        sectionNumber: "R301.2(1)",
        sectionTitle: "Snow load",
        body: "ground snow load 50 psf",
        sourceUrl: "https://example.com/x",
      },
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "ground snow load psf",
    });
    expect(out).toHaveLength(1);
    expect(out[0].retrievalMode).toBe("lexical");
    expect(out[0].score).toBeGreaterThan(0);
  });

  it("filters out vector results below MIN_VECTOR_SCORE by default", async () => {
    // Two raw rows: one comfortably above the floor, one well below.
    // Default behavior (chat path) should drop the below-floor row.
    mocks.embedQueryResult = Array.from({ length: 1536 }, () => 0);
    mocks.dbResponses.push([
      stubAtomRow({ id: "above", distance: 1 - (MIN_VECTOR_SCORE + 0.05) }),
      stubAtomRow({ id: "below", distance: 1 - (MIN_VECTOR_SCORE - 0.05) }),
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "setbacks",
    });
    expect(out.map((r) => r.id)).toEqual(["above"]);
    expect(out[0].score).toBeGreaterThanOrEqual(MIN_VECTOR_SCORE);
  });

  it("returns the unfiltered top-N when applyMinScore=false (probe path)", async () => {
    mocks.embedQueryResult = Array.from({ length: 1536 }, () => 0);
    mocks.dbResponses.push([
      stubAtomRow({ id: "above", distance: 1 - (MIN_VECTOR_SCORE + 0.05) }),
      stubAtomRow({ id: "below", distance: 1 - (MIN_VECTOR_SCORE - 0.05) }),
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "setbacks",
      applyMinScore: false,
    });
    expect(out.map((r) => r.id)).toEqual(["above", "below"]);
  });

  it("returns [] (does NOT fall back to lexical) when vector rows exist but all are below the floor", async () => {
    // Vector path returned 2 rows, but both are below the floor. Returning
    // [] is a *true negative* — backfilling with lexical would just inject
    // even-less-relevant atoms into chat. The lexical fallback only fires
    // when the raw DB query returned 0 rows.
    mocks.embedQueryResult = Array.from({ length: 1536 }, () => 0);
    mocks.dbResponses.push([
      stubAtomRow({ id: "low1", distance: 1 - (MIN_VECTOR_SCORE - 0.1) }),
      stubAtomRow({ id: "low2", distance: 1 - (MIN_VECTOR_SCORE - 0.2) }),
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "setbacks",
    });
    expect(out).toEqual([]);
  });

  it("falls through to lexical when vector returns 0 rows", async () => {
    mocks.embedQueryResult = [0];
    mocks.dbResponses.push([]); // vector path: empty
    mocks.dbResponses.push([
      {
        id: "atom-3",
        sourceName: "src",
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC",
        edition: "IRC 2021",
        sectionNumber: "R301.2(1)",
        sectionTitle: "Wind load",
        body: "wind 110 mph design",
        sourceUrl: "https://example.com/y",
      },
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "wind design",
    });
    expect(out).toHaveLength(1);
    expect(out[0].retrievalMode).toBe("lexical");
  });
});

describe("retrieveAtomsForQuestion: lexical path scoring", () => {
  it("ranks higher when more terms match more times", async () => {
    mocks.embedQueryResult = null;
    mocks.dbResponses.push([
      {
        id: "lo",
        sourceName: "s",
        jurisdictionKey: "k",
        codeBook: "B",
        edition: "E",
        sectionNumber: "1",
        sectionTitle: "Other",
        body: "snow once",
        sourceUrl: "u",
      },
      {
        id: "hi",
        sourceName: "s",
        jurisdictionKey: "k",
        codeBook: "B",
        edition: "E",
        sectionNumber: "2",
        sectionTitle: "Snow load section",
        body: "snow snow snow load load",
        sourceUrl: "u",
      },
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "k",
      question: "snow load",
    });
    expect(out.map((r) => r.id)).toEqual(["hi", "lo"]);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it("filters out rows with zero matches", async () => {
    mocks.embedQueryResult = null;
    mocks.dbResponses.push([
      {
        id: "match",
        sourceName: "s",
        jurisdictionKey: "k",
        codeBook: "B",
        edition: "E",
        sectionNumber: "1",
        sectionTitle: "Snow",
        body: "snow load is 50 psf",
        sourceUrl: "u",
      },
      {
        id: "nomatch",
        sourceName: "s",
        jurisdictionKey: "k",
        codeBook: "B",
        edition: "E",
        sectionNumber: "2",
        sectionTitle: "Plumbing",
        body: "pipes and faucets",
        sourceUrl: "u",
      },
    ]);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "k",
      question: "snow",
    });
    expect(out.map((r) => r.id)).toEqual(["match"]);
  });

  it("returns [] when the question has only short tokens", async () => {
    mocks.embedQueryResult = null;
    // Short tokens (< 3 chars) are filtered. With no terms left, we early-return [].
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "k",
      question: "is a 1?",
    });
    expect(out).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    mocks.embedQueryResult = null;
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      sourceName: "s",
      jurisdictionKey: "k",
      codeBook: "B",
      edition: "E",
      sectionNumber: String(i),
      sectionTitle: "Snow",
      body: "snow snow snow",
      sourceUrl: "u",
    }));
    mocks.dbResponses.push(rows);
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "k",
      question: "snow",
      limit: 2,
    });
    expect(out).toHaveLength(2);
  });
});

describe("getAtomsByIds", () => {
  it("returns [] for an empty id list (no DB call)", async () => {
    const out = await getAtomsByIds([], "k");
    expect(out).toEqual([]);
  });

  it("hydrates atoms with retrievalMode='explicit' and score=1", async () => {
    mocks.dbResponses.push([
      {
        id: "abc",
        sourceName: "s",
        jurisdictionKey: "k",
        codeBook: "B",
        edition: "E",
        sectionNumber: "1",
        sectionTitle: "T",
        body: "b",
        sourceUrl: "u",
      },
    ]);
    const out = await getAtomsByIds(["abc"], "k");
    expect(out).toHaveLength(1);
    expect(out[0].retrievalMode).toBe("explicit");
    expect(out[0].score).toBe(1);
  });
});
