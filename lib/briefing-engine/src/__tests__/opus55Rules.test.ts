/**
 * G-309 A20: Opus 5.5 request/response rules for the parcel briefing call.
 */
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateBriefing } from "../engine";

const input = { engagementId: "eng-1", sources: [], generatedBy: "system:test" };
const sections = JSON.stringify({ a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g" });

function clientWith(response: unknown) {
  const create = vi.fn(async () => response);
  return { create, client: { messages: { create } } as unknown as Anthropic };
}

describe("briefing: Opus 5.5 rules", () => {
  it("uses claude-opus-5-5, effort medium, and none of the rejected params", async () => {
    const { create, client } = clientWith({
      stop_reason: "end_turn",
      content: [{ type: "text", text: sections }],
    });
    await generateBriefing(input, { mode: "anthropic", anthropicClient: client });
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
        { type: "text", text: sections },
      ],
    });
    const out = await generateBriefing(input, { mode: "anthropic", anthropicClient: client });
    expect(out.sections.a).toBeDefined();
  });

  it("stop_reason=refusal throws a typed refusal error", async () => {
    const { client } = clientWith({
      stop_reason: "refusal",
      content: [{ type: "text", text: sections }],
    });
    await expect(
      generateBriefing(input, { mode: "anthropic", anthropicClient: client }),
    ).rejects.toMatchObject({ code: "anthropic_refusal" });
  });
});
