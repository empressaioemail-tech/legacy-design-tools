import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SMARTSITE_MCP_TOOLS } from "../src/constants.js";

/**
 * P-109 item 4. The catalog and the runtime must agree, and something must
 * keep them agreeing.
 *
 * The defect this exists for: export_instrument sat at readiness "live" in
 * SMARTSITE_MCP_TOOLS while its handler in src/tools.ts always returned
 * notReadyMessage("export_instrument", ...) because HAUSKA_MCP_BASE_URL was
 * never supplied. Two declarations of one fact, disagreeing, with nothing able
 * to fire. llms.txt advertised it as available for as long as that lasted.
 *
 * What executes: this file, under vitest.
 * What triggers: the "Test" job in .github/workflows/pr-checks.yml (root
 *   `pnpm test` -> `pnpm -r --if-present run test` -> `vitest run` here), on
 *   every pull_request and every push to main. "Test" is a required status
 *   check on main.
 * What fails: a non-zero vitest exit, blocking the merge.
 * What bypasses it: a tool that refuses for a reason this file cannot see - a
 *   dead upstream, a permanently-false flag, a refusal written in a module
 *   other than tools.ts; and anything that does not go through CI.
 *
 * Honest limit, stated because a control whose scope is broader than its claim
 * is worse than a narrow one. BOTH sides of every comparison below are
 * authored in this package by one party, so one party acting alone could
 * satisfy both: these are INTERNAL CONSISTENCY checks. They catch declaration
 * drift, which is exactly the P-109 defect. They do NOT catch a tool that is
 * declared live and is broken upstream. The meaning-shaped version needs a
 * second derivation - a probe of the DEPLOYED server asserting that no
 * live-declared tool answers status "not_ready" - and that is blocked on CI
 * holding a WorkOS OAuth session. It is not built, and this is not it.
 *
 * Note on what the COMPILER already enforces, so this file does not claim
 * credit for it: registerTools narrows tool.name by returning early on
 * readiness "blocked", so a blocked tool that keeps a handler case is a TS2678
 * compile error and a live tool that loses its case is a missing-return error.
 * "Typecheck" is also a required status check. The case-label test below
 * therefore restates a compiler-enforced invariant in a readable form; it is
 * not the load-bearing guard for it.
 */

const TOOLS_SOURCE_PATH = fileURLToPath(
  new URL("../src/tools.ts", import.meta.url),
);

type CatalogEntry = { name: string; readiness: string };

/**
 * The exact text of the defect, pinned as a fixture so the predicate's
 * negative case survives the fix that removed this code from tools.ts.
 * Verbatim from src/tools.ts at origin/main 91bfeed9, lines 853-866.
 */
const P109_DEFECT_FIXTURE = [
  "            if (!loadHauskaMcpConfig()) {",
  "              return {",
  "                content: [",
  "                  {",
  '                    type: "text" as const,',
  "                    text: notReadyMessage(",
  '                      "export_instrument",',
  '                      "P-87 export honesty - Hauska MCP export proxy not configured",',
  "                    ),",
  "                  },",
  "                ],",
  "                isError: true,",
  "              };",
  "            }",
].join("\n");

/** Names declared live that carry a hardcoded not-ready refusal in `source`. */
export function liveToolsWithHardcodedNotReady(
  catalog: readonly CatalogEntry[],
  source: string,
): string[] {
  return catalog
    .filter((tool) => tool.readiness === "live")
    .filter((tool) =>
      new RegExp(`notReadyMessage\\(\\s*"${tool.name}"`).test(source),
    )
    .map((tool) => tool.name);
}

/** Handler case labels inside registerTools only, never inputSchemaFor's. */
export function handlerCaseLabels(source: string): string[] {
  const start = source.indexOf("export function registerTools(");
  if (start < 0) return [];
  return [...source.slice(start).matchAll(/^ +case "([a-z_]+)":/gm)]
    .map((m) => m[1])
    .sort();
}

