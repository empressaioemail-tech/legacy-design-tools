import { REASONING_ATOM_PREFIX } from "./types";

/** Persisted reasoning atom id — distinct from corpus UUID and legacy websearch: prefix. */
export function reasoningAtomId(editionSlug: string, codeRef: string): string {
  const sec = codeRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${REASONING_ATOM_PREFIX}${editionSlug}:${sec}`;
}
