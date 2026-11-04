/**
 * G-309 A20: every Smart Site generative path that can touch code
 * citations uses Anthropic only. With XAI_* env set to a Grok model:
 *   - the finding and briefing LLM clients refuse mode=grok (config error)
 *     and never build a Grok client;
 *   - the brief / lay-summary / research-chat generators call the
 *     Anthropic model and report method "anthropic".
 * No network calls: the Anthropic client is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIEFING_ANTHROPIC_MODEL,
  CODE_CITING_ANTHROPIC_MODEL,
} from "@workspace/briefing-engine";
import { FINDING_ANTHROPIC_MODEL } from "@workspace/finding-engine";

const createAnthropicClientMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  createAnthropicClient: createAnthropicClientMock,
}));

vi.mock("../lib/brokerageSiteContext", () => ({
  formatBrokerageContextForLlm: () => "",
}));

const {
  getFindingLlmClient,
  setFindingLlmClient,
  validateFindingEngineEnvAtBoot,
} = await import("../lib/findingLlmClient");
const {
  getBriefingLlmClient,
  setBriefingLlmClient,
  validateBriefingEngineEnvAtBoot,
} = await import("../lib/briefingLlmClient");
const { generateReasoningSummary, generateResearchChat } = await import(
  "../lib/brokerageBriefLlm"
);
const { generateLaySummary } = await import("../lib/propertyBriefLaySummary");

const KEYS = [
  "AIR_FINDING_LLM_MODE",
  "BRIEFING_LLM_MODE",
  "XAI_API_KEY",
  "XAI_MODEL",
  "XAI_FINDING_MODEL",
  "XAI_BRIEFING_MODEL",
  "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
  "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
];
const saved: Record<string, string | undefined> = {};

function stubClient(text: string) {
  const create = vi.fn(async () => ({ content: [{ type: "text", text }] }));
  return { client: { messages: { create } }, create };
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.XAI_API_KEY = "xai-test-not-real";
  process.env.XAI_MODEL = "grok-3-mini";
  process.env.XAI_FINDING_MODEL = "grok-3-mini";
  process.env.XAI_BRIEFING_MODEL = "grok-3-mini";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "test";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://example.invalid";
  setFindingLlmClient(null);
  setBriefingLlmClient(null);
  createAnthropicClientMock.mockReset();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setFindingLlmClient(null);
  setBriefingLlmClient(null);
});

describe("findings client (findingLlmClient)", () => {
  it("AIR_FINDING_LLM_MODE=grok cannot be selected", async () => {
    process.env.AIR_FINDING_LLM_MODE = "grok";
    expect(() => validateFindingEngineEnvAtBoot()).toThrow(/Anthropic only/);
    await expect(getFindingLlmClient()).rejects.toThrow(/Anthropic only/);
  });

  it("AIR_FINDING_LLM_MODE=anthropic wires the Anthropic client with XAI_* set", async () => {
    process.env.AIR_FINDING_LLM_MODE = "anthropic";
    const { client } = stubClient("{}");
    createAnthropicClientMock.mockReturnValue(client);
    const bundle = await getFindingLlmClient();
    expect(bundle?.kind).toBe("anthropic");
    expect(createAnthropicClientMock).toHaveBeenCalledTimes(1);
    expect(FINDING_ANTHROPIC_MODEL).toBe("claude-opus-5-5");
  });

  it("findings, briefing and the shared constant are one model id", () => {
    expect(FINDING_ANTHROPIC_MODEL).toBe(CODE_CITING_ANTHROPIC_MODEL);
    expect(BRIEFING_ANTHROPIC_MODEL).toBe(CODE_CITING_ANTHROPIC_MODEL);
  });
});

describe("briefing client (briefingLlmClient)", () => {
  it("BRIEFING_LLM_MODE=grok cannot be selected", async () => {
    process.env.BRIEFING_LLM_MODE = "grok";
    expect(() => validateBriefingEngineEnvAtBoot()).toThrow(/Anthropic only/);
    await expect(getBriefingLlmClient()).rejects.toThrow(/Anthropic only/);
  });

  it("BRIEFING_LLM_MODE=anthropic wires the Anthropic client with XAI_* set", async () => {
    process.env.BRIEFING_LLM_MODE = "anthropic";
    const { client } = stubClient("{}");
    createAnthropicClientMock.mockReturnValue(client);
    const bundle = await getBriefingLlmClient();
    expect(bundle?.kind).toBe("anthropic");
  });
});

const ATOMS = [
  { atomDid: "did:hauska:code-section:x-1", label: "Setbacks", snippet: "topic" },
];

describe("brief / lay summary / research chat generators", () => {
  it("generateReasoningSummary calls the Anthropic model", async () => {
    const { client, create } = stubClient(
      JSON.stringify({ headline: "Headline.", body: "Body [1]." }),
    );
    setBriefingLlmClient({ kind: "anthropic", client: client as never });
    const out = await generateReasoningSummary({
      address: "1 Main St, Bastrop, TX",
      jurisdiction: "bastrop_tx",
      corpusStatus: "in_corpus",
      atoms: ATOMS,
      finishedAt: new Date().toISOString(),
    });
    expect(create).toHaveBeenCalled();
    const args = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(args.model).toBe("claude-opus-5-5");
    expect(args.temperature).toBeUndefined();
    expect(out.method).toBe("anthropic");
  });

  it("generateLaySummary uses Anthropic (not Grok, not rules) when Anthropic is wired", async () => {
    const verdicts = ["adu", "flood", "corpus_coverage"].map((id) => ({
      id,
      label: id,
      status: "maybe",
      oneLine: "line",
      detailParagraph: "detail",
    }));
    const { client, create } = stubClient(JSON.stringify({ verdicts }));
    setBriefingLlmClient({ kind: "anthropic", client: client as never });
    const out = await generateLaySummary({
      address: "1 Main St, Bastrop, TX",
      jurisdiction: "bastrop_tx",
      corpusStatus: "in_corpus",
      atoms: ATOMS,
      presentationMode: "consumer",
      finishedAt: new Date().toISOString(),
    });
    expect(create).toHaveBeenCalledTimes(1);
    const args = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(args.model).toBe("claude-opus-5-5");
    expect(args.temperature).toBeUndefined();
    expect(out.method).toBe("anthropic");
  });

  it("generateResearchChat calls the Anthropic model", async () => {
    const { client, create } = stubClient(JSON.stringify({ answer: "Ok [1]." }));
    setBriefingLlmClient({ kind: "anthropic", client: client as never });
    await generateResearchChat({
      address: "1 Main St, Bastrop, TX",
      jurisdiction: "bastrop_tx",
      message: "What are the setbacks?",
      history: [],
      atoms: ATOMS,
      corpusStatus: "in_corpus",
      presentationMode: "pro",
    } as never);
    expect(
      (create.mock.calls[0] as unknown as [{ model: string }])[0].model,
    ).toBe("claude-opus-5-5");
  });
});
