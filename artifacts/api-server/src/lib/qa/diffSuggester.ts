/**
 * Task #483 — Suggest concrete edits for `app-code` findings.
 *
 * Given a single classified finding (the failure block + file/line
 * hints the classifier already extracted), this module produces a
 * unified-diff patch the user can paste into `git apply` — or just
 * read as a hint. The output is stored on
 * `autopilot_findings.suggestedDiff` and rendered by the Findings
 * Report.
 *
 * Safety contract:
 *   - The suggester is **proposal only**. Nothing in this module — or
 *     any of its callers — writes to the working tree. The autopilot
 *     orchestrator persists the string to the DB and the dashboard
 *     renders it; applying it is a manual, user-initiated step.
 *   - The mock branch is the default and is fully deterministic so
 *     tests, CI, and dev environments never reach an LLM.
 *
 * Mode is selected from `AIR_AUTOPILOT_DIFF_MODE`:
 *   - `mock`      (default) — returns an empty string. We deliberately
 *                  do NOT fabricate a placeholder patch in mock mode:
 *                  the dashboard treats an empty `suggestedDiff` as
 *                  "no suggestion available" and hides the diff card,
 *                  which is the honest answer when no LLM is wired up.
 *   - `anthropic` — calls Claude Sonnet via the workspace
 *                  `@workspace/integrations-anthropic-ai` integration.
 *                  Requires `AI_INTEGRATIONS_ANTHROPIC_*` env vars.
 *
 * Tests inject a custom suggester via {@link setDiffSuggesterForTests}
 * so the autopilot orchestration can be exercised end-to-end without
 * touching the env or the network.
 */

import { logger } from "../logger";
import type { ClassifiedFinding } from "./classifier";

export type DiffSuggester = (finding: ClassifiedFinding) => Promise<string>;

export type DiffSuggesterMode = "mock" | "anthropic";

export function resolveDiffSuggesterMode(): DiffSuggesterMode {
  const raw = (process.env["AIR_AUTOPILOT_DIFF_MODE"] ?? "mock").toLowerCase();
  return raw === "anthropic" ? "anthropic" : "mock";
}

let override: DiffSuggester | null = null;

export function setDiffSuggesterForTests(s: DiffSuggester | null): void {
  override = s;
}

export async function suggestDiffForFinding(
  finding: ClassifiedFinding,
): Promise<string> {
  if (override) return override(finding);
  const mode = resolveDiffSuggesterMode();
  if (mode === "anthropic") {
    try {
      return await suggestViaAnthropic(finding);
    } catch (err) {
      logger.warn(
        { err, file: finding.filePath },
        "autopilot: anthropic diff suggester failed — leaving suggestedDiff blank",
      );
      return "";
    }
  }
  // Mock mode: deliberately no suggestion. We never fabricate a fake
  // patch — empty string means "no proposal", and the UI hides the
  // diff card.
  return "";
}

async function suggestViaAnthropic(
  finding: ClassifiedFinding,
): Promise<string> {
  // Dynamic import keeps the integration's env-var assertions out of
  // the load path when we're in mock mode (the default).
  const { createAnthropicClient } = await import(
    "@workspace/integrations-anthropic-ai"
  );
  const client = createAnthropicClient();
  const prompt = buildPrompt(finding);
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return extractDiff(text);
}

function buildPrompt(finding: ClassifiedFinding): string {
  return [
    "You are reviewing a failing test in a TypeScript monorepo.",
    "Propose the smallest unified-diff patch a developer could apply to make the test pass.",
    "Return ONLY the diff, fenced in ```diff … ```. No prose, no explanation.",
    "If you cannot confidently produce a patch, respond with an empty diff.",
    "Never propose changes outside the file referenced by the failure.",
    "",
    `File: ${finding.filePath ?? "(unknown)"}`,
    `Line: ${finding.line ?? "(unknown)"}`,
    `Test: ${finding.testName ?? "(unknown)"}`,
    "Failure excerpt:",
    "```",
    finding.errorExcerpt,
    "```",
  ].join("\n");
}

/**
 * Pull the first ```diff … ``` fenced block out of the model's reply.
 * Falls back to the trimmed body if no fence is found but the body
 * still looks like a diff (starts with `---` / `+++` / `@@`).
 */
function extractDiff(text: string): string {
  const fenced = text.match(/```(?:diff|patch)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  if (/^\s*(?:---|\+\+\+|@@)/m.test(text)) return text.trim();
  return "";
}
