/**
 * G-309 A20: max_tokens 16000 on every Opus 5.5 call and stop_reason=
 * max_tokens handling for the brokerage brief, lay summary and chats.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  setBriefingLlmClient({ kind: "anthropic", client: { beta: { messages: { create } } } as never });
  return create;
}

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

describe("Opus 5.5 max_tokens: brokerage brief and lay summary", () => {
  it("both request max_tokens 16000, non-streaming", async () => {
    const ok = stub({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ headline: "H.", body: "B [1]." }) }],
    });
    await generateReasoningSummary(briefInput);
    const a = (ok.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(a.max_tokens).toBe(16000);
    expect("stream" in a).toBe(false);

    const lay = stub({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
    });
    await generateLaySummary(layInput);
    expect(
      (lay.mock.calls[0] as unknown as [Record<string, unknown>])[0].max_tokens,
    ).toBe(16000);
  });

  it("stop_reason=max_tokens falls back to rules-v1 (never parses the partial text)", async () => {
    stub({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
    });
    expect((await generateLaySummary(layInput)).method).toBe("rules-v1");
    expect((await generateReasoningSummary(briefInput)).method).toBe("rules-v1");
  });
});

describe("Opus 5.5 max_tokens: chat routes (static)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) =>
    readFileSync(join(here, "..", "..", "..", "..", rel), "utf8");
  for (const f of [
    "artifacts/api-server/src/routes/chat.ts",
    "artifacts/api-server/src/routes/chatWorkspace.ts",
  ]) {
    it(`${f}: 16000 limit via shared constant and fixed truncation line`, () => {
      const src = read(f);
      expect(src).toContain("max_tokens: CODE_CITING_MAX_TOKENS");
      expect(src).not.toMatch(/max_tokens:\s*4096/);
      expect(src).toContain("isAnthropicTruncated(finalMessage)");
      expect(src).toContain(
        "That answer ran long; please ask a narrower question.",
      );
    });
  }

  it("every Opus 5.5 call site uses the shared max_tokens constant", () => {
    for (const f of [
      "artifacts/api-server/src/lib/brokerageBriefLlm.ts",
      "artifacts/api-server/src/lib/propertyBriefLaySummary.ts",
    ]) {
      expect(read(f)).toContain("max_tokens: CODE_CITING_MAX_TOKENS");
    }
  });
});
