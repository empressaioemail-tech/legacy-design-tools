/**
 * hauska-engine #525 (cf782c8) makes the LEGACY `rails` part of `/record`
 * withhold the gated rails (owner, exemptionCodes, the four CAD dollar rails,
 * valueHistory, salesHistory) -- `serve: "refused"`, `refusal.code:
 * "plan-gated"`, cell and companions empty -- unless `X-Hauska-Entitlements`
 * grants them. The legacy LDT client must therefore send the END USER's
 * entitlements in EVERY one-door mode:
 *
 *   - Studio (granted) still sees the dollar values through the legacy rails;
 *   - an ungranted caller gets the same studio-gated refusal the surface
 *     already showed it, never a cell miss and never a stale baked value.
 *
 * No DB: the retrieval service is the client's own fetch seam, answering the
 * way #525 does for the header it receives. Synthetic values only.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchParcelRecord,
  resetParcelRecordFetcherForTests,
  setParcelRecordFetcherForTests,
  type ParcelRecordRailWire,
  type ParcelRecordWire,
} from "../lib/parcelRecordReaderClient";
import { resetParcelRecordQueryableForTests } from "../lib/parcelRecordCellRead";
import { withRecordEntitlements } from "../lib/oneDoor/recordEntitlementsContext";
import { ONE_DOOR_GATED_RAILS, oneDoorEntitlementsFor } from "../lib/oneDoor/oneDoorReaderClient";
import { resolveCadRollOverlaysForServe } from "../lib/cadRollServeCutover";
import { loadValueHistoryFactForServe } from "../lib/valueHistoryFactServeCutover";
import { gateValueHistoryFactValuation } from "../lib/valueHistoryFactRead";
import { gateCadRollValuationOnFacets, attachCadRollOverlaysToFacets } from "../lib/structuralFactToFacetsWire";

const COUNTY = "48021";
const PROP = "900001";
const PLACE = `${COUNTY}:${PROP}`;

const DOLLARS: Record<string, number> = {
  marketValue: 412000,
  assessedValue: 398000,
  landValue: 150000,
  improvementValue: 262000,
};

function rail(partial: Partial<ParcelRecordRailWire>): ParcelRecordRailWire {
  return {
    cell: null,
    gate: { verdict: "pass", evaluatedAt: "2026-10-13T00:00:00.000Z" },
    serve: "record",
    atom: null,
    atomBacked: false,
    rendering: null,
    companions: [],
    refusal: null,
    ...partial,
  };
}

const PLAN_GATED = rail({ serve: "refused", refusal: { code: "plan-gated" } });

/** The legacy wire #525 serves for this request's header. */
function wireFor(entitlementsHeader: string | null): ParcelRecordWire {
  const granted = new Set((entitlementsHeader ?? "").split(",").filter(Boolean));
  const rails: Record<string, ParcelRecordRailWire> = {};
  for (const [key, v] of Object.entries(DOLLARS)) {
    rails[key] = granted.has(key)
      ? rail({ cell: { kind: "value", value: v, source: "cad_property", vintage: "2026-09-20" } })
      : PLAN_GATED;
  }
  rails.valueHistory = granted.has("valueHistory")
    ? rail({
        cell: { kind: "value", value: null, disposition: "rows", rowCount: 1, source: "cad_property", vintage: "2026-09-20" },
        companions: [
          {
            rowIndex: 0,
            payload: { taxYear: 2025, ...DOLLARS },
            source: "cad_property",
            vintage: "2026-09-20",
          },
        ],
      })
    : PLAN_GATED;
  rails.yearBuilt = rail({ cell: { kind: "value", value: 1998, source: "cad_property", vintage: "2026-09-20" } });
  return {
    parcelNodeId: PLACE,
    placeKey: PLACE,
    countyFips: COUNTY,
    railRegistrySha: "test",
    readAt: "2026-10-13T00:00:00.000Z",
    rails,
    refused: null,
  };
}

const seenHeaders: Array<string | null> = [];
let prevKey: string | undefined;

beforeEach(() => {
  seenHeaders.length = 0;
  prevKey = process.env.HAUSKA_RETRIEVAL_API_KEY;
  // Arms the env-backed queryable, which reads through fetchParcelRecord.
  process.env.HAUSKA_RETRIEVAL_API_KEY = "legacy-entitlements-test-key";
  resetParcelRecordQueryableForTests();
  setParcelRecordFetcherForTests(async (_placeKey, header) => {
    seenHeaders.push(header);
    return wireFor(header);
  });
});

afterEach(() => {
  if (prevKey === undefined) delete process.env.HAUSKA_RETRIEVAL_API_KEY;
  else process.env.HAUSKA_RETRIEVAL_API_KEY = prevKey;
  resetParcelRecordFetcherForTests();
  resetParcelRecordQueryableForTests();
});

