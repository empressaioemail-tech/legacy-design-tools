/**
 * G-309 A20: Opus 5.5 request/response rules for the findings call.
 * No network: Anthropic client is a stub.
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
const ok = JSON.stringify({ findings: [] });

function clientWith(response: unknown) {
  const create = vi.fn(async () => response);
  return { create, client: { messages: { create } } as unknown as Anthropic };
}

describe("findings: Opus 5.5 rules", () => {
  it("uses claude-opus-5-5, effort medium, and none of the rejected params", async () => {
    const { create, client } = clientWith({
      stop_reason: "end_turn",
      content: [{ type: "text", text: ok }],
    });
    await generateFindings(input, { mode: "anthropic", anthropicClient: client });
    const a = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.output_config).toEqual({ effort: "medium" });
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) {
      expect(k in a).toBe(false);
    }
    const msgs = a.messages as Array<{ role: string }>;
    expect(msgs[msgs.length - 1]!.role).toBe("user");
  });

  it("reads text blocks only (empty thinking block first)", async () => {
    const { client } = clientWith({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: ok },
      ],
    });
    await expect(
      generateFindings(input, { mode: "anthropic", anthropicClient: client }),
    ).resolves.toBeDefined();
  });

  it("stop_reason=refusal throws a typed refusal error before reading content", async () => {
    const { client } = clientWith({
      stop_reason: "refusal",
      content: [{ type: "text", text: ok }],
    });
    await expect(
      generateFindings(input, { mode: "anthropic", anthropicClient: client }),
    ).rejects.toMatchObject({ code: "anthropic_refusal" });
  });
});
