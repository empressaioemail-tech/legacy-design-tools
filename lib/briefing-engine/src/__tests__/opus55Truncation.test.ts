/**
 * G-309 A20: max_tokens 16000 and stop_reason=max_tokens handling (briefing).
 */
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateBriefing } from "../engine";

const input = { engagementId: "eng-1", sources: [], generatedBy: "system:test" };
const sections = JSON.stringify({ a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g" });

function clientWith(response: unknown) {
  const create = vi.fn(async () => response);
  return { create, client: { beta: { messages: { create } } } as unknown as Anthropic };
}

describe("briefing: max_tokens", () => {
  it("requests max_tokens 16000, non-streaming", async () => {
    const { create, client } = clientWith({
      stop_reason: "end_turn",
      content: [{ type: "text", text: sections }],
    });
    await generateBriefing(input, { mode: "anthropic", anthropicClient: client });
    const a = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(a.max_tokens).toBe(16000);
    expect("stream" in a).toBe(false);
  });

  it("stop_reason=max_tokens throws anthropic_truncated and never parses partial JSON", async () => {
    const { client } = clientWith({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: sections }],
    });
    await expect(
      generateBriefing(input, { mode: "anthropic", anthropicClient: client }),
    ).rejects.toMatchObject({ code: "anthropic_truncated" });
  });
});
