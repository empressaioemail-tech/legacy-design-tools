/**
 * ONE DOOR (WP-L): shadow-diff sink behaviour and the `on`-mode composers. No DB.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ONE_DOOR_STATES,
  parseOneDoorRecord,
  type OneDoorState,
} from "../lib/oneDoor/oneDoorReaderClient";
import {
  enqueueOneDoorShadowDiffs,
  flushOneDoorShadowDiffsForTests,
  pendingOneDoorShadowDiffCountForTests,
  setOneDoorShadowDiffPosterForTests,
  type OneDoorShadowDiffRow,
} from "../lib/oneDoor/oneDoorShadowDiff";
import {
  composeOneDoorBriefBody,
  composeOneDoorBriefSections,
  composeOneDoorFacetsBody,
  dispositionForOneDoorState,
  oneDoorShadowDiffRows,
} from "../lib/oneDoor/oneDoorSurfaces";
import { OD_PARCEL, OD_WORDS, odDefaultFacts, odReaderBody, odState, odValue } from "./oneDoorFixtures";

afterEach(() => {
  setOneDoorShadowDiffPosterForTests(null);
});

function row(fact: string): OneDoorShadowDiffRow {
  return {
    countyFips: "48209",
    parcelNodeId: OD_PARCEL,
    surface: "cortex-facets",
    fact,
    oldShown: { state: "old:missing", differs: ["state"] },
    readerState: "held",
    readerValue: null,
    readerWords: "Held while we verify this source",
    mode: "shadow",
    observedAt: "2026-10-13T00:00:00.000Z",
  };
}

describe("shadow-diff sink", () => {
  it("never blocks: enqueue returns synchronously even when the sink never answers", async () => {
    let posts = 0;
    setOneDoorShadowDiffPosterForTests(() => {
      posts += 1;
      return new Promise(() => {}); // never settles
    });
    const t0 = Date.now();
    enqueueOneDoorShadowDiffs([row("apn"), row("situsAddress")]);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(posts).toBe(0); // nothing on the caller's tick
    expect(pendingOneDoorShadowDiffCountForTests()).toBe(2);
  });

  it("batches: many rows go in one POST", async () => {
    const batches: OneDoorShadowDiffRow[][] = [];
    setOneDoorShadowDiffPosterForTests(async (rows) => {
      batches.push(rows);
      return { status: 202 };
    });
    enqueueOneDoorShadowDiffs([row("a"), row("b")]);
    enqueueOneDoorShadowDiffs([row("c")]);
    await flushOneDoorShadowDiffsForTests();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((r) => r.fact)).toEqual(["a", "b", "c"]);
  });

  it("tolerates an absent endpoint: a 404 stops posting, nothing throws", async () => {
    let posts = 0;
    setOneDoorShadowDiffPosterForTests(async () => {
      posts += 1;
      return { status: 404 };
    });
    enqueueOneDoorShadowDiffs([row("a")]);
    await flushOneDoorShadowDiffsForTests();
    enqueueOneDoorShadowDiffs([row("b")]);
    await flushOneDoorShadowDiffsForTests();
    expect(posts).toBe(1);
  });

  it("a poster that throws is swallowed", async () => {
    setOneDoorShadowDiffPosterForTests(async () => {
      throw new Error("sink down");
    });
    enqueueOneDoorShadowDiffs([row("a")]);
    await expect(flushOneDoorShadowDiffsForTests()).resolves.toBeUndefined();
  });
});

describe("shadow comparison: what the old body showed vs the reader", () => {
  const record = parseOneDoorRecord(odReaderBody("shadow"), OD_PARCEL)!;

  it("facets: a baked situs that matches the reader is not a diff; a differing one is", () => {
    const oldBody = {
      facets: { baseFacts: { apn: "R-SYNTH-1", situsAddress: "999 OTHER RD" } },
      landUseFact: { state: "absent", absence: { kind: "join-hold", reason: "LANDUSE_JOIN_HOLD" } },
    };
    const rows = oneDoorShadowDiffRows({ surface: "cortex-facets", parcelNodeId: OD_PARCEL, record, oldBody });
    const byFact = Object.fromEntries(rows.map((r) => [r.fact, r]));
    expect(byFact.apn).toBeUndefined();
    expect(byFact.situsAddress?.oldShown.differs).toEqual(["value"]);
    // The C1 contradiction: old door says held, the reader has the code.
    expect(byFact.landUseCode?.oldShown.state).toBe("held");
    expect(byFact.landUseCode?.readerState).toBe("value");
  });

  it("brief: the not-applicable zoning finding shown as a coverage gap is a state diff", () => {
    const oldBody = {
      brief: {
        sections: [
          { id: "zoning", disposition: "absent", data: null, reason: "no zoning stamp reaches this parcel" },
          { id: "flood", disposition: "present", data: { floodZone: "X" } },
        ],
      },
    };
    const rows = oneDoorShadowDiffRows({ surface: "cortex-brief", parcelNodeId: OD_PARCEL, record, oldBody });
    const zoning = rows.find((r) => r.fact === "zoningDistrict")!;
    expect(zoning.oldShown.state).toBe("not-on-record");
    expect(zoning.readerState).toBe("not-applicable");
    expect(zoning.readerWords).toBe(OD_WORDS["not-applicable"]);
    expect(zoning.mode).toBe("shadow");
    expect(rows.find((r) => r.fact === "flood")).toBeUndefined();
  });

  it("gated rails are compared but their values never leave the process", () => {
    const studio = parseOneDoorRecord(
      odReaderBody("shadow", { owner: odValue({ ownerName: "SYNTHETIC OWNER A" }) }),
      OD_PARCEL,
    )!;
    const oldBody = { ownerFact: { state: "present", ownerName: "SYNTHETIC OWNER B" } };
    const rows = oneDoorShadowDiffRows({ surface: "cortex-facets", parcelNodeId: OD_PARCEL, record: studio, oldBody });
    expect(JSON.stringify(rows)).not.toContain("SYNTHETIC OWNER");
  });
});

describe("`on` composition", () => {
  it("facets body: reader facts verbatim, placement only, no baked-snapshot label", () => {
    const record = parseOneDoorRecord(odReaderBody("on"), OD_PARCEL)!;
    const body = composeOneDoorFacetsBody({
      parcelNodeId: OD_PARCEL,
      record,
      placement: { queryPoint: { longitude: -97.8, latitude: 30.1 } },
    });
    expect(body.source).toBe("parcel-record-reader");
    expect(JSON.stringify(body)).not.toContain("baked-snapshot");
    expect(body).not.toHaveProperty("facets");
    expect(body).not.toHaveProperty("ownerFact");
    expect(body.facts).toEqual(record.facts);
    expect(body.oneDoorMode).toBe("on");
  });

  it("every state renders as a section: value from `value`, else the reader's words verbatim", () => {
    for (const state of ONE_DOOR_STATES) {
      const facts =
        state === "value"
          ? { zoningDistrict: odValue("R-1"), zoningJurisdictionKey: odValue("synthville") }
          : { zoningDistrict: odState(state as Exclude<OneDoorState, "value">) };
      const record = parseOneDoorRecord(odReaderBody("on", facts), OD_PARCEL)!;
      const [zoning] = composeOneDoorBriefSections(record);
      expect(zoning!.id).toBe("zoning");
      expect(zoning!.oneDoor.state).toBe(state);
      expect(zoning!.disposition).toBe(dispositionForOneDoorState(state));
      if (state === "value") {
        expect(zoning!.data).toEqual({ district: "R-1", jurisdictionKey: "synthville" });
        expect(zoning!.reason).toBeUndefined();
      } else {
        expect(zoning!.data).toBeNull();
        expect(zoning!.reason).toBe(OD_WORDS[state]);
        expect(zoning!.oneDoor.words).toBe(OD_WORDS[state]);
      }
    }
  });

  it("a fact the reader did not return is omitted, never worded locally", () => {
    const record = parseOneDoorRecord(odReaderBody("on", { flood: odValue({ floodZone: "AE" }) }), OD_PARCEL)!;
    const sections = composeOneDoorBriefSections(record);
    expect(sections.map((s) => s.id)).toEqual(["flood"]);
  });

  it("brief body: no onRecord, no typed legacy facts, no baked-snapshot label", () => {
    const record = parseOneDoorRecord(odReaderBody("on", odDefaultFacts()), OD_PARCEL)!;
    const body = composeOneDoorBriefBody({ runId: "pe-r1-x.y", parcelNodeId: OD_PARCEL, record, draw: null });
    expect(body).not.toHaveProperty("onRecord");
    expect(body).not.toHaveProperty("landUseFact");
    expect(body).not.toHaveProperty("ownerFact");
    expect(JSON.stringify(body)).not.toContain("baked-snapshot");
    const sections = (body.brief as { sections: Array<{ id: string; data: unknown; reason?: string }> }).sections;
    expect(sections.find((s) => s.id === "land-use")!.data).toEqual({ landUseCode: "C1" });
    expect(sections.find((s) => s.id === "setbacks-envelope")!.reason).toBe(OD_WORDS.held);
  });
});
