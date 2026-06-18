import { REASONING_ATOM_PREFIX } from "./types";

/** Persisted reasoning atom id — distinct from corpus UUID and legacy websearch: prefix. */
export function reasoningAtomId(editionSlug: string, codeRef: string): string {
  const sec = codeRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${REASONING_ATOM_PREFIX}${editionSlug}:${sec}`;
}

/**
 * Per-jurisdiction reasoning atom id — suburbs get their own rows instead of
 * colliding with Austin's canonical edition-scoped ids (global PK).
 */
export function jurisdictionReasoningAtomId(
  jurisdictionKey: string,
  editionSlug: string,
  codeRef: string,
): string {
  if (jurisdictionKey === "austin_tx") {
    return reasoningAtomId(editionSlug, codeRef);
  }
  const sec = codeRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${REASONING_ATOM_PREFIX}${jurisdictionKey}:${editionSlug}:${sec}`;
}
