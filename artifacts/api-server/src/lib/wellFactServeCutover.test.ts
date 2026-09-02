/**
 * The one real serve-layer integration point PARCEL-B-READER ships.
 *
 * THE LOAD-BEARING ASSERTION: with today's empty PARCEL_RECORD_SLATE,
 * loadWellFactForServe MUST produce byte-identical output to
 * loadWellFactAtom for the same input, on every fixture this file covers
 * — that identity is the staging probe's own claim, proven here at the
 * unit level first.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  interpretWellFactRows,
  memoryWellFactAtoms,
  resetWellFactAtomQueryableForTests,
  setWellFactAtomQueryableForTests,
} from "./wellFactRead";
import {
  loadWellFactForServe,
  resetWellsVerdictStoreForTests,
  setWellsVerdictStoreForTests,
} from "./wellFactServeCutover";

const GOLD = "48021:34137";
const CRANE = "48103:100";
const CRANE_LEAD_BODY = {
  entityType: "well-fact",
  parcelNodeId: CRANE,
  wellKey: "42000001030000",
  apiNumber14: "42000001030000",
  wellStatus: "dry",
  wellType: "unknown",
  orphaned: false,
  parcelRelation: "on-parcel" as const,
  proximityRadiusMeters: 152,
  surfaceLocation: { lat: 31.48020694, lng: -102.75930581 },
  sourceTier: "texas-rrc-gis",
  sourceAdapter: "tx-rrc-well-staged-v1",
  evaluatedAt: "2026-08-16T09:57:36.576Z",
};

afterEach(() => {
  resetWellFactAtomQueryableForTests();
  resetWellsVerdictStoreForTests();
});

describe("loadWellFactForServe — byte-identical to loadWellFactAtom while unslated", () => {
  it("a present on-parcel well: identical shape via the wrapper and the direct call", async () => {
    setWellFactAtomQueryableForTests(
      memoryWellFactAtoms([{ entityId: `${CRANE}:42000001030000`, body: CRANE_LEAD_BODY }]),
    );
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(CRANE));
    const viaWrapper = await loadWellFactForServe(CRANE);
    expect(viaWrapper).toEqual(direct);
  });

  it("a gold parcel with no well-fact atom at all: identical atom-miss refusal via both paths", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(GOLD));
    const viaWrapper = await loadWellFactForServe(GOLD);
    expect(viaWrapper).toEqual(direct);
    expect(direct.state).toBe("refused");
  });

  it("FALSIFIER: even a fabricated verdict store with a PASS row for wells has no effect while the slate is empty — still identical to the direct call", async () => {
    setWellFactAtomQueryableForTests(
      memoryWellFactAtoms([{ entityId: `${CRANE}:42000001030000`, body: CRANE_LEAD_BODY }]),
    );
    setWellsVerdictStoreForTests({
      async query<T extends Record<string, unknown> = Record<string, unknown>>() {
        return {
          rows: [
            {
              county_fips: "48103",
              rail_key: "wells",
              verdict: "pass",
              unaccounted_count: 0,
              evaluated_at: "2026-09-02T18:00:00Z",
              run_id: "test",
            },
          ] as unknown as T[],
        };
      },
    });
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(CRANE));
    const viaWrapper = await loadWellFactForServe(CRANE);
    expect(viaWrapper).toEqual(direct);
  });

  it("a malformed parcelNodeId (no county prefix) falls through to loadWellFactAtom's own existing refusal, unchanged", async () => {
    setWellFactAtomQueryableForTests(memoryWellFactAtoms([]));
    const malformed = "not-a-valid-id";
    const direct = await import("./wellFactRead").then((m) => m.loadWellFactAtom(malformed));
    const viaWrapper = await loadWellFactForServe(malformed);
    expect(viaWrapper).toEqual(direct);
  });
});

describe("interpretWellFactRows sanity (unchanged, confirms the sibling module was not edited)", () => {
  it("still refuses atom-miss the same way", () => {
    const result = interpretWellFactRows(GOLD, []);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("atom-miss");
  });
});
