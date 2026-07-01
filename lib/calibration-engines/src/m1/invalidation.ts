/**
 * F7 invalidation granularity — closure + effective hazard scaling for M1.
 * Ported from hauska-engine sectionInvalidation.ts (closure logic only).
 */

export type InvalidationGranularity =
  | "whole-edition"
  | "section-scoped"
  | "section-plus-dependents";

export type AtomLinkLike = {
  fromEntityType: string;
  fromEntityId: string;
  toEntityType: string;
  toEntityId: string;
  linkType: string;
};

const DEPENDENCY_LINK_TYPES = new Set([
  "cites",
  "see-also",
  "subject-to",
  "as-defined-in",
  "amends",
]);

export function computeSectionDependentsClosure(
  seedSectionEntityIds: readonly string[],
  links: readonly AtomLinkLike[],
): readonly string[] {
  const closure = new Set(seedSectionEntityIds);
  let expanded = true;

  while (expanded) {
    expanded = false;
    for (const link of links) {
      if (link.toEntityType !== "code-section") continue;
      if (!closure.has(link.toEntityId)) continue;
      if (link.fromEntityType !== "code-section") continue;
      if (!DEPENDENCY_LINK_TYPES.has(link.linkType)) continue;
      if (!closure.has(link.fromEntityId)) {
        closure.add(link.fromEntityId);
        expanded = true;
      }
    }
  }

  return [...closure];
}

export function closureSizeForAtom(
  atomId: string,
  links: readonly AtomLinkLike[],
): number {
  const closure = computeSectionDependentsClosure([atomId], links);
  return closure.length;
}

/**
 * Effective hazard λ_eff for earn test a/λ >= n*.
 * More granular invalidation → lower λ_eff → easier to earn.
 */
export function effectiveLambda(args: {
  baseLambda: number;
  granularity: InvalidationGranularity;
  editionAtomCount: number;
  closureSize?: number;
}): number {
  const { baseLambda, granularity, editionAtomCount, closureSize = 1 } = args;

  switch (granularity) {
    case "section-scoped":
      return baseLambda;
    case "section-plus-dependents":
      return baseLambda * Math.max(1, closureSize);
    case "whole-edition":
      return baseLambda * Math.max(1, editionAtomCount);
    default:
      return baseLambda;
  }
}
