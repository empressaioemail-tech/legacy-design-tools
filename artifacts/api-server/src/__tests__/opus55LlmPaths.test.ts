/**
 * G-309 A20: Opus 5.5 effort per path, refusal fallback to rules-v1 and
 * text-only parsing for the brokerage brief and lay summary. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/brokerageSiteContext", () => ({
  formatBrokerageContextForLlm: () => "",
}));

const { setBriefingLlmClient } = await import("../lib/briefingLlmClient");
const { generateReasoningSummary } = await import("../lib/brokerageBriefLlm");
const { generateLaySummary } = await import("../lib/propertyBriefLaySummary");

const ATOMS = [
  { atomDid: "did:hauska:code-section:x-1", label: "Setbacks", snippet: "topic" },
];
const verdicts = ["adu", "flood", "corpus_coverage"].map((id) => ({
  id, label: id, status: "maybe", oneLine: "l", detailParagraph: "d",
}));
const layInput = {
  address: "1 Main St, Bastrop, TX",
  jurisdiction: "bastrop_tx",
  corpusStatus: "in_corpus",
  atoms: ATOMS,
  presentationMode: "consumer" as const,
  finishedAt: new Date().toISOString(),
};
const briefInput = {
  address: "1 Main St, Bastrop, TX",
  jurisdiction: "bastrop_tx",
  corpusStatus: "in_corpus",
  atoms: ATOMS,
  finishedAt: new Date().toISOString(),
};

function stub(response: unknown) {
  const create = vi.fn(async () => response);
  setBriefingLlmClient({ kind: "anthropic", client: { messages: { create } } as never });
  return create;
}
const argsOf = (create: { mock: { calls: unknown[] } }) =>
  (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];

const saved = process.env.BRIEFING_LLM_MODE;
beforeEach(() => {
  process.env.BRIEFING_LLM_MODE = "anthropic";
  setBriefingLlmClient(null);
});
afterEach(() => {
  if (saved === undefined) delete process.env.BRIEFING_LLM_MODE;
  else process.env.BRIEFING_LLM_MODE = saved;
  setBriefingLlmClient(null);
});

describe("Opus 5.5: brokerage brief and lay summary", () => {
  it("brokerage brief: claude-opus-5-5, effort medium, no rejected params", async () => {
    const create = stub({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ headline: "H.", body: "B [1]." }) }],
    });
    await generateReasoningSummary(briefInput);
    const a = argsOf(create);
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.output_config).toEqual({ effort: "medium" });
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) {
      expect(k in a).toBe(false);
    }
    const msgs = a.messages as Array<{ role: string }>;
    expect(msgs[msgs.length - 1]!.role).toBe("user");
  });

  it("lay summary: claude-opus-5-5, effort low, no rejected params", async () => {
    const create = stub({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
    });
    const out = await generateLaySummary(layInput);
    const a = argsOf(create);
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.output_config).toEqual({ effort: "low" });
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) {
      expect(k in a).toBe(false);
    }
    expect(out.method).toBe("anthropic");
  });

  it("lay summary reads the text block after an empty thinking block", async () => {
    stub({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: JSON.stringify({ verdicts }) },
      ],
    });
    expect((await generateLaySummary(layInput)).method).toBe("anthropic");
  });

  it("refusal falls back to rules-v1 for lay summary and brokerage brief", async () => {
    stub({
      stop_reason: "refusal",
      content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
    });
    expect((await generateLaySummary(layInput)).method).toBe("rules-v1");
    expect((await generateReasoningSummary(briefInput)).method).toBe("rules-v1");
  });
});
