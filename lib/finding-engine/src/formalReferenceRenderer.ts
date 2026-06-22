/**
 * Formal reference block renderer (ICC PoC criterion 1).
 *
 * Renders section identifier + title + edition per cited atom. Does not
 * reproduce section bodies — identifiers only (layer-in-between).
 *
 * The identifier string format is a render parameter because ICC has not
 * yet confirmed the exact citation grammar (open question #2).
 */

import type { CodeReferenceEntry } from "./types";

/**
 * ICC-facing identifier layout. Default: section number + heading + edition.
 * Shells (municipal IPMC, B2B IBC) pass the format at render time.
 */
export type SectionIdentifierFormat =
  | "section-number-heading-edition"
  | "section-number-heading"
  | "section-number-only"
  | "heading-edition";

export interface RenderFormalReferenceOptions {
  format?: SectionIdentifierFormat;
  /** Block heading — default `References`. */
  heading?: string;
}

function editionSuffix(edition: string): string {
  const trimmed = edition.trim();
  return trimmed.length > 0 ? ` (${trimmed})` : "";
}

/** Format one reference row for display (no section body). */
export function formatReferenceLine(
  reference: CodeReferenceEntry,
  format: SectionIdentifierFormat = "section-number-heading-edition",
): string {
  const prefix = reference.codeTitle?.trim()
    ? `${reference.codeTitle.trim()} `
    : "";
  const identifier = reference.sectionIdentifier.trim();
  const title = reference.sectionTitle.trim();
  const edition = reference.edition.trim();

  switch (format) {
    case "section-number-only":
      return `${prefix}${identifier}`.trim();
    case "heading-edition":
      return title.length > 0
        ? `${title}${editionSuffix(edition)}`
        : `${identifier}${editionSuffix(edition)}`;
    case "section-number-heading":
      return title.length > 0
        ? `${prefix}${identifier} — ${title}`.trim()
        : `${prefix}${identifier}`.trim();
    case "section-number-heading-edition":
    default:
      if (title.length > 0) {
        return `${prefix}${identifier} — ${title}${editionSuffix(edition)}`.trim();
      }
      return `${prefix}${identifier}${editionSuffix(edition)}`.trim();
  }
}

/**
 * Render a clean, formal reference block from deduplicated references[].
 * Returns an empty string when there are no references.
 */
export function renderFormalReferenceBlock(
  references: ReadonlyArray<CodeReferenceEntry>,
  options: RenderFormalReferenceOptions = {},
): string {
  if (references.length === 0) return "";

  const heading = options.heading ?? "References";
  const format = options.format ?? "section-number-heading-edition";
  const rule = "—".repeat(Math.max(heading.length, 10));
  const lines = references.map(
    (reference, index) =>
      `${index + 1}. ${formatReferenceLine(reference, format)}`,
  );

  return [heading, rule, ...lines].join("\n");
}