const STUDIO = oneDoorEntitlementsFor(true);
const ANON = oneDoorEntitlementsFor(false);

describe("legacy /record client sends the END USER's entitlements", () => {
  it("inside a Studio scope: the gated rail list; outside any scope / anonymous: no header", async () => {
    await withRecordEntitlements(STUDIO, () => fetchParcelRecord(PLACE));
    await withRecordEntitlements(ANON, () => fetchParcelRecord(PLACE));
    await fetchParcelRecord(PLACE);
    expect(seenHeaders[0]!.split(",").sort()).toEqual([...ONE_DOOR_GATED_RAILS].sort());
    expect(seenHeaders[1]).toBeNull();
    expect(seenHeaders[2]).toBeNull();
  });

  it("on the wire, with the coalescing cache keyed by entitlement (real fetch, local server)", async () => {
    resetParcelRecordFetcherForTests();
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(wireFor(req.headers["x-hauska-entitlements"] as string | undefined ?? null)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const prevUrl = process.env.HAUSKA_RETRIEVAL_API_URL;
    process.env.HAUSKA_RETRIEVAL_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const place = `${COUNTY}:${PROP}9`; // fresh cache entry
      const studio = await withRecordEntitlements(STUDIO, () => fetchParcelRecord(place));
      const anon = await withRecordEntitlements(ANON, () => fetchParcelRecord(place));
      expect(seen).toHaveLength(2); // a Studio answer is never reused for an anonymous caller
      expect(String(seen[0]!["x-hauska-entitlements"]).split(",").sort()).toEqual([...ONE_DOOR_GATED_RAILS].sort());
      expect(seen[1]!["x-hauska-entitlements"]).toBeUndefined();
      expect(studio!.rails.marketValue!.serve).toBe("record");
      expect(anon!.rails.marketValue!.refusal!.code).toBe("plan-gated");
    } finally {
      if (prevUrl === undefined) delete process.env.HAUSKA_RETRIEVAL_API_URL;
      else process.env.HAUSKA_RETRIEVAL_API_URL = prevUrl;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("CAD dollar rails through the legacy wire", () => {
  it("Studio still sees the dollar values", async () => {
    const overlay = await withRecordEntitlements(STUDIO, () => resolveCadRollOverlaysForServe(COUNTY, PROP));
    expect(overlay.marketValue).toEqual(expect.objectContaining({ state: "present", v: 412000 }));
    expect(overlay.improvementValue).toEqual(expect.objectContaining({ state: "present", v: 262000 }));
  });

  it("anonymous: a studio-gated refusal per dollar rail -- what the surface already shows -- never a cell miss", async () => {
    const overlay = await withRecordEntitlements(ANON, () => resolveCadRollOverlaysForServe(COUNTY, PROP));
    for (const key of Object.keys(DOLLARS)) {
      expect((overlay as Record<string, unknown>)[key]).toEqual(
        expect.objectContaining({ state: "refused", code: "studio-gated" }),
      );
    }
    expect(JSON.stringify(overlay)).not.toContain("412000");
    // Ungated rails are unaffected.
    expect(overlay.yearBuilt).not.toBeNull();
    // Through the facets gate, the served cadRoll is byte-identical to what an
    // ungranted caller got before #525, when the wire still carried the values
    // and only LDT's own gate withheld them.
    const preGateValues = await withRecordEntitlements(STUDIO, () => resolveCadRollOverlaysForServe(COUNTY, PROP));
    const baked = { baseFacts: { cadRoll: { marketValue: { v: 1, state: "present" } } } };
    const before = gateCadRollValuationOnFacets(
      attachCadRollOverlaysToFacets(baked, { ...preGateValues, yearBuilt: null }),
      false,
    );
    const after = gateCadRollValuationOnFacets(attachCadRollOverlaysToFacets(baked, { ...overlay, yearBuilt: null }), false);
    expect((after.baseFacts as { cadRoll: unknown }).cadRoll).toEqual(
      (before.baseFacts as { cadRoll: unknown }).cadRoll,
    );
  });
});

describe("value history through the legacy wire", () => {
  it("Studio: the entries with their dollars", async () => {
    const fact = await withRecordEntitlements(STUDIO, () => loadValueHistoryFactForServe(PLACE));
    expect(fact.state).toBe("present");
    expect(fact.state === "present" && fact.entries[0]!.marketValue).toBe(412000);
  });

  it("anonymous: a studio-gated refusal (no history leaks, no false 'cell miss')", async () => {
    const fact = await withRecordEntitlements(ANON, () => loadValueHistoryFactForServe(PLACE));
    expect(fact).toEqual(expect.objectContaining({ state: "refused", code: "studio-gated" }));
    expect(JSON.stringify(gateValueHistoryFactValuation(fact, false))).not.toContain("412000");
  });
});
