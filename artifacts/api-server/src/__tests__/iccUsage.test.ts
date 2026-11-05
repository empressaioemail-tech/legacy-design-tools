/**
 * A13c: the ICC usage-ledger writer. fetch is mocked; no network call is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logs = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("../lib/logger", () => {
  const rec = (...a: unknown[]) => {
    logs.calls.push(a);
  };
  return { logger: { warn: rec, info: rec, error: rec, debug: rec } };
});

const {
  recordIccUsage,
  iccCitationFromAtom,
  iccCitationsFromAtoms,
  iccCitationsCitedInText,
  iccCitationsForFindings,
} = await import("../lib/iccUsage");

const fetchMock = vi.fn();

const ICC_ATOM = {
  id: "a-icc",
  codeBook: "IBC",
  sectionNumber: "1612.3",
  sourceUrl: "https://codes.iccsafe.org/content/IBC2021P1/chapter-16",
  jurisdictionKey: "bastrop_tx",
  codeSource: "icc-model-code",
};
const ICC_ATOM_2 = { ...ICC_ATOM, id: "a-icc-2", sectionNumber: "1005.1" };
const CITY_ATOM = {
  id: "a-city",
  codeBook: "City Ordinance",
  sectionNumber: "14-02-008",
  sourceUrl: "https://library.municode.com/x",
  jurisdictionKey: "bastrop_tx",
  codeSource: "jurisdiction",
};

beforeEach(() => {
  logs.calls = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 201 });
  vi.stubGlobal("fetch", fetchMock);
  process.env["ICC_USAGE_LEDGER_URL"] = "https://plan-review.example.test";
  process.env["ICC_USAGE_LEDGER_TOKEN"] = "svc-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["ICC_USAGE_LEDGER_URL"];
  delete process.env["ICC_USAGE_LEDGER_TOKEN"];
});

const base = {
  requestId: "req-1",
  authorizedUser: "user-42",
  surface: "findings" as const,
};

describe("recordIccUsage", () => {
  it("writes one call with the contract shape and distinct ICC citations", async () => {
    await recordIccUsage({
      ...base,
      citations: [
        { bookId: "IBC2021P1", sectionId: "1612.3" },
        { bookId: "IBC2021P1", sectionId: "1612.3" },
        { bookId: "IBC2021P1", sectionId: "1005.1" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://plan-review.example.test/api/icc/usage");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer svc-token");
    expect(init.headers["x-usage-caller"]).toBe("smart-site");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      requestId: "req-1",
      authorizedUser: "user-42",
      product: "smart-site",
      surface: "findings",
      citations: [
        { bookId: "IBC2021P1", sectionId: "1612.3" },
        { bookId: "IBC2021P1", sectionId: "1005.1" },
      ],
    });
  });

  it("does not double the path when the URL already ends with it", async () => {
    process.env["ICC_USAGE_LEDGER_URL"] = "https://plan-review.example.test/api/icc/usage/";
    await recordIccUsage({ ...base, citations: [{ bookId: "IBC2021P1", sectionId: "1.1" }] });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://plan-review.example.test/api/icc/usage");
  });

  it("makes no call when only non-ICC citations are shown", async () => {
    await recordIccUsage({
      ...base,
      citations: [{ bookId: "City Ordinance", sectionId: "14-02-008" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["ICC_USAGE_LEDGER_URL"], ["ICC_USAGE_LEDGER_TOKEN"]])(
    "makes no call when %s is unset",
    async (name) => {
      delete process.env[name];
      await recordIccUsage({ ...base, citations: [{ bookId: "IBC2021P1", sectionId: "1.1" }] });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("makes no call for a user who is not signed in", async () => {
    await recordIccUsage({
      ...base,
      authorizedUser: null,
      citations: [{ bookId: "IBC2021P1", sectionId: "1.1" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a ledger failure does not throw and logs only the request id and a count", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom 1612.3 IBC2021P1"));
    await expect(
      recordIccUsage({ ...base, citations: [{ bookId: "IBC2021P1", sectionId: "1612.3" }] }),
    ).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(
      recordIccUsage({ ...base, citations: [{ bookId: "IBC2021P1", sectionId: "1612.3" }] }),
    ).resolves.toBeUndefined();
    expect(logs.calls.length).toBe(2);
    const dump = JSON.stringify(logs.calls);
    expect(dump).toContain("req-1");
    expect(dump).not.toContain("1612.3");
    expect(dump).not.toContain("IBC2021P1");
    expect(dump).not.toContain("svc-token");
  });

  it("a synchronous fetch failure does not throw", async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    await expect(
      recordIccUsage({ ...base, citations: [{ bookId: "IBC2021P1", sectionId: "1.1" }] }),
    ).resolves.toBeUndefined();
  });
});

describe("citation helpers", () => {
  it("maps an ICC atom to ids, using the content slug when the source has one", () => {
    expect(iccCitationFromAtom(ICC_ATOM)).toEqual({ bookId: "IBC2021P1", sectionId: "1612.3" });
    expect(iccCitationFromAtom({ ...ICC_ATOM, sourceUrl: "https://x.test/y" })).toEqual({
      bookId: "IBC",
      sectionId: "1612.3",
    });
  });

  it("drops non-ICC atoms and atoms with no section", () => {
    expect(iccCitationFromAtom(CITY_ATOM)).toBeNull();
    expect(iccCitationFromAtom({ ...ICC_ATOM, sectionNumber: null })).toBeNull();
    expect(iccCitationsFromAtoms([CITY_ATOM, ICC_ATOM])).toHaveLength(1);
  });

  it("chat: only atoms named by a [[CODE:id]] token in the answer count", () => {
    const atoms = [ICC_ATOM, ICC_ATOM_2, CITY_ATOM];
    expect(iccCitationsCitedInText("See this [[CODE:a-icc]] and [[CODE:a-city]].", atoms)).toEqual([
      { bookId: "IBC2021P1", sectionId: "1612.3" },
    ]);
    expect(iccCitationsCitedInText("no tokens here", atoms)).toEqual([]);
    expect(iccCitationsCitedInText("[[CODE:a-city]]", atoms)).toEqual([]);
  });

  it("findings: maps cited atom ids through the retrieved ICC map", () => {
    const map = new Map([["a-icc", { bookId: "IBC2021P1", sectionId: "1612.3" }]]);
    const rows = [
      { citations: [{ kind: "code", atomId: "a-icc" }, { kind: "code", atomId: "a-city" }] },
      { citations: [{ kind: "source", atomId: "s-1" }] },
      { citations: null },
    ];
    expect(iccCitationsForFindings(rows, map)).toEqual([
      { bookId: "IBC2021P1", sectionId: "1612.3" },
    ]);
  });
});
