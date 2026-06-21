/**
 * S1 — production precedence wire for the finding engine.
 *
 * When multiple federal/model/local accessibility standards apply on the
 * same topic+dimension, reconcile deterministically instead of LLM-improvising.
 * Scope: accessibility domain only (federal + model code + local amendments).
 * Does NOT claim zoning or CC&R reconciliation.
 */

import type { CodeSectionInput } from "../types";
import type { RawFindingDraft } from "../anthropicGenerator";
import type { ApplicableRequirement } from "./types";
import {
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
} from "./accessibilityDemo";
import { detectStandardDescriptor } from "./standardRegistry";
import {
  reconcileRequirementsByTopic,
  formatPrecedenceFindingText,
} from "./reconcile";

/** Known accessibility topic patterns — hero GTM path (door maneuvering clearance). */
const KNOWN_ACCESSIBILITY_SECTIONS: ReadonlyArray<{
  atomIdPattern: RegExp;
  topic: string;
  dimension: string;
  requirementKind: ApplicableRequirement["requirementKind"];
  numericValue: number;
  numericUnit: string;
  confidence: number;
}> = [
  {
    atomIdPattern: /2010-ada-standards.*404\.2\.3|ada.*door.*clear/i,
    topic: "door-maneuvering-clearance",
    dimension: "latch-side clearance",
    requirementKind: "minimum",
    numericValue: 18,
    numericUnit: "in",
    confidence: 0.94,
  },
  {
    atomIdPattern: /fair-housing-act.*door|fha.*ch4.*door/i,
    topic: "door-maneuvering-clearance",
    dimension: "latch-side clearance",
    requirementKind: "minimum",
    numericValue: 24,
    numericUnit: "in",
    confidence: 0.91,
  },
  {
    atomIdPattern: /a117\.?1.*404\.2\.3|a11712021.*clear/i,
    topic: "door-maneuvering-clearance",
    dimension: "latch-side clearance",
    requirementKind: "minimum",
    numericValue: 18,
    numericUnit: "in",
    confidence: 0.75,
  },
];

function exactAtomOverrides(atomId: string): (typeof KNOWN_ACCESSIBILITY_SECTIONS)[number] | null {
  const map: Record<string, (typeof KNOWN_ACCESSIBILITY_SECTIONS)[number]> = {
    [ADA_DOOR_CLEARANCE_ATOM_ID]: KNOWN_ACCESSIBILITY_SECTIONS[0]!,
    [FHA_DOOR_CLEARANCE_ATOM_ID]: KNOWN_ACCESSIBILITY_SECTIONS[1]!,
    [A1171_DOOR_CLEARANCE_ATOM_ID]: KNOWN_ACCESSIBILITY_SECTIONS[2]!,
  };
  return map[atomId] ?? null;
}

function sectionToRequirement(section: CodeSectionInput): ApplicableRequirement | null {
  const exact = exactAtomOverrides(section.atomId);
  const pattern =
    exact ??
    KNOWN_ACCESSIBILITY_SECTIONS.find((k) => k.atomIdPattern.test(section.atomId));

  if (!pattern) return null;

  const detected = detectStandardDescriptor(section.atomId, section.label);
  if (!detected) return null;

  // Accessibility domain only — skip undetected or non-accessibility model codes
  const isAccessibility =
    detected.authority === "federal" ||
    detected.standardKey === "a117.1-2021" ||
    detected.standardKey === "ada-2010" ||
    detected.standardKey === "fha-design-manual" ||
    (detected.authority === "local-amendment" &&
      /door|clearance|maneuver|404/i.test(`${section.atomId} ${section.label}`));

  if (!isAccessibility) return null;

  return {
    atomId: section.atomId,
    standardKey: detected.standardKey,
    standardLabel: detected.standardLabel,
    authority: detected.authority,
    topic: pattern.topic,
    dimension: pattern.dimension,
    requirementKind: pattern.requirementKind,
    numericValue: pattern.numericValue,
    numericUnit: pattern.numericUnit,
    citationLabel: section.label,
    snippet: section.snippet,
    confidence: section.webProvenance?.confidence ?? pattern.confidence,
  };
}

/**
 * Build deterministic precedence findings from retrieved code sections.
 * Returns drafts to prepend; LLM still runs for non-reconciled topics.
 */
export function buildPrecedenceFindingDrafts(
  codeSections: ReadonlyArray<CodeSectionInput>,
): RawFindingDraft[] {
  const { reconciliations } = precedenceReconciliationsFromCodeSections(codeSections);
  return reconciliations.map((rec) => ({
    severity: "blocker" as const,
    category: "other" as const,
    text: formatPrecedenceFindingText(rec),
    citations: [...rec.citations],
    confidence: rec.confidence,
    lowConfidence: rec.confidence < 0.8,
    elementRef: null,
    sourceRef: null,
  }));
}

/** Expose reconciliations for F5 raw-conflict logging. */
export function precedenceReconciliationsFromCodeSections(
  codeSections: ReadonlyArray<CodeSectionInput>,
) {
  const requirements: ApplicableRequirement[] = [];
  for (const section of codeSections) {
    const req = sectionToRequirement(section);
    if (req) requirements.push(req);
  }

  if (requirements.length < 2) {
    return { reconciliations: [] as ReturnType<typeof reconcileRequirementsByTopic>["reconciliations"] };
  }

  return reconcileRequirementsByTopic({
    requirements,
    options: { domain: "accessibility", federalPreempts: true },
  });
}
