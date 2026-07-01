/**
 * Source-trust precedence taxonomy (cc-agent-C2 / ADR-017 data-source ordering).
 *
 * When two authoritative sources disagree on the same (subject, claim_type,
 * valid_interval), higher trustRank wins automatic resolution. Equal or
 * incomparable ranks leave the conflict unresolved.
 */

import {
  lookupRegisteredSource,
  type RegisteredKnowledgeSource,
} from "./sourceRegistry.js";

export type PrecedenceComparison =
  | { ordered: true; winner: RegisteredKnowledgeSource; loser: RegisteredKnowledgeSource }
  | { ordered: false; reason: "unknown_source" | "equal_rank" };

export function compareSourcePrecedence(
  sourceKeyA: string,
  sourceKeyB: string,
): PrecedenceComparison {
  if (sourceKeyA === sourceKeyB) {
    return { ordered: false, reason: "equal_rank" };
  }
  const a = lookupRegisteredSource(sourceKeyA);
  const b = lookupRegisteredSource(sourceKeyB);
  if (!a || !b) {
    return { ordered: false, reason: "unknown_source" };
  }
  if (a.trustRank === b.trustRank) {
    return { ordered: false, reason: "equal_rank" };
  }
  if (a.trustRank > b.trustRank) {
    return { ordered: true, winner: a, loser: b };
  }
  return { ordered: true, winner: b, loser: a };
}

/** Pick highest-ranked candidate; null when no strict ordering exists. */
export function highestRankedCandidate<T extends { sourceKey: string }>(
  candidates: ReadonlyArray<T>,
): T | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const next = candidates[i]!;
    const cmp = compareSourcePrecedence(best.sourceKey, next.sourceKey);
    if (cmp.ordered && cmp.winner.sourceKey === next.sourceKey) {
      best = next;
    }
  }
  const runnerUp = candidates.find((c) => c.sourceKey !== best.sourceKey);
  if (!runnerUp) return best;
  const cmp = compareSourcePrecedence(best.sourceKey, runnerUp.sourceKey);
  return cmp.ordered ? best : null;
}

export function strictestAccessPolicy(
  policies: ReadonlyArray<string>,
): string {
  const rank: Record<string, number> = {
    "tenant-private": 5,
    "tenant-shared": 4,
    "platform-internal": 3,
    "public-paid": 2,
    "public-free": 1,
  };
  let best = policies[0] ?? "tenant-private";
  let bestScore = rank[best] ?? 5;
  for (const p of policies.slice(1)) {
    const score = rank[p] ?? 5;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}
