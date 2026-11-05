/**
 * G-309 A20: max_tokens 16000 and stop_reason=max_tokens handling (findings).
 */
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateFindings } from "../engine";
import type { GenerateFindingsInput } from "../types";

const input: GenerateFindingsInput = {
  submission: { id: "sub-1", jurisdiction: "Bastrop, TX", projectName: null, note: null },
  sources: [],
  codeSections: [{ atomId: "code-1", label: "Test Rule" }],
  bimElements: [],
};

function clientWith(response: unknown) {
  const create = vi.fn(async () => response);
  return { create, client: { messages: { create } } as unknown as Anthropic };
}

describe("findings: max_tokens", () => {
  it("requests max_tokens 16000, non-streaming", async () => {
    const { create, client } = clientWith({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
    });
    await generateFindings(input, { mode: "anthropic", anthropicClient: client });
    const a = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(a.max_tokens).toBe(16000);
    expect("stream" in a).toBe(false);
  });

  it("stop_reason=max_tokens throws anthropic_truncated and never parses partial JSON", async () => {
    const { client } = clientWith({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '{"findings":[{"severity":"bl' }],
    });
    await expect(
      generateFindings(input, { mode: "anthropic", anthropicClient: client }),
    ).rejects.toMatchObject({ code: "anthropic_truncated" });
  });
});
