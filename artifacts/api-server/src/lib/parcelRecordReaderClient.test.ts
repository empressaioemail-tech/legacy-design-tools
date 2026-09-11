import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchGateVerdict,
  fetchParcelRecord,
  resetGateVerdictFetcherForTests,
  resetParcelRecordFetcherForTests,
  setGateVerdictFetcherForTests,
  setParcelRecordFetcherForTests,
  type ParcelRecordWire,
} from "./parcelRecordReaderClient";
import {
  parcelRecordQueryableFromEnv,
  resetParcelRecordQueryableForTests,
} from "./parcelRecordCellRead";

const FIXTURE_RECORD: ParcelRecordWire = {
  parcelNodeId: "48021:34049",
  placeKey: "48021:34049",
  countyFips: "48021",
  railRegistrySha: "217b7dd7eb3a1b2f72f3a72d333008079f71fcaf",
  readAt: "2026-09-11T21:00:00.000Z",
  refused: null,
  rails: {
    cityLimits: {
      cell: { kind: "value", value: "Bastrop", source: "landing_parcel_jurisdiction", vintage: "2026-09-02T18:13:56.751Z" },
      gate: { verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" },
      serve: "record",
      atom: null,
      atomBacked: false,
      rendering: null,
      companions: [],
    },
    setbackRules: {
      cell: { kind: "value", source: "x", vintage: "y", disposition: "rows", rowCount: 1 },
      gate: { verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" },
      serve: "record",
      atom: null,
      atomBacked: false,
      rendering: null,
      companions: [{ rowIndex: 0, payload: { districtCode: "SF-1" }, source: "setback-corpus", vintage: "2026-09-10T22:33:31.180Z" }],
    },
    pipelines: {
      cell: null,
      gate: { verdict: null, evaluatedAt: null },
      serve: "legacy-transitional",
      atom: null,
      atomBacked: false,
      rendering: null,
      companions: [],
    },
  },
};

describe("parcelRecordReaderClient", () => {
  afterEach(() => {
    resetParcelRecordFetcherForTests();
    resetGateVerdictFetcherForTests();
    vi.restoreAllMocks();
  });

  it("coalesces concurrent fetchParcelRecord calls for the same parcel into one underlying HTTP call", async () => {
    // The test-injection seam (setParcelRecordFetcherForTests) deliberately
    // bypasses the cache entirely (see fetchParcelRecord's early return) --
    // it exists to let *callers* of this module fake its answer, not to
    // exercise the cache itself. Coalescing is real production behavior in
    // the un-injected path, so it must be proven against that path: mock
    // global fetch, not this module's own test seam.
    vi.stubEnv("RETRIEVAL_API_KEY", "test-key");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify(FIXTURE_RECORD), { status: 200 });
      }),
    );
    const [a, b, c] = await Promise.all([
      fetchParcelRecord("48021:34049"),
      fetchParcelRecord("48021:34049"),
      fetchParcelRecord("48021:34049"),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(FIXTURE_RECORD);
    expect(b).toEqual(FIXTURE_RECORD);
    expect(c).toEqual(FIXTURE_RECORD);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not cache a failed fetch, so the next call retries", async () => {
    let calls = 0;
    setParcelRecordFetcherForTests(async () => {
      calls++;
      return calls === 1 ? null : FIXTURE_RECORD;
    });
    const first = await fetchParcelRecord("48021:34049");
    const second = await fetchParcelRecord("48021:34049");
    expect(first).toBeNull();
    expect(second).toEqual(FIXTURE_RECORD);
    expect(calls).toBe(2);
  });

  it("fetchGateVerdict returns undefined (not null) on a fetch failure, distinguishing failure from a real null verdict", async () => {
    setGateVerdictFetcherForTests(async () => undefined);
    expect(await fetchGateVerdict("48021", "wells")).toBeUndefined();
  });

  it("fetchGateVerdict passes through a real null verdict (rail evaluated, no usable row)", async () => {
    setGateVerdictFetcherForTests(async () => null);
    expect(await fetchGateVerdict("48021", "wells")).toBeNull();
  });

  it("LIVE FINDING regression guard: falls back to BRIEF_RETRIEVAL_API_KEY/URL when neither HAUSKA_RETRIEVAL_API_KEY nor RETRIEVAL_API_KEY is set", async () => {
    // cortex's own cloud-run-deploy.yml (before this lane's fix) mounted
    // ONLY BRIEF_RETRIEVAL_API_KEY/BRIEF_RETRIEVAL_API_URL -- neither name
    // this module (or fetchPropertyAtomChain.ts) originally checked. Caught
    // by diffing a live canary deploy against a pre-capture baseline before
    // any traffic shift: every request silently found no key and every
    // gate-verdict lookup fell back to "no usable verdict". This test
    // proves the fallback exists; it does not (and cannot, without hitting
    // the network) prove the deployed BRIEF_RETRIEVAL_API_KEY value itself
    // is correct -- see the CLOSE artifact for that live verification.
    vi.stubEnv("BRIEF_RETRIEVAL_API_KEY", "brief-key");
    vi.stubEnv("BRIEF_RETRIEVAL_API_URL", "https://brief.example.com");
    let capturedUrl = "";
    let capturedAuth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        capturedUrl = String(url);
        capturedAuth = init.headers.Authorization;
        return new Response(JSON.stringify(FIXTURE_RECORD), { status: 200 });
      }),
    );
    await fetchParcelRecord("48021:34049");
    expect(capturedUrl).toBe("https://brief.example.com/property-nodes/48021%3A34049/record");
    expect(capturedAuth).toBe("Bearer brief-key");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("parcelRecordQueryableFromEnv adapter (P-152 repointed)", () => {
  beforeEach(() => {
    vi.stubEnv("RETRIEVAL_API_KEY", "test-key");
    resetParcelRecordQueryableForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetParcelRecordFetcherForTests();
    resetGateVerdictFetcherForTests();
    resetParcelRecordQueryableForTests();
  });

  it("returns null (not configured) when no retrieval API key is set", () => {
    vi.unstubAllEnvs();
    expect(parcelRecordQueryableFromEnv()).toBeNull();
  });

  it("answers a parcel_record_cell SELECT from the fetched record, verbatim", async () => {
    setParcelRecordFetcherForTests(async () => FIXTURE_RECORD);
    const store = parcelRecordQueryableFromEnv();
    const result = await store!.query("SELECT cell_state FROM parcel_record_cell WHERE place_key = $1 AND rail_key = $2", [
      "48021:34049",
      "cityLimits",
    ]);
    expect(result.rows).toEqual([{ cell_state: FIXTURE_RECORD.rails.cityLimits!.cell }]);
  });

  it("returns empty rows (never a fabricated row) when the rail's cell is null", async () => {
    setParcelRecordFetcherForTests(async () => FIXTURE_RECORD);
    const store = parcelRecordQueryableFromEnv();
    const result = await store!.query("SELECT cell_state FROM parcel_record_cell WHERE place_key = $1 AND rail_key = $2", [
      "48021:34049",
      "pipelines",
    ]);
    expect(result.rows).toEqual([]);
  });

  it("answers a parcel_record_companion_row SELECT with the fetched companions", async () => {
    setParcelRecordFetcherForTests(async () => FIXTURE_RECORD);
    const store = parcelRecordQueryableFromEnv();
    const result = await store!.query(
      "SELECT row_index, payload, source, vintage FROM parcel_record_companion_row WHERE place_key = $1 AND rail_key = $2",
      ["48021:34049", "setbackRules"],
    );
    expect(result.rows).toEqual([
      { row_index: 0, payload: { districtCode: "SF-1" }, source: "setback-corpus", vintage: "2026-09-10T22:33:31.180Z" },
    ]);
  });

  it("answers a parcel_gate_verdict SELECT via fetchGateVerdict, not the parcel fetch", async () => {
    setGateVerdictFetcherForTests(async (countyFips, railKey) => {
      expect(countyFips).toBe("48021");
      expect(railKey).toBe("cityLimits");
      return { verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" };
    });
    const store = parcelRecordQueryableFromEnv();
    const result = await store!.query(
      "SELECT county_fips, rail_key, verdict, unaccounted_count, evaluated_at, run_id FROM parcel_gate_verdict WHERE county_fips = $1 AND rail_key = $2",
      ["48021", "cityLimits"],
    );
    expect(result.rows).toEqual([
      {
        county_fips: "48021",
        rail_key: "cityLimits",
        verdict: "pass",
        unaccounted_count: 0,
        evaluated_at: "2026-09-11T20:03:09.067Z",
        run_id: "hauska-retrieval-api",
      },
    ]);
  });

  it("throws (never returns a silent empty result) when the parcel fetch fails", async () => {
    setParcelRecordFetcherForTests(async () => null);
    const store = parcelRecordQueryableFromEnv();
    await expect(
      store!.query("SELECT cell_state FROM parcel_record_cell WHERE place_key = $1 AND rail_key = $2", [
        "48021:34049",
        "cityLimits",
      ]),
    ).rejects.toThrow();
  });

  it("throws when the parcel is crosswalk-ambiguous (refused), never serving a rail from it", async () => {
    setParcelRecordFetcherForTests(async () => ({
      ...FIXTURE_RECORD,
      placeKey: null,
      rails: {},
      refused: { reason: "crosswalk ambiguous" },
    }));
    const store = parcelRecordQueryableFromEnv();
    await expect(
      store!.query("SELECT cell_state FROM parcel_record_cell WHERE place_key = $1 AND rail_key = $2", [
        "48021:34049",
        "cityLimits",
      ]),
    ).rejects.toThrow(/crosswalk ambiguous/);
  });

  it("throws when the gate-verdict fetch fails", async () => {
    setGateVerdictFetcherForTests(async () => undefined);
    const store = parcelRecordQueryableFromEnv();
    await expect(
      store!.query(
        "SELECT county_fips, rail_key, verdict, unaccounted_count, evaluated_at, run_id FROM parcel_gate_verdict WHERE county_fips = $1 AND rail_key = $2",
        ["48021", "cityLimits"],
      ),
    ).rejects.toThrow();
  });
});
