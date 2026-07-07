import type { AtomLinkLike } from "./invalidation.js";
import { computeSectionDependentsClosure } from "./invalidation.js";

export type CorpusSnapshotAtom = {
  entityType?: string;
  entityId?: string;
  jurisdictionTenant?: string;
  sectionNumber?: string;
  body?: string;
  sourceType?: string;
};

export type LoadedCorpusAtom = {
  atomId: string;
  entityId: string;
  jurisdictionTenant: string;
  sectionNumber: string;
  sectionFamily: string;
  atomClass: string;
  mu0: number;
  queryWeight: number;
  closureSize: number;
  closureEntityIds: readonly string[];
};

export type CorpusLinkIndex = {
  links: readonly AtomLinkLike[];
  closureSizeByEntityId: ReadonlyMap<string, number>;
  entityIdToAtomId: ReadonlyMap<string, string>;
  atomIdToEntityId: ReadonlyMap<string, string>;
};

/** Section-family key for Austin-style decimal sections (e.g. 25-2-974 → 25-2). */
export function sectionFamilyFromSectionNumber(section: string): string {
  const normalized = section.trim().replace(/\.$/, "");
  const parts = normalized.split(/[.\s-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return parts[0] ?? "unknown";
}

export function atomClassWithinJurisdiction(
  jurisdictionTenant: string,
  sectionFamily: string,
): string {
  return `${jurisdictionTenant}:${sectionFamily}`;
}

export function loadCorpusForJurisdiction(args: {
  snapshot: { atoms?: Record<string, CorpusSnapshotAtom>; links?: AtomLinkLike[] };
  jurisdictionTenant: string;
  queryWeights?: number[];
  queryWeightMode?: "uniform" | "available";
}): { atoms: LoadedCorpusAtom[]; linkIndex: CorpusLinkIndex } {
  const entries = Object.entries(args.snapshot.atoms ?? {}).filter(
    ([, v]) =>
      v?.entityType === "code-section" &&
      v.jurisdictionTenant === args.jurisdictionTenant &&
      typeof v.entityId === "string",
  );

  const entityIdToAtomId = new Map<string, string>();
  const atomIdToEntityId = new Map<string, string>();
  for (const [atomId, v] of entries) {
    entityIdToAtomId.set(v.entityId!, atomId);
    atomIdToEntityId.set(atomId, v.entityId!);
  }

  const jurisdictionEntityIds = new Set(
    entries.map(([, v]) => v.entityId!),
  );

  const secSecLinks = (args.snapshot.links ?? []).filter(
    (l) =>
      l.fromEntityType === "code-section" &&
      l.toEntityType === "code-section" &&
      (jurisdictionEntityIds.has(l.fromEntityId) ||
        jurisdictionEntityIds.has(l.toEntityId)),
  );

  const closureSizeByEntityId = new Map<string, number>();
  const closureEntityIdsByEntityId = new Map<string, readonly string[]>();

  for (const [, v] of entries) {
    const entityId = v.entityId!;
    const closure = computeSectionDependentsClosure([entityId], secSecLinks);
    closureSizeByEntityId.set(entityId, closure.length);
    closureEntityIdsByEntityId.set(entityId, closure);
  }

  const sparseWeights =
    args.queryWeights ??
    (args.queryWeightMode === "available"
      ? throwOnFabricatedWeights()
      : buildSparseQueryWeights(entries.length));

  const atoms: LoadedCorpusAtom[] = entries.map(([atomId, v], idx) => {
    const sectionNumber = v.sectionNumber ?? "";
    const sectionFamily = sectionFamilyFromSectionNumber(sectionNumber);
    const entityId = v.entityId!;
    return {
      atomId,
      entityId,
      jurisdictionTenant: args.jurisdictionTenant,
      sectionNumber,
      sectionFamily,
      atomClass: atomClassWithinJurisdiction(
        args.jurisdictionTenant,
        sectionFamily,
      ),
      mu0: assertedBaselineFromSourceType(v.sourceType ?? "municode"),
      queryWeight: sparseWeights[idx] ?? 1,
      closureSize: closureSizeByEntityId.get(entityId) ?? 1,
      closureEntityIds: closureEntityIdsByEntityId.get(entityId) ?? [entityId],
    };
  });

  return {
    atoms,
    linkIndex: {
      links: secSecLinks,
      closureSizeByEntityId,
      entityIdToAtomId,
      atomIdToEntityId,
    },
  };
}

function buildSparseQueryWeights(atomCount: number): number[] {
  const weights = new Array(atomCount).fill(0);
  const hotCount = Math.max(3, Math.floor(atomCount * 0.02));
  for (let i = 0; i < hotCount; i++) {
    weights[i * Math.floor(atomCount / hotCount)] = 1 + (i % 5);
  }
  return weights;
}

function throwOnFabricatedWeights(): never {
  throw new Error(
    'queryWeightMode="available" requires real queryWeights argument — ' +
      'F1 atom-grain attribution does not exist yet; fabricated weights are disabled per 05 spec honest-input rule.',
  );
}

const SOURCE_QUALITY_BASELINE: Record<string, number> = {
  pdf: 0.82,
  api: 0.78,
  html: 0.72,
  web: 0.55,
  municode: 0.78,
};

function assertedBaselineFromSourceType(sourceType: string): number {
  const key = sourceType.trim().toLowerCase();
  return SOURCE_QUALITY_BASELINE[key] ?? 0.65;
}
