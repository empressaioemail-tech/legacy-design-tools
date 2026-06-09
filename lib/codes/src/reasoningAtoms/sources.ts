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

/** True when the persisted source URL set changed (edition-scoped calibration stamp). */
export function sourceSetChanged(
  before: ReadonlyArray<ReasoningSourceLink>,
  after: ReadonlyArray<ReasoningSourceLink>,
): boolean {
  const urlsBefore = [...before.map((s) => s.url)].sort();
  const urlsAfter = [...after.map((s) => s.url)].sort();
  if (urlsBefore.length !== urlsAfter.length) return true;
  return urlsBefore.some((u, i) => u !== urlsAfter[i]);
}
