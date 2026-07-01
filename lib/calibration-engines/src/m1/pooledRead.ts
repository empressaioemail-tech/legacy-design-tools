/**
 * Hierarchical partial-pooling read (M1 amendment §3).
 *
 * Read per-atom where dense; pool up to citation-closure → section-family →
 * class-within-jurisdiction where sparse. Condition A: provenance carries
 * readGrain + signalSource so pooled-applied ≠ own-earned.
 */

import {
  MIN_DENSE_SIGNAL,
  N_STAR_FLOOR,
  PUBLIC_PARTITION,
  S0_DEFAULT,
  W_TARGET_RANKING,
} from "./constants.js";
import {
  aggregateCaseSignals,
  type CaseGrainSignal,
} from "./caseGrain.js";
import { betaCredibleIntervalWidth90, betaPriorFromAsserted } from "./betaPosterior.js";
import type { LoadedCorpusAtom } from "./corpusLoader.js";

export type ReadGrain =
  | "atom"
  | "citation-closure"
  | "section-family"
  | "class";

export type SignalSource = "own-earned" | "pooled-applied";

/** Condition A — grain/source descriptor on read-contract provenance. */
export type CalibrationReadProvenance = {
  fuelProvenance: "backtest" | "live" | "seed" | "asserted";
  readGrain: ReadGrain;
  signalSource: SignalSource;
  partition: typeof PUBLIC_PARTITION | `tenant:${string}`;
};

export type PooledReadResult = {
  atomId: string;
  provenance: CalibrationReadProvenance;
  n: number;
  k: number;
  mu0: number;
  ciWidth: number;
  earned: boolean;
  poolAtomIds: readonly string[];
};

function posteriorAtGrain(args: {
  cases: readonly CaseGrainSignal[];
  mu0: number;
}): { n: number; k: number; ciWidth: number } {
  const { n, k } = aggregateCaseSignals(args.cases);
  const { alpha0, beta0 } = betaPriorFromAsserted(args.mu0, S0_DEFAULT);
  const ciWidth = betaCredibleIntervalWidth90(alpha0 + k, beta0 + n - k);
  return { n, k, ciWidth };
}

function casesForAtom(
  atomId: string,
  partition: typeof PUBLIC_PARTITION,
  lineageBuckets: ReadonlyMap<string, CaseGrainSignal[]>,
): CaseGrainSignal[] {
  return lineageBuckets.get(`${partition}::${atomId}`) ?? [];
}

function casesForClosure(
  atom: LoadedCorpusAtom,
  partition: typeof PUBLIC_PARTITION,
  lineageBuckets: ReadonlyMap<string, CaseGrainSignal[]>,
  entityIdToAtomId: ReadonlyMap<string, string>,
): CaseGrainSignal[] {
  const seen = new Set<string>();
  const out: CaseGrainSignal[] = [];
  for (const entityId of atom.closureEntityIds) {
    const citedAtomId = entityIdToAtomId.get(entityId);
    if (!citedAtomId) continue;
    for (const c of casesForAtom(citedAtomId, partition, lineageBuckets)) {
      if (seen.has(c.caseId)) continue;
      seen.add(c.caseId);
      out.push(c);
    }
  }
  return out;
}

function casesForFamily(
  atom: LoadedCorpusAtom,
  allAtoms: readonly LoadedCorpusAtom[],
  partition: typeof PUBLIC_PARTITION,
  lineageBuckets: ReadonlyMap<string, CaseGrainSignal[]>,
): CaseGrainSignal[] {
  const familyAtomIds = allAtoms
    .filter(
      (a) =>
        a.jurisdictionTenant === atom.jurisdictionTenant &&
        a.sectionFamily === atom.sectionFamily,
    )
    .map((a) => a.atomId);
  const seen = new Set<string>();
  const out: CaseGrainSignal[] = [];
  for (const id of familyAtomIds) {
    for (const c of casesForAtom(id, partition, lineageBuckets)) {
      if (seen.has(c.caseId)) continue;
      seen.add(c.caseId);
      out.push(c);
    }
  }
  return out;
}

function casesForClass(
  atom: LoadedCorpusAtom,
  allAtoms: readonly LoadedCorpusAtom[],
  partition: typeof PUBLIC_PARTITION,
  lineageBuckets: ReadonlyMap<string, CaseGrainSignal[]>,
): CaseGrainSignal[] {
  const classAtomIds = allAtoms
    .filter((a) => a.atomClass === atom.atomClass)
    .map((a) => a.atomId);
  const seen = new Set<string>();
  const out: CaseGrainSignal[] = [];
  for (const id of classAtomIds) {
    for (const c of casesForAtom(id, partition, lineageBuckets)) {
      if (seen.has(c.caseId)) continue;
      seen.add(c.caseId);
      out.push(c);
    }
  }
  return out;
}

/**
 * Hierarchical read for one atom. Condition B: only PUBLIC_PARTITION signal
 * enters shared family pools; tenant-private never feeds public family numbers.
 */
