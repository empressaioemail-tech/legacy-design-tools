import type { ReasoningSourceLink } from "./types";

/** Merge a new source link into sources[] without duplicating URLs (multi-link UPSERT). */
export function mergeReasoningSources(
  existing: ReadonlyArray<ReasoningSourceLink>,
  incoming: ReasoningSourceLink,
): ReasoningSourceLink[] {
  if (existing.some((s) => s.url === incoming.url)) {
    return existing.map((s) =>
      s.url === incoming.url ? { ...s, ...incoming } : s,
    );
  }
  return [...existing, incoming];
}
