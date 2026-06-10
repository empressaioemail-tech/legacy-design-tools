import { describe, it, expect } from "vitest";
import { buildBrokerageBriefProvenanceEnvelope } from "../brokerageProvenanceEnvelope";

describe("buildBrokerageBriefProvenanceEnvelope", () => {
  it("emits lineage, sources, reasoning chain without calibration grade", () => {
    const envelope = buildBrokerageBriefProvenanceEnvelope({
      citations: [{ atomDid: "atom-1" }, { atomDid: "atom-2" }],
      atoms: [
        {
          atomDid: "atom-1",
          sourceUrl: "https://example.com/ibc",
          edition: "IBC 2021",
        },
      ],
      finishedAt: "2026-06-10T12:00:00.000Z",
      jurisdictionKey: "austin_tx",
      corpusStatus: "in_corpus",
      spineViaGate: true,
    });

    expect(envelope.lineage.atomIds).toEqual(["atom-1", "atom-2"]);
    expect(envelope.sources).toHaveLength(2);
    expect(envelope.sources[0]?.sourceUrl).toBe("https://example.com/ibc");
    expect(envelope.sources[0]?.verificationState).toBe("corpus");
    expect(envelope.reasoningChain.rule).toBe("municipal-code-retrieval");
    expect(envelope.spineViaGate).toBe(true);
    expect(envelope).not.toHaveProperty("calibrationGrade");
    expect(envelope).not.toHaveProperty("grade");
  });
});
