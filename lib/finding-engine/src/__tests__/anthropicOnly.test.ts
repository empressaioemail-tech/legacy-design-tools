/**
 * G-309 A20: findings use Anthropic only. Grok cannot be selected even
 * when XAI_* env is set to a Grok model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateFindings, resolveFindingLlmMode } from "../engine";
import { FINDING_ANTHROPIC_MODEL } from "../anthropicGenerator";
import type { GenerateFindingsInput } from "../types";

const input: GenerateFindingsInput = {
  submission: { id: "sub-1", jurisdiction: "Bastrop, TX", projectName: null, note: null },
  sources: [],
  codeSections: [{ atomId: "code-1", label: "Test Rule" }],
  bimElements: [],
};

const saved: Record<string, string | undefined> = {};
const KEYS = ["AIR_FINDING_LLM_MODE", "XAI_MODEL", "XAI_FINDING_MODEL", "XAI_API_KEY"];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.XAI_MODEL = "grok-3-mini";
  process.env.XAI_FINDING_MODEL = "grok-3-mini";
  process.env.XAI_API_KEY = "xai-test-not-real";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("findings: Anthropic is the only selectable provider", () => {
  it("AIR_FINDING_LLM_MODE=grok throws a config error", () => {
    process.env.AIR_FINDING_LLM_MODE = "grok";
    expect(() => resolveFindingLlmMode()).toThrow(/Anthropic only/);
  });

  it("a forced grok mode never reaches a Grok client", async () => {
    const grokClient = { completeChat: vi.fn() };
    await expect(
      generateFindings(input, { mode: "grok" as never, grokClient } as never),
    ).rejects.toThrow(/not a permitted/);
    expect(grokClient.completeChat).not.toHaveBeenCalled();
  });

  it("anthropic mode calls the Anthropic model even with XAI_* set to Grok", async () => {
    process.env.AIR_FINDING_LLM_MODE = "anthropic";
    expect(resolveFindingLlmMode()).toBe("anthropic");
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
    }));
    const client = { messages: { create } } as unknown as Anthropic;
    await generateFindings(input, { mode: resolveFindingLlmMode(), anthropicClient: client });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe(
      FINDING_ANTHROPIC_MODEL,
    );
    expect(FINDING_ANTHROPIC_MODEL).toMatch(/^claude-/);
  });
});
