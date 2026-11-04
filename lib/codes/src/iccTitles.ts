/**
 * G-309 (Exhibit D): which code identifiers are ICC model-code titles.
 *
 * ICC content is obtained only through Code Connect. Anything that is an ICC
 * title (by book identifier, whatever its source or mirror) is kept out of
 * prompts and web fetches. A county's own amendments cannot be reliably told
 * apart from quoted ICC text, so the whole ICC-title atom is excluded.
 */

/** Leading alphabetic token of an ICC-published title (upper-case). */
const ICC_TITLE_TOKENS = new Set([
  "IBC", "IRC", "IFC", "IPMC", "IECC", "IPC", "IMC", "IFGC", "IEBC",
  "ISPSC", "IGCC", "IWUIC", "IZC", "IPSDC", "ICCPC", "ICC", "IFGS",
]);

/** True when a code/book/section identifier names an ICC model-code title. */
export function isIccTitleIdentifier(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (lower === "icc-model-code" || lower.startsWith("icc-model-code/")) return true;
  if (/^international\b.*\bcode\b/i.test(v)) return true;
  const token = v.toUpperCase().match(/^[A-Z]+/)?.[0];
  return token !== undefined && ICC_TITLE_TOKENS.has(token);
}

/** True when any of the atom's identifying fields is an ICC title. */
export function isIccTitleAtom(a: {
  codeBook?: string | null;
  sectionNumber?: string | null;
  jurisdictionKey?: string | null;
  codeSource?: string | null;
}): boolean {
  return (
    a.codeSource === "icc-model-code" ||
    isIccTitleIdentifier(a.codeBook) ||
    isIccTitleIdentifier(a.sectionNumber) ||
    isIccTitleIdentifier(a.jurisdictionKey)
  );
}
