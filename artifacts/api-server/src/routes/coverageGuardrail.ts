/**
 * QA-23 — in-app agent honesty guardrail.
 *
 * The in-app chat agent was observed presenting fabricated code as a
 * confident citation for a jurisdiction it has no atoms for — it cited
 * invented "Grand County, Colorado" sections for a Pagosa Springs
 * engagement. This module builds the system-prompt guardrail that closes
 * that gap: when the engagement's jurisdiction has no real, ingested code
 * coverage, the agent must say so plainly and mark any code answer as
 * model-knowledge-only and ungrounded rather than inventing a citation.
 *
 * Kept as a standalone, dependency-free module so it can be unit-tested
 * without pulling in the DB / route graph.
 */

/**
 * Coverage state for the engagement's jurisdiction.
 *
 *  - `covered`      — the jurisdiction has ingested code atoms; the agent
 *                     may cite the `<reference_code_atoms>` block normally
 *                     and no guardrail is appended.
 *  - `no_atoms`     — the jurisdiction resolved to a key, but zero code
 *                     atoms have been ingested for it.
 *  - `unrecognized` — the engagement has no resolvable jurisdiction key
 *                     (not geocoded, or a location outside the registry).
 */
export type JurisdictionCoverage = "covered" | "no_atoms" | "unrecognized";

/**
 * Build the honesty-guardrail fragment appended to the chat system prompt.
 * Returns `""` when coverage exists — the normal grounded path needs no
 * guardrail. For `no_atoms` / `unrecognized` it returns a hard instruction
 * block that forbids fabricated citations and requires an explicit
 * ungrounded / model-knowledge-only disclosure.
 */
export function buildCoverageGuardrail(input: {
  coverage: JurisdictionCoverage;
  jurisdictionLabel: string;
}): string {
  if (input.coverage === "covered") return "";

  const label = input.jurisdictionLabel;
  const situation =
    input.coverage === "unrecognized"
      ? "This engagement has no recognized jurisdiction — its location has " +
        "not been geocoded to a jurisdiction in the Cortex code corpus."
      : `This engagement's jurisdiction (${label}) is NOT in the Cortex ` +
        "code corpus — zero code sections have been ingested for it.";

  return (
    "\n\n" +
    "<jurisdiction_coverage_guardrail>\n" +
    "GROUNDING CHECK — applies to every building, zoning, and land-use code " +
    "answer, and to any code review you run this turn.\n\n" +
    situation +
    " You therefore have NO verified code text for this location. The " +
    "`<reference_code_atoms>` block is empty because nothing exists to " +
    "retrieve, not because the question missed.\n\n" +
    "You MUST:\n" +
    `  - Open any code-related answer by stating plainly that ${label} is ` +
    "not yet in the Cortex code corpus, so the answer is model-knowledge-only " +
    "and ungrounded — general guidance, not a verified citation.\n" +
    "  - NOT present specific section numbers, ordinance titles, tables, or " +
    "setback / height / lot / parking / use figures as authoritative. You " +
    "have not read this jurisdiction's adopted code; do not imply that you " +
    "have.\n" +
    "  - Name the jurisdiction and your confidence level explicitly.\n" +
    `  - Recommend the operator verify against ${label}'s actual adopted ` +
    "code, and note the jurisdiction still needs to be ingested.\n\n" +
    'Answering "I do not have verified code for this jurisdiction" is the ' +
    "correct, expected response. Inventing a confident-sounding citation is " +
    "a quality-gate failure — do not do it.\n" +
    "</jurisdiction_coverage_guardrail>"
  );
}
