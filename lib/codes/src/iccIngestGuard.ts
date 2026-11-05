/**
 * G-309: no writer may persist section text for an ICC-title atom.
 *
 * Every insert/update into `code_atoms` (body, body_html, embedding) and
 * `reasoning_atoms` (snippet, reasoning) runs its values through the guards
 * here before the write. An atom is ICC when `isIccRow` says so (source host,
 * jurisdiction key, source name, or ICC title identifier). The row is kept so
 * citations resolve; only the text-bearing fields are blanked. Same choice as
 * the read-side blanking in G-309 A16.
 */
import { isIccRow, isIccReasoningRow } from "./iccTitles";

export { isIccRow };

export interface IccGuardLogger {
  info: (obj: unknown, msg: string) => void;
}

export const ICC_TEXT_REFUSED_EVENT = "icc_text_refused_at_ingest";

/** Count-only event. Carries the write path and a count, never any text. */
export function logIccTextRefused(
  log: IccGuardLogger | undefined,
  source: string,
  count: number,
): void {
  if (!log || count <= 0) return;
  log.info({ event: ICC_TEXT_REFUSED_EVENT, source, count }, ICC_TEXT_REFUSED_EVENT);
}

export interface CodeAtomIdentity {
  sourceUrl?: string | null;
  jurisdictionKey?: string | null;
  sourceName?: string | null;
  codeBook?: string | null;
  sectionNumber?: string | null;
  codeSource?: string | null;
}

/** True when the code_atoms identity fields mark an ICC atom. */
export function isIccCodeAtom(identity: CodeAtomIdentity): boolean {
  return isIccRow(identity);
}

export interface CodeAtomTextFields {
  body: string;
  bodyHtml?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddedAt?: Date | null;
}

/**
 * code_atoms: for an ICC atom, blank body and drop body_html + embedding
 * (+ model, embedded_at). Citation fields on `row` pass through untouched.
 * Returns the row and whether it was blanked.
 */
export function guardCodeAtomText<T extends CodeAtomTextFields>(
  row: T,
  identity: CodeAtomIdentity,
): { row: T; refused: boolean } {
  if (!isIccCodeAtom(identity)) return { row, refused: false };
  return {
    row: {
      ...row,
      body: "",
      bodyHtml: null,
      embedding: null,
      embeddingModel: null,
      embeddedAt: null,
    },
    refused: true,
  };
}

export interface ReasoningAtomIdentity {
  /** The row's code-book field, e.g. "IBC 2021". */
  edition?: string | null;
  jurisdictionKey?: string | null;
  sources?: ReadonlyArray<{ url?: string | null; sourceName?: string | null }> | null;
}

/**
 * reasoning_atoms: for an ICC row (icc-title or icc-source-link, see
 * isIccReasoningRow) only `snippet` (verbatim fetched page text) is nulled.
 * `reasoning` is built from our own template or a fixed literal and carries no
 * source text, so it is left exactly as written. Callers pass the sources the
 * row will hold after the write.
 */
export function guardReasoningText<T extends { snippet?: string | null }>(
  values: T,
  identity: ReasoningAtomIdentity,
): { values: T; refused: boolean } {
  if (!isIccReasoningRow(identity)) return { values, refused: false };
  return { values: { ...values, snippet: null }, refused: true };
}
