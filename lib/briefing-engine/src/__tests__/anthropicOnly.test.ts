/**
 * G-309 A20: parcel briefings use Anthropic only. Grok cannot be
 * selected even when XAI_* env is set to a Grok model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  BriefingLlmModeConfigError,
  generateBriefing,
  resolveBriefingLlmMode,
} from "../engine";
import { BRIEFING_ANTHROPIC_MODEL } from "../anthropicGenerator";

const KEYS = ["BRIEFING_LLM_MODE", "XAI_MODEL", "XAI_BRIEFING_MODEL", "XAI_API_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.XAI_MODEL = "grok-3-mini";
  process.env.XAI_BRIEFING_MODEL = "grok-3-mini";
  process.env.XAI_API_KEY = "xai-test-not-real";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const input = { engagementId: "eng-1", sources: [], generatedBy: "system:test" };

describe("briefing: Anthropic is the only selectable provider", () => {
  it("BRIEFING_LLM_MODE=grok throws a config error", () => {
    process.env.BRIEFING_LLM_MODE = "grok";
    expect(() => resolveBriefingLlmMode()).toThrow(BriefingLlmModeConfigError);
  });

  it("a forced grok mode never reaches a Grok client", async () => {
    const grokClient = { completeChat: vi.fn() };
    await expect(
      generateBriefing(input, { mode: "grok" as never, grokClient } as never),
    ).rejects.toThrow(/not a permitted/);
    expect(grokClient.completeChat).not.toHaveBeenCalled();
  });

  it("anthropic mode calls the Anthropic model even with XAI_* set to Grok", async () => {
    process.env.BRIEFING_LLM_MODE = "anthropic";
    expect(resolveBriefingLlmMode()).toBe("anthropic");
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "{}" }],
    }));
    const client = { beta: { messages: { create } } } as unknown as Anthropic;
    await generateBriefing(input, { mode: "anthropic", anthropicClient: client }).catch(
      () => undefined,
    );
    expect(create).toHaveBeenCalledTimes(1);
    const args = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(args.model).toBe(BRIEFING_ANTHROPIC_MODEL);
    expect(BRIEFING_ANTHROPIC_MODEL).toBe("claude-opus-5-5");
    expect(args.temperature).toBeUndefined();
  });
});
