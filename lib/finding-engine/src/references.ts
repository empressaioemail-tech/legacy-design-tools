/**
 * Formal reference section — mint deduplicated {@link CodeReferenceEntry}
 * rows from cited code-section atoms the caller retrieved (gate allow-list).
 *
 * Findings carry inline `[[CODE:<atomId>]]` tokens; `references[]` is the
 * authoritative bibliography those tokens resolve against. A finding can only
 * cite an atom present in `input.codeSections` — the anti-hallucination seam.
 */

import type {
  CodeReferenceEntry,
  CodeSectionInput,
  EngineFinding,
} from "./types";

function provenanceFields(
  section: CodeSectionInput,
): Omit<CodeReferenceEntry, "atomId"> {
  if (section.provenance) {
    return {
      sectionIdentifier: section.provenance.sectionIdentifier,
      sectionTitle: section.provenance.sectionTitle,
      edition: section.provenance.edition,
      sourceUrl: section.provenance.sourceUrl,
      codeTitle: section.provenance.codeTitle,
    };
  }

  const split = section.label.indexOf(" — ");
  const sectionIdentifier =
    split >= 0 ? section.label.slice(0, split) : section.label;
  const sectionTitle = split >= 0 ? section.label.slice(split + 3) : "";

  return {
    sectionIdentifier,
    sectionTitle: sectionTitle || sectionIdentifier,
    edition: section.webProvenance?.edition ?? "",
    sourceUrl: section.webProvenance?.sourceUrl ?? "",
  };
}

/** Project one retrieved code-section atom into a reference row. */
export function mintReferenceEntry(section: CodeSectionInput): CodeReferenceEntry {
  return { atomId: section.atomId, ...provenanceFields(section) };
}

/** Collect code-section atom ids cited inline or on the citations array. */
export function collectCitedCodeAtomIds(
  findings: ReadonlyArray<EngineFinding>,
): string[] {
  const ids = new Set<string>();
  for (const finding of findings) {
    for (const citation of finding.citations) {
      if (citation.kind === "code-section") ids.add(citation.atomId);
    }
    for (const match of finding.text.matchAll(/\[\[CODE:([^\]]+)\]\]/g)) {
      ids.add(match[1]!);
    }
  }
  return [...ids];
}

/**
 * Build a deduplicated `references[]` for surviving findings. Only atoms
 * present in the caller-supplied `codeSections` allow-list are included.
 */
export function buildDeduplicatedReferences(
  findings: ReadonlyArray<EngineFinding>,
  codeSections: ReadonlyArray<CodeSectionInput>,
): CodeReferenceEntry[] {
  const sectionByAtomId = new Map(
    codeSections.map((section) => [section.atomId, section]),
  );
  const references: CodeReferenceEntry[] = [];
  const seen = new Set<string>();

  for (const atomId of collectCitedCodeAtomIds(findings)) {
    if (seen.has(atomId)) continue;
    const section = sectionByAtomId.get(atomId);
    if (!section) continue;
    seen.add(atomId);
    references.push(mintReferenceEntry(section));
  }

  return references;
}

export interface ReferenceReconciliation {
  /** Inline tokens in finding bodies with no matching references[] row. */
  orphanedInlineTokens: string[];
  /** references[] rows not cited by any surviving finding. */
  uncitedReferenceAtomIds: string[];
}

/** Cross-check inline tokens against the minted references[] block. */
export function reconcileReferencesWithFindings(
  findings: ReadonlyArray<EngineFinding>,
  references: ReadonlyArray<CodeReferenceEntry>,
): ReferenceReconciliation {
  const referenceAtomIds = new Set(references.map((ref) => ref.atomId));
  const citedAtomIds = new Set(collectCitedCodeAtomIds(findings));

  const orphanedInlineTokens: string[] = [];
  for (const finding of findings) {
    for (const match of finding.text.matchAll(/\[\[CODE:([^\]]+)\]\]/g)) {
      const atomId = match[1]!;
      if (!referenceAtomIds.has(atomId)) {
        orphanedInlineTokens.push(`[[CODE:${atomId}]]`);
      }
    }
  }

  const uncitedReferenceAtomIds = references
    .map((ref) => ref.atomId)
    .filter((atomId) => !citedAtomIds.has(atomId));

  return { orphanedInlineTokens, uncitedReferenceAtomIds };
}
