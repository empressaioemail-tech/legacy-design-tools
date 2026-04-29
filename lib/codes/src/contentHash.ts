/**
 * Stable content-hash for an atom. Used as the dedupe key on
 * code_atoms.content_hash so re-running a warmup pass doesn't insert
 * duplicates of unchanged sections.
 *
 * Joiner is U+0001 (start-of-heading control char) — vanishingly unlikely to
 * appear in code text, so the field separator is unambiguous.
 */

import { createHash } from "node:crypto";

export const CONTENT_HASH_JOINER = "\u0001";

export function contentHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join(CONTENT_HASH_JOINER))
    .digest("hex");
}