describe("P-109 item 4: the catalog and the runtime agree", () => {
  const source = readFileSync(TOOLS_SOURCE_PATH, "utf8");

  it("no tool declared live carries a hardcoded not-ready refusal in tools.ts", () => {
    expect(liveToolsWithHardcodedNotReady(SMARTSITE_MCP_TOOLS, source)).toEqual(
      [],
    );
  });

  it("the live tools are exactly the tools with a handler case", () => {
    const live = SMARTSITE_MCP_TOOLS.filter((t) => t.readiness === "live")
      .map((t) => t.name)
      .sort();
    expect(handlerCaseLabels(source)).toEqual(live);
  });

  it("every blocked tool carries a blockedReason naming its plan row", () => {
    const blocked = SMARTSITE_MCP_TOOLS.filter(
      (t) => t.readiness === "blocked",
    );
    expect(blocked.length).toBeGreaterThan(0);
    for (const tool of blocked) {
      const reason = (tool as { blockedReason?: string }).blockedReason;
      expect(reason, `${tool.name} blockedReason`).toBeTruthy();
      expect(reason, `${tool.name} blockedReason`).toMatch(/^P-\d+ item \d+/);
    }
  });

  // DEV_PROCESS 2.2: a gating indicator is tested for its ability to FIRE
  // before it is trusted. A check observed only passing has not been observed
  // working.
  describe("the checks can fail", () => {
    it("the refusal predicate fires on the verbatim P-109 defect text", () => {
      expect(
        liveToolsWithHardcodedNotReady(
          [{ name: "export_instrument", readiness: "live" }],
          P109_DEFECT_FIXTURE,
        ),
      ).toEqual(["export_instrument"]);
    });

    it("the refusal predicate does not fire on that same text when the tool is blocked", () => {
      expect(
        liveToolsWithHardcodedNotReady(
          [{ name: "export_instrument", readiness: "blocked" }],
          P109_DEFECT_FIXTURE,
        ),
      ).toEqual([]);
    });

    it("the refusal predicate does not fire on the generic readiness-driven refusal", () => {
      expect(
        liveToolsWithHardcodedNotReady(
          [{ name: "find_parcel", readiness: "live" }],
          'text: notReadyMessage(tool.name, tool.blockedReason ?? "blocked"),',
        ),
      ).toEqual([]);
    });

    it("the case-label parser sees a blocked tool that kept its handler", () => {
      const withStrayCase = `${source}\n          case "export_instrument": {\n`;
      expect(handlerCaseLabels(withStrayCase)).toContain("export_instrument");
      expect(handlerCaseLabels(source)).not.toContain("export_instrument");
    });

    it("the case-label parser ignores inputSchemaFor's cases above registerTools", () => {
      // ask_the_map is blocked and has a case in inputSchemaFor but none in
      // the handler switch. If the parser read the whole file this would come
      // back true and the live-set test above would be meaningless.
      expect(handlerCaseLabels(source)).not.toContain("ask_the_map");
      expect(source).toMatch(/^ +case "ask_the_map":/m);
    });
  });

  // Anti-vacuity. Both predicates are text-shaped, so a rename or a move makes
  // them match nothing and pass for the wrong reason. These assertions make
  // that failure loud instead. They deliberately do NOT assert that a
  // hardcoded refusal exists in tools.ts: its absence is the fixed state.
  describe("the checks are not vacuous", () => {
    it("read a tools.ts that is the file these predicates were written against", () => {
      expect(source.length).toBeGreaterThan(1000);
      expect(source).toMatch(/function notReadyMessage\(/);
      expect(source).toMatch(/export function registerTools\(/);
    });

    it("the case-label parser found the real handler switch, not nothing", () => {
      expect(handlerCaseLabels(source).length).toBeGreaterThanOrEqual(8);
    });
  });
});
