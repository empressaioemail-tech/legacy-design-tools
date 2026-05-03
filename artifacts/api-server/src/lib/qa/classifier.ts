/**
 * Task #482 — QA autopilot findings classifier.
 *
 * Parses a raw test-runner log (vitest + playwright surfaces) into a
 * list of structured findings. The rules table is intentionally kept
 * small and explicit: each rule is a `(label, regex, category)` triple
 * matched against per-failure error blocks. New categories can be
 * added by extending `CATEGORY_RULES`.
 *
 * The classifier never makes a verdict on whether a finding is "safe
 * to auto-fix" — that gate lives in the fixer allow-list. Here we only
 * shape the data the dashboard renders.
 */

import type {
  AutopilotFindingCategory,
  AutopilotFindingSeverity,
} from "@workspace/db";

export interface ClassifiedFinding {
  testName: string | null;
  filePath: string | null;
  line: number | null;
  errorExcerpt: string;
  category: AutopilotFindingCategory;
  severity: AutopilotFindingSeverity;
  plainSummary: string;
}

interface CategoryRule {
  category: AutopilotFindingCategory;
  patterns: ReadonlyArray<RegExp>;
  summary: string;
}

const CATEGORY_RULES: ReadonlyArray<CategoryRule> = [
  {
    category: "snapshot",
    summary: "Snapshot mismatch",
    patterns: [
      /Snapshot.*(mismatch|did not match)/i,
      /toMatchSnapshot/i,
      /toMatchInlineSnapshot/i,
      /snapshot.*obsolete/i,
    ],
  },
  {
    category: "codegen-stale",
    summary: "Generated client/spec is out of date",
    patterns: [
      /openapi.*out[- ]of[- ]date/i,
      /api[- ]?client.*not (in sync|generated)/i,
      /generated.*stale/i,
      /run.*api-spec.*codegen/i,
      /Cannot find module.*generated/i,
    ],
  },
  {
    category: "lint",
    summary: "Lint or formatting violation",
    patterns: [
      /eslint.*error/i,
      /prettier.*(failed|formatting)/i,
      /Insert.*·/,
      /Delete.*·/,
      /Replace.*·/,
    ],
  },
  {
    category: "flaky",
    summary: "Looks like a flake — timeout or transient timing failure",
    patterns: [
      /Test timed out/i,
      /Timeout.*exceeded.*while/i,
      /flaky/i,
      /retried/i,
      /ECONNRESET/i,
      /target page.*closed/i,
    ],
  },
  {
    category: "fixture",
    summary: "Test fixture missing or out of date",
    patterns: [/fixture.*missing/i, /no such file.*__fixtures__/i],
  },
];

/**
 * Heuristic split of a test-runner log into per-failure blocks. Vitest
 * marks failures with a `FAIL` header and an indented error body;
 * playwright surfaces use `✘` / `Error:`. We grab a generous window
 * around each marker so the FE has enough context for the read-only
 * "suggested next step" view, then de-dupe blocks that are substrings
 * of one another so the same failure doesn't show twice.
 */
function extractFailureBlocks(log: string): Array<{
  testName: string | null;
  filePath: string | null;
  line: number | null;
  excerpt: string;
}> {
  const lines = log.split(/\r?\n/);
  const blocks: Array<{
    testName: string | null;
    filePath: string | null;
    line: number | null;
    excerpt: string;
  }> = [];

  // Vitest: lines like ` FAIL  src/foo.test.ts > describe > it`.
  // Playwright: ` ✘  1 …e2e/foo.spec.ts:42:5 › title`.
  const headerRegex =
    /^(?:\s*(?:FAIL|✘|×|✗)\s|\s*\d+\)\s|\s*Error:\s)/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !headerRegex.test(line)) continue;
    const headerEnd = Math.min(i + 12, lines.length);
    const excerpt = lines.slice(i, headerEnd).join("\n").trim();
    const fileLine = excerpt.match(/([^\s()]+\.(?:ts|tsx|js|jsx)):(\d+)(?::(\d+))?/);
    const filePath = fileLine?.[1] ?? null;
    const lineNo = fileLine?.[2] ? Number(fileLine[2]) : null;
    const testNameMatch = excerpt.match(/›\s*(.+?)(?:\n|$)/) ??
      excerpt.match(/>\s*(.+?)(?:\n|$)/);
    const testName = testNameMatch?.[1]?.trim() ?? null;
    blocks.push({
      testName,
      filePath,
      line: lineNo,
      excerpt: excerpt.slice(0, 1500),
    });
  }

  // Dedupe — the same failure can be reported in vitest's summary
  // header and again in the per-test detail.
  const seen = new Set<string>();
  return blocks.filter((b) => {
    const key = `${b.filePath ?? ""}::${b.testName ?? ""}::${b.excerpt.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyExcerpt(excerpt: string): {
  category: AutopilotFindingCategory;
  summary: string;
} {
  for (const rule of CATEGORY_RULES) {
    for (const p of rule.patterns) {
      if (p.test(excerpt)) {
        return { category: rule.category, summary: rule.summary };
      }
    }
  }
  return {
    category: "app-code",
    summary: "Test failure — likely product or test code regression",
  };
}

/**
 * Convert a runner log into structured findings. When the run passed,
 * returns []. When the run failed but we couldn't extract a single
 * failure block (unexpected output shape), we emit a single
 * `unknown`-category finding so the dashboard never silently swallows
 * a red suite.
 */
export function classifyRunLog(opts: {
  status: "passed" | "failed" | "errored";
  log: string;
}): ClassifiedFinding[] {
  if (opts.status === "passed") return [];
  const blocks = extractFailureBlocks(opts.log);
  if (blocks.length === 0) {
    return [
      {
        testName: null,
        filePath: null,
        line: null,
        errorExcerpt: opts.log.slice(-1500),
        category: opts.status === "errored" ? "unknown" : "app-code",
        severity: "error",
        plainSummary:
          opts.status === "errored"
            ? "The runner exited abnormally — see log for details."
            : "Suite failed but no individual test failure could be parsed from the log.",
      },
    ];
  }
  return blocks.map((b) => {
    const { category, summary } = classifyExcerpt(b.excerpt);
    return {
      testName: b.testName,
      filePath: b.filePath,
      line: b.line,
      errorExcerpt: b.excerpt,
      category,
      severity: category === "flaky" ? "warning" : "error",
      plainSummary: summary,
    };
  });
}
