/**
 * Test helper (G-309 A20): the LLM paths are Anthropic-only, so route
 * tests that used to stub a Grok `completeChat` now stub an
 * Anthropic-shaped client whose `messages.create` forwards
 * `{ system, user }` to the same chat mock and wraps the string reply
 * in a text content block. No network call is made.
 */
type ChatFn = (opts: { system?: string; user: string; model?: string }) => unknown;

export function anthropicChatShim(chat: ChatFn) {
  const create = async (params: {
    model?: string;
    system?: string;
    messages: Array<{ content: string }>;
  }) => {
    const text = await chat({
      system: params.system,
      user: params.messages[0]?.content ?? "",
      model: params.model,
    });
    return { content: [{ type: "text", text: String(text ?? "") }] };
  };
  // The code-citing paths call the beta endpoint (server-side refusal
  // fallback, G-309 A23); `messages` is kept for any non-Opus caller.
  return { messages: { create }, beta: { messages: { create } } } as never;
}
