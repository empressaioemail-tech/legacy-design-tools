import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { instrumentAnthropicClient } from "../instrumentedClient";

const response = {
  model: "claude-opus-5-5",
  usage: { input_tokens: 1000, output_tokens: 500 },
};

function fakeClient() {
  return {
    messages: { create: async () => response },
    beta: { messages: { create: async () => response } },
  } as unknown as Anthropic;
}

describe("instrumentAnthropicClient", () => {
  it("records spend for messages.create", async () => {
    const wrapped = instrumentAnthropicClient(fakeClient());
    await wrapped.client.messages.create({} as never);
    expect(wrapped.drain()).toHaveLength(1);
  });

  it("records spend for beta.messages.create (server-side fallback path, G-309 A23)", async () => {
    const wrapped = instrumentAnthropicClient(fakeClient());
    await wrapped.client.beta.messages.create({} as never);
    const calls = wrapped.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "claude-opus-5-5",
      inputTokens: 1000,
      outputTokens: 500,
    });
  });
});
