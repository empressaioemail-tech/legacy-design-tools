/**
 * Anthropic branch of the briefing engine.
 *
 * Calls Claude (CODE_CITING_ANTHROPIC_MODEL) via the workspace's `createAnthropicClient`
 * factory (passed in by the caller — keeping the SDK constructor out
 * of this module means tests can hand a stub fetcher in without
 * importing the real SDK).
 *
 * Contract:
 *   - System + user prompts come from `prompt.ts`.
 *   - Claude responds with a strict JSON object  { "a": "...", ..., "g": "..." } .
 *   - We tolerate (and strip) accidental markdown fencing — Claude
 *     occasionally wraps JSON in a  ```json ... ```  fence even when
 *     told not to. Anything else (truncated JSON, missing keys) is a
 *     hard failure that bubbles up as an `AnthropicGeneratorError`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { BriefingSections, GenerateBriefingInput } from "./types";
import { BRIEFING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

/**
 * Single model id for every code-citing Anthropic call (findings, parcel
 * briefing, brokerage brief, lay summary, Ask chat). Operator ruling
 * 2026-11-04. Opus 5.5 rules: thinking cannot be disabled (never send
 * the disabled thinking mode or a thinking budget; sampling params return
 * 400, forced tool choice (any or tool) returns 400, and a final assistant
 * message (prefill) returns 400. None of those are sent here.
 */
export const CODE_CITING_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Effort for findings, parcel briefing and the brokerage brief. */
export const CODE_CITING_OUTPUT_CONFIG_MEDIUM = { effort: "medium" } as const;
/** Effort for the lay summary and the Ask chat. */
export const CODE_CITING_OUTPUT_CONFIG_LOW = { effort: "low" } as const;

/**
 * Text of a response, taken from `text` blocks only. Opus 5.5 responses
 * can lead with thinking blocks (possibly empty), so never read
 * `content[0]`.
 */
export function textFromAnthropicContent(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** True when the model refused; check BEFORE reading content. */
export function isAnthropicRefusal(response: {
  stop_reason?: string | null;
}): boolean {
  return response.stop_reason === "refusal";
}

export const BRIEFING_ANTHROPIC_MODEL = CODE_CITING_ANTHROPIC_MODEL;

/** Token budget per generation. Tuned for ~7×500-token sections plus headroom. */
export const BRIEFING_ANTHROPIC_MAX_TOKENS = 4096;

export class AnthropicGeneratorError extends Error {
  constructor(
    public readonly code:
      | "anthropic_call_failed"
      | "anthropic_refusal"
      | "anthropic_invalid_response_shape"
      | "anthropic_invalid_json"
      | "anthropic_missing_section",
    message: string,
  ) {
    super(message);
    this.name = "AnthropicGeneratorError";
    Object.setPrototypeOf(this, AnthropicGeneratorError.prototype);
  }
}

/**
 * Strip a leading ```json fence + trailing ``` if Claude wrapped its
 * JSON despite the prompt's "no markdown fencing" instruction.
 * Idempotent — the unfenced path is a no-op.
 */
function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  // Match ```json\n...\n``` (with optional language tag).
  const fenceRe = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i;
  const m = trimmed.match(fenceRe);
  return m ? m[1].trim() : trimmed;
}

const SECTION_KEYS = ["a", "b", "c", "d", "e", "f", "g"] as const;

/** Parse Claude's JSON response into the seven-section shape. */
export function parseAnthropicResponse(raw: string): BriefingSections {
  const cleaned = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new AnthropicGeneratorError(
      "anthropic_invalid_json",
      `Claude response is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AnthropicGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response is not a JSON object`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const out: Partial<BriefingSections> = {};
  for (const key of SECTION_KEYS) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new AnthropicGeneratorError(
        "anthropic_missing_section",
        `Claude response missing or non-string section "${key}"`,
      );
    }
    out[key] = v;
  }
  return out as BriefingSections;
}

/**
 * Run one Claude call against the input bundle and return the parsed
 * sections. The caller is responsible for citation validation; this
 * module is concerned with the network call + JSON parse only.
 */
export async function callAnthropicGenerator(
  client: Anthropic,
  input: GenerateBriefingInput,
): Promise<BriefingSections> {
  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: BRIEFING_ANTHROPIC_MODEL,
      max_tokens: BRIEFING_ANTHROPIC_MAX_TOKENS,
      output_config: CODE_CITING_OUTPUT_CONFIG_MEDIUM,
      system: BRIEFING_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input),
        },
      ],
    });
  } catch (err) {
    throw new AnthropicGeneratorError(
      "anthropic_call_failed",
      `Anthropic call failed: ${(err as Error).message}`,
    );
  }

  if (isAnthropicRefusal(response)) {
    throw new AnthropicGeneratorError(
      "anthropic_refusal",
      "Claude refused the briefing request (stop_reason=refusal)",
    );
  }
  // Text blocks only (thinking blocks may precede the text).
  const text = textFromAnthropicContent(response.content);
  if (text.length === 0) {
    throw new AnthropicGeneratorError(
      "anthropic_invalid_response_shape",
      `Claude response had no text content blocks`,
    );
  }
  return parseAnthropicResponse(text);
}
