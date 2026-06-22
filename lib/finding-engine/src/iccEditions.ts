/**
 * Applicable ICC title + edition parsing for the plan-review input contract.
 *
 * Shells (municipal IPMC, B2B IBC) may pass explicit editions; the api-server
 * can also derive them from submission classification `applicableCodeBooks`.
 */

import {
  ICC_CODE_TITLE_VALUES,
  type ApplicableIccEdition,
  type IccCodeTitle,
} from "./types";

const ICC_TITLE_SET = new Set<string>(ICC_CODE_TITLE_VALUES);

function parseIccTitle(raw: string): IccCodeTitle | null {
  const upper = raw.trim().toUpperCase();
  return ICC_TITLE_SET.has(upper) ? (upper as IccCodeTitle) : null;
}

/**
 * Parse free-text code-book labels ("IBC 2021", "IPMC 2018") into structured
 * ICC title + edition pairs. Non-ICC books (NEC, IFC, local UDC, …) are skipped.
 */
export function parseApplicableIccEditions(
  codeBooks: ReadonlyArray<string>,
): ApplicableIccEdition[] {
  const seen = new Set<string>();
  const editions: ApplicableIccEdition[] = [];

  for (const book of codeBooks) {
    const trimmed = book.trim();
    if (trimmed.length === 0) continue;

    const match = trimmed.match(/^([A-Za-z]+)(?:\s+(\d{4}))?/);
    if (!match) continue;

    const title = parseIccTitle(match[1]!);
    if (!title) continue;

    const edition = match[2] ?? "";
    const key = `${title}:${edition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    editions.push({ title, edition });
  }

  return editions;
}
