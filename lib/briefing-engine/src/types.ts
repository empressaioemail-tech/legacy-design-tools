/**
 * Public types for the briefing engine. Defined here (rather than at
 * the call site) so external packages — the api-server route, tests,
 * and downstream renderers — share a single contract surface.
 *
 * The seven A–G sections come from Spec 51 §2; the per-section citation
 * rules and architect-audience weighting come from Spec 51 §1.2. The
 * engine returns ALL seven sections on every successful call: a section
 * with no source data turns into a "gap note" rather than being omitted,
 * so the downstream UI never has to branch on missing keys.
 */

/**
 * One source row the engine reads. Mirrors the api-server's
 * `BriefingSourceWire` shape but stripped of the upload/conversion
 * columns the prompt assembly does not need.
 */
export interface BriefingSourceInput {
  /** Stable id used in `{{atom|briefing-source|<id>|<label>}}` tokens. */
  id: string;
  /** Layer slug — e.g. `qgis-zoning`, `fema-flood`, `nws-snow-load`. */
  layerKind: string;
  /** Producer flavor (`manual-upload` or `federal-adapter`). */
  sourceKind: string;
  /** Human-readable provider, used as the citation displayLabel fallback. */
  provider: string | null;
  /** Effective date of the data, ISO-8601 string. */
  snapshotDate: string;
  /** Optional free-text producer note. */
  note: string | null;
  /**
   * Structured payload the producer wrote (parsed GeoJSON / API
   * response). The engine prompt assembler serializes a compact
   * summary; the raw payload is also passed through for the Anthropic
   * branch.
   */
  payload?: unknown;
}

/**
 * Optional code-section atom citation passed to the prompt. The engine
 * does NOT fetch code sections itself — the caller (the api-server
 * route) resolves these through the codes package and hands them in.
 */
export interface CodeSectionInput {
  /** The atom id used in `[[CODE:<atomId>]]` tokens. */
  atomId: string;
  /** Short human label rendered in citation chips. */
  label: string;
  /** Optional snippet the prompt may quote. */
  snippet?: string;
}

/** Engine input bundle. */
export interface GenerateBriefingInput {
  engagementId: string;
  /** Optional human label for the engagement (project name, address). */
  engagementLabel?: string;
  sources: ReadonlyArray<BriefingSourceInput>;
  codeSections?: ReadonlyArray<CodeSectionInput>;
  /**
   * Identity stamped on the resulting `generated_by` column. Pass the
   * actor uuid for user-initiated runs, `system:briefing-engine` for
   * unattended runs.
   */
  generatedBy: string;
}

/**
 * The seven A–G section bodies. Free-form text containing inline
 * citation tokens (`{{atom|briefing-source|<id>|<label>}}` and
 * `[[CODE:<atomId>]]`). All seven keys are always present in a
 * successful generation; an empty section returns a single-line gap
 * note (e.g. "Soil data not available — order a soils test.") rather
 * than the empty string.
 */
export interface BriefingSections {
  a: string;
  b: string;
  c: string;
  d: string;
  e: string;
  f: string;
  g: string;
}

/** Successful engine output. */
export interface GenerateBriefingResult {
  sections: BriefingSections;
  /**
   * Citation tokens the engine emitted that did NOT resolve to a real
   * source/code-section. The route logs these for observability; the
   * narrative itself has those tokens stripped before being persisted
   * (see `citationValidator.ts`).
   */
  invalidCitations: ReadonlyArray<string>;
  /** When the narrative was generated. */
  generatedAt: Date;
  /** Pass-through of the input value. */
  generatedBy: string;
  /**
   * Producer label for the run — `mock` or `anthropic`. Useful for
   * tests and observability without re-reading the env flag.
   */
  producer: BriefingLlmMode;
}

/** LLM provider modes selected by `BRIEFING_LLM_MODE`. */
export type BriefingLlmMode = "mock" | "anthropic";

/**
 * Section keys grouped per Spec 51 §1.2 architect-audience weighting:
 * B/E/F/G heavier than C/D. The mock generator emits longer narrative
 * for the heavy sections; the prompt assembler tells Anthropic to do
 * the same.
 */
export const HEAVY_SECTIONS = ["b", "e", "f", "g"] as const;
export const LIGHT_SECTIONS = ["c", "d"] as const;

/**
 * Per-section human label (used in prompts + as the gap-note section
 * name). Lifted directly from Spec 51 §2.
 */
export const SECTION_LABELS: Readonly<Record<keyof BriefingSections, string>> =
  {
    a: "Executive Summary",
    b: "Threshold Issues",
    c: "Regulatory Gates",
    d: "Site Infrastructure",
    e: "Buildable Envelope",
    f: "Neighboring Context",
    g: "Next-Step Checklist",
  };
