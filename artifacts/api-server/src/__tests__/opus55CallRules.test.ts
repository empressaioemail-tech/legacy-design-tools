/**
 * G-309 A20: static guard over every code-citing Anthropic call site.
 * Opus 5.5 returns 400 for temperature/top_p/top_k, thinking disabled or
 * budget_tokens, forced tool_choice (any/tool) and assistant prefill.
 * No DB, no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, "..", "..", "..", "..", rel), "utf8");

const FILES = [
  "artifacts/api-server/src/routes/chat.ts",
  "artifacts/api-server/src/routes/chatWorkspace.ts",
  "artifacts/api-server/src/lib/brokerageBriefLlm.ts",
  "artifacts/api-server/src/lib/propertyBriefLaySummary.ts",
  "lib/finding-engine/src/anthropicGenerator.ts",
  "lib/briefing-engine/src/anthropicGenerator.ts",
];

describe("Opus 5.5 rules at code-citing call sites", () => {
  for (const f of FILES) {
    it(`${f}: no rejected params`, () => {
      const src = read(f);
      expect(src).not.toMatch(/\btemperature\s*:/);
      expect(src).not.toMatch(/\btop_[pk]\s*:/);
      expect(src).not.toMatch(/\bbudget_tokens\b/);
      expect(src).not.toMatch(/thinking\s*:\s*\{\s*type\s*:\s*"disabled/);
      expect(src).not.toMatch(/tool_choice/);
    });
  }

  it("chat and workspace chat use the shared model constant, effort low, refusal check", () => {
    for (const f of FILES.slice(0, 2)) {
      const src = read(f);
      expect(src).toContain("model: CODE_CITING_ANTHROPIC_MODEL");
      expect(src).toContain("output_config: CODE_CITING_OUTPUT_CONFIG_LOW");
      expect(src).not.toContain("claude-sonnet-4-6");
      expect(src).toContain("isAnthropicRefusal(finalMessage)");
    }
  });

  it("no code-citing path hardcodes a model id", () => {
    for (const f of FILES) {
      expect(read(f)).not.toMatch(/model:\s*"claude-/);
    }
  });
});
