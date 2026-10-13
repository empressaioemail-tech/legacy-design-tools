/**
 * ONE DOOR (WP-L): the typed reader client. No DB.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ONE_DOOR_ENTITLEMENTS_HEADER,
  ONE_DOOR_GATED_RAILS,
  ONE_DOOR_STATES,
  ONE_DOOR_TRANSPORT_FAILED_WORDS,
  enforceOneDoorEntitlements,
  lastKnownOneDoorMode,
  oneDoorEntitlementsFor,
  oneDoorEntitlementsHeaderValue,
  parseOneDoorRecord,
  readOneDoorRecord,
  setOneDoorFetcherForTests,
  resetOneDoorModeMemoryForTests,
  type OneDoorFetcher,
} from "../lib/oneDoor/oneDoorReaderClient";
import { OD_PARCEL, OD_WORDS, odDefaultFacts, odReaderBody, odState, odValue } from "./oneDoorFixtures";

afterEach(() => {
  setOneDoorFetcherForTests(null);
  resetOneDoorModeMemoryForTests();
});

function fetcherReturning(body: unknown, status = 200) {
  const calls: Array<{ parcelNodeId: string; entitlementsHeader: string | null }> = [];
  const fetcher: OneDoorFetcher = async (args) => {
    calls.push({ parcelNodeId: args.parcelNodeId, entitlementsHeader: args.entitlementsHeader });
    return { kind: "ok", status, body };
  };
  return { calls, fetcher };
}

describe("parseOneDoorRecord (the one place WP-R's field names live)", () => {
  it("reads every one of the seven states with its words verbatim", () => {
    const facts: Record<string, unknown> = {};
    for (const state of ONE_DOOR_STATES) {
      facts[`rail-${state}`] = state === "value" ? odValue("V") : odState(state);
    }
    const rec = parseOneDoorRecord(odReaderBody("on", facts), OD_PARCEL)!;
    expect(rec.mode).toBe("on");
    for (const state of ONE_DOOR_STATES) {
      const fact = rec.facts[`rail-${state}`]!;
      expect(fact.state).toBe(state);
      if (state === "value") expect(fact.value).toBe("V");
      else {
        expect(fact.words).toBe(OD_WORDS[state]);
        expect("value" in fact).toBe(false);
      }
    }
  });

  it("a body with no recognised mode (today's pre-WP-R /record) is `off` and carries no one-door facts", () => {
    const legacy = {
      parcelNodeId: OD_PARCEL,
      countyFips: "48209",
      rails: { apn: { cell: { kind: "value", value: "R1" }, serve: "record", gate: { verdict: "pass" } } },
      refused: null,
    };
    const rec = parseOneDoorRecord(legacy, OD_PARCEL)!;
    expect(rec.mode).toBe("off");
    expect(rec.facts).toEqual({});
  });

  it("drops a fact whose state is not one of the seven (the surface omits it, never words it)", () => {
    const rec = parseOneDoorRecord(
      odReaderBody("on", { a: { state: "absent-verified", words: "x" }, b: odState("held") }),
      OD_PARCEL,
    )!;
    expect(Object.keys(rec.facts)).toEqual(["b"]);
  });

  it("a `value` state with no value is downgraded to `failed`, never a fabricated value", () => {
    const rec = parseOneDoorRecord(odReaderBody("on", { a: { state: "value", words: "" } }), OD_PARCEL)!;
    expect(rec.facts.a!.state).toBe("failed");
    expect(rec.facts.a!.words).toBe(ONE_DOOR_TRANSPORT_FAILED_WORDS);
  });

  it("a body that does not declare contract one-door-v1 is off, whatever mode/facts it carries", () => {
    const rec = parseOneDoorRecord({ mode: "on", facts: { apn: odValue("R1") } }, OD_PARCEL)!;
    expect(rec.mode).toBe("off");
    expect(rec.facts).toEqual({});
  });
});

describe("entitlements from the END USER's plan (#813/#814 predicate)", () => {
  it("anonymous / Solo (no owner co-gate grant): no gated rails, no header", () => {
    expect(oneDoorEntitlementsFor(false)).toEqual([]);
    expect(oneDoorEntitlementsHeaderValue(oneDoorEntitlementsFor(false))).toBeNull();
  });

  it("Studio / Team / unlock on this parcel: every gated rail, comma list", () => {
    const list = oneDoorEntitlementsFor(true);
    expect([...list].sort()).toEqual([...ONE_DOOR_GATED_RAILS].sort());
    const header = oneDoorEntitlementsHeaderValue(list)!;
    expect(header.split(",").sort()).toEqual([...ONE_DOOR_GATED_RAILS].sort());
    for (const rail of ["owner", "marketValue", "assessedValue", "landValue", "improvementValue", "valueHistory", "exemptionCodes"]) {
      expect(header.split(",")).toContain(rail);
    }
  });

  it("the header travels on the wire to the reader (real fetch, local server)", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(odReaderBody("on")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const prev = { url: process.env.HAUSKA_RETRIEVAL_API_URL, key: process.env.HAUSKA_RETRIEVAL_API_KEY };
    process.env.HAUSKA_RETRIEVAL_API_URL = `http://127.0.0.1:${port}`;
    process.env.HAUSKA_RETRIEVAL_API_KEY = "one-door-test-key";
    try {
      setOneDoorFetcherForTests(null);
      const studio = await readOneDoorRecord(OD_PARCEL, { entitlements: oneDoorEntitlementsFor(true) });
      const anon = await readOneDoorRecord(OD_PARCEL, { entitlements: oneDoorEntitlementsFor(false) });
      expect(studio.kind).toBe("record");
      expect(anon.kind).toBe("record");
      const header = ONE_DOOR_ENTITLEMENTS_HEADER.toLowerCase();
      expect(String(seen[0]![header]).split(",").sort()).toEqual([...ONE_DOOR_GATED_RAILS].sort());
      expect(seen[1]![header]).toBeUndefined();
      expect(seen[0]!.authorization).toBe("Bearer one-door-test-key");
    } finally {
      process.env.HAUSKA_RETRIEVAL_API_URL = prev.url;
      process.env.HAUSKA_RETRIEVAL_API_KEY = prev.key;
      if (prev.url === undefined) delete process.env.HAUSKA_RETRIEVAL_API_URL;
      if (prev.key === undefined) delete process.env.HAUSKA_RETRIEVAL_API_KEY;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("guard: a gated VALUE the caller is not entitled to never reaches a surface", () => {
    const rec = parseOneDoorRecord(
      odReaderBody("on", { owner: odValue({ ownerName: "SYNTHETIC OWNER" }), apn: odValue("R1") }),
      OD_PARCEL,
    )!;
    const anon = enforceOneDoorEntitlements(rec, []);
    expect(anon.facts.owner!.state).toBe("plan-gated");
    expect(JSON.stringify(anon)).not.toContain("SYNTHETIC OWNER");
    expect(anon.facts.apn!.value).toBe("R1");
    const studio = enforceOneDoorEntitlements(rec, oneDoorEntitlementsFor(true));
    expect(studio.facts.owner!.state).toBe("value");
  });
});

describe("readOneDoorRecord", () => {
  it("returns the reader's mode per request, as the end user", async () => {
    const { calls, fetcher } = fetcherReturning(odReaderBody("shadow"));
    setOneDoorFetcherForTests(fetcher);
    const read = await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    expect(read.kind).toBe("record");
    expect(read.kind === "record" && read.record.mode).toBe("shadow");
    expect(calls[0]!.entitlementsHeader).toBeNull();
  });

  it("parcel-not-found is its own outcome, distinct from not-loaded", async () => {
    setOneDoorFetcherForTests(
      fetcherReturning(
        { error: "not_found", errorClass: "parcel-not-found", parcelNodeId: OD_PARCEL, countyFips: "48209", contract: "one-door-v1", mode: "on", message: "x" },
        404,
      ).fetcher,
    );
    const read = await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    expect(read).toEqual({ kind: "parcel-not-found", mode: "on" });
  });

  it("unreachable reader: falls back to the county's last-seen mode, else off", async () => {
    setOneDoorFetcherForTests(async () => ({ kind: "timeout" }));
    expect(await readOneDoorRecord(OD_PARCEL, { entitlements: [] })).toEqual({
      kind: "unavailable",
      reason: "timeout",
      mode: "off",
    });
    // Learn that 48209 is `on`, then lose the reader.
    let up = true;
    const fetcher: OneDoorFetcher = async () =>
      up ? { kind: "ok", status: 200, body: odReaderBody("on") } : { kind: "network" };
    setOneDoorFetcherForTests(fetcher);
    await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    expect(lastKnownOneDoorMode("48209")).toBe("on");
    up = false;
    const read = await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    expect(read).toEqual({ kind: "unavailable", reason: "network", mode: "on" });
  });

  it("503 read-failed / timeout / store-not-configured: the reader's failed facts and mode are served", async () => {
    for (const errorClass of ["read-failed", "timeout", "store-not-configured"]) {
      setOneDoorFetcherForTests(
        fetcherReturning(
          {
            error: "unavailable",
            errorClass,
            parcelNodeId: OD_PARCEL,
            countyFips: "48209",
            contract: "one-door-v1",
            mode: "on",
            facts: { apn: odState("failed"), situsAddress: odState("failed") },
            message: "x",
          },
          503,
        ).fetcher,
      );
      const read = await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
      expect(read.kind).toBe("record");
      if (read.kind === "record") {
        expect(read.record.mode).toBe("on");
        expect(read.record.facts.apn!.state).toBe("failed");
        expect(read.record.facts.apn!.words).toBe(OD_WORDS.failed);
      }
    }
  });

  it("a 404 without errorClass parcel-not-found is unavailable, not a not-found", async () => {
    setOneDoorFetcherForTests(fetcherReturning({ error: "parcel-not-found" }, 404).fetcher);
    expect((await readOneDoorRecord(OD_PARCEL, { entitlements: [] })).kind).toBe("unavailable");
  });

  it("a non-2xx reader answer is unavailable, not a fact", async () => {
    setOneDoorFetcherForTests(fetcherReturning({ error: "boom" }, 503).fetcher);
    const read = await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    expect(read.kind).toBe("unavailable");
  });

  it("nothing is cached: a `failed` answer is re-read on the next request", async () => {
    const failed = odReaderBody("on", { ...odDefaultFacts(), flood: odState("failed") });
    const { calls, fetcher } = fetcherReturning(failed);
    setOneDoorFetcherForTests(fetcher);
    await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    await readOneDoorRecord(OD_PARCEL, { entitlements: [] });
    expect(calls).toHaveLength(2);
  });
});
