import { describe, expect, it } from "vitest";
import {
  atomIdsFromCitations,
  buildProvenanceFromCodeAtom,
  buildProvenanceFromBriefing,
  partitionProvenanceAtomIds,
} from "../provenanceEnvelope";

const CORPUS_UUID = "550E8400-E29B-41D4-A716-446655440000";
const CORPUS_UUID_LOWER = CORPUS_UUID.toLowerCase();
const REASONING_ID = "reasoning:irc-2021:irc-r301-2-1";

describe("provenanceEnvelope", () => {
  it("atomIdsFromCitations preserves code-section atomIds", () => {
    const ids = atomIdsFromCitations([
      { kind: "code-section", atomId: "atom-a" },
      { kind: "briefing-source", id: "src-1", label: "Zoning" },
      { kind: "code-section", atomId: "atom-b" },
    ]);
    expect(ids).toEqual(["atom-a", "atom-b"]);
  });

  it("buildProvenanceFromCodeAtom omits calibration grade", () => {
    const env = buildProvenanceFromCodeAtom({
      atomId: "ibc-404",
      sourceUrl: "https://example.com/ibc",
      edition: "2021",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceName: "ICC",
    });
    expect(env.lineage.atomIds).toEqual(["ibc-404"]);
    expect(env.sources[0]?.deeplink).toContain("example.com");
    expect("calibrationGrade" in env).toBe(false);
    expect("calibration_grade" in env).toBe(false);
  });

  it("buildProvenanceFromBriefing maps briefing sources", () => {
    const env = buildProvenanceFromBriefing(
      {
        id: "brief-1",
        engagementId: "eng-1",
        generatedAt: new Date("2026-06-10T12:00:00.000Z"),
        updatedAt: new Date("2026-06-10T12:00:00.000Z"),
        createdAt: new Date("2026-06-10T11:00:00.000Z"),
      } as never,
      [
        {
          id: "src-zoning",
          snapshotDate: "2026-01-01",
          createdAt: new Date("2026-06-10T11:00:00.000Z"),
          objectPath: "/objects/zoning.glb",
          provider: "Regrid",
          layerKind: "qgis-zoning",
        } as never,
      ],
    );
    expect(env.lineage.atomIds).toEqual(["src-zoning"]);
    expect(env.sources[0]?.sourceName).toBe("Regrid");
  });

  it("partitionProvenanceAtomIds routes reasoning ids away from corpus UUID query", () => {
    const mixed = [CORPUS_UUID, REASONING_ID, "websearch:irc-2021:irc-r302"];
    expect(partitionProvenanceAtomIds(mixed)).toEqual({
      corpusAtomIds: [CORPUS_UUID_LOWER],
      reasoningAtomIds: [REASONING_ID, "websearch:irc-2021:irc-r302"],
    });
  });

  it("partitionProvenanceAtomIds normalizes corpus DIDs to lowercase UUID keys", () => {
    expect(
      partitionProvenanceAtomIds([
        `did:hauska:code-section:${CORPUS_UUID}`,
      ]),
    ).toEqual({
      corpusAtomIds: [CORPUS_UUID_LOWER],
      reasoningAtomIds: [],
    });
  });

  it("partitionProvenanceAtomIds preserves mixed citation order in lineage buckets", () => {
    const atomIds = [
      REASONING_ID,
      CORPUS_UUID,
      "reasoning:irc-2021:irc-r302-1",
    ];
    expect(partitionProvenanceAtomIds(atomIds)).toEqual({
      corpusAtomIds: [CORPUS_UUID_LOWER],
      reasoningAtomIds: [REASONING_ID, "reasoning:irc-2021:irc-r302-1"],
    });
    expect(atomIdsFromCitations([
      { kind: "code-section", atomId: REASONING_ID },
      { kind: "code-section", atomId: CORPUS_UUID },
      { kind: "code-section", atomId: "reasoning:irc-2021:irc-r302-1" },
    ])).toEqual(atomIds);
  });
});