export function readAtomAtSupportedGrain(args: {
  atom: LoadedCorpusAtom;
  allAtoms: readonly LoadedCorpusAtom[];
  lineageBuckets: ReadonlyMap<string, CaseGrainSignal[]>;
  entityIdToAtomId: ReadonlyMap<string, string>;
  partition?: typeof PUBLIC_PARTITION;
  wTarget?: number;
}): PooledReadResult {
  const partition = args.partition ?? PUBLIC_PARTITION;
  const wTarget = args.wTarget ?? W_TARGET_RANKING;
  const fuelProvenance =
    casesForAtom(args.atom.atomId, partition, args.lineageBuckets)[0]
      ?.fuelProvenance ?? "asserted";

  const atomCases = casesForAtom(
    args.atom.atomId,
    partition,
    args.lineageBuckets,
  );
  const atomPosterior = posteriorAtGrain({
    cases: atomCases,
    mu0: args.atom.mu0,
  });

  if (atomPosterior.n >= MIN_DENSE_SIGNAL) {
    return {
      atomId: args.atom.atomId,
      provenance: {
        fuelProvenance,
        readGrain: "atom",
        signalSource: "own-earned",
        partition,
      },
      n: atomPosterior.n,
      k: atomPosterior.k,
      mu0: args.atom.mu0,
      ciWidth: atomPosterior.ciWidth,
      earned:
        atomPosterior.n >= N_STAR_FLOOR && atomPosterior.ciWidth < wTarget,
      poolAtomIds: [args.atom.atomId],
    };
  }

  const closureCases = casesForClosure(
    args.atom,
    partition,
    args.lineageBuckets,
    args.entityIdToAtomId,
  );
  const closurePosterior = posteriorAtGrain({
    cases: closureCases,
    mu0: args.atom.mu0,
  });
  if (closurePosterior.n >= MIN_DENSE_SIGNAL) {
    return {
      atomId: args.atom.atomId,
      provenance: {
        fuelProvenance,
        readGrain: "citation-closure",
        signalSource: "pooled-applied",
        partition,
      },
      n: closurePosterior.n,
      k: closurePosterior.k,
      mu0: args.atom.mu0,
      ciWidth: closurePosterior.ciWidth,
      earned:
        closurePosterior.n >= N_STAR_FLOOR &&
        closurePosterior.ciWidth < wTarget,
      poolAtomIds: args.atom.closureEntityIds
        .map((e) => args.entityIdToAtomId.get(e))
        .filter((id): id is string => !!id),
    };
  }

  const familyCases = casesForFamily(
    args.atom,
    args.allAtoms,
    partition,
    args.lineageBuckets,
  );
  const familyPosterior = posteriorAtGrain({
    cases: familyCases,
    mu0: args.atom.mu0,
  });
  if (familyPosterior.n >= MIN_DENSE_SIGNAL) {
    return {
      atomId: args.atom.atomId,
      provenance: {
        fuelProvenance,
        readGrain: "section-family",
        signalSource: "pooled-applied",
        partition,
      },
      n: familyPosterior.n,
      k: familyPosterior.k,
      mu0: args.atom.mu0,
      ciWidth: familyPosterior.ciWidth,
      earned:
        familyPosterior.n >= N_STAR_FLOOR && familyPosterior.ciWidth < wTarget,
      poolAtomIds: args.allAtoms
        .filter((a) => a.sectionFamily === args.atom.sectionFamily)
        .map((a) => a.atomId),
    };
  }

  const classCases = casesForClass(
    args.atom,
    args.allAtoms,
    partition,
    args.lineageBuckets,
  );
  const classPosterior = posteriorAtGrain({
    cases: classCases,
    mu0: args.atom.mu0,
  });

  return {
    atomId: args.atom.atomId,
    provenance: {
      fuelProvenance,
      readGrain: "class",
      signalSource: "pooled-applied",
      partition,
    },
    n: classPosterior.n,
    k: classPosterior.k,
    mu0: args.atom.mu0,
    ciWidth: classPosterior.ciWidth,
    earned:
      classPosterior.n >= N_STAR_FLOOR && classPosterior.ciWidth < wTarget,
    poolAtomIds: args.allAtoms
      .filter((a) => a.atomClass === args.atom.atomClass)
      .map((a) => a.atomId),
  };
}

export function readAllAtomsAtSupportedGrain(args: {
  atoms: readonly LoadedCorpusAtom[];
  lineageBuckets: ReadonlyMap<string, CaseGrainSignal[]>;
  entityIdToAtomId: ReadonlyMap<string, string>;
  wTarget?: number;
}): PooledReadResult[] {
  return args.atoms.map((atom) =>
    readAtomAtSupportedGrain({
      atom,
      allAtoms: args.atoms,
      lineageBuckets: args.lineageBuckets,
      entityIdToAtomId: args.entityIdToAtomId,
      wTarget: args.wTarget,
    }),
  );
}
