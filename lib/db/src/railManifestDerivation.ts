import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_PROPERTY_TYPES_SNAPSHOT,
  contractTypeSet,
  type ContractPropertyTypesSnapshot,
} from "./schema/contractPropertyTypesSnapshot";
import {
  ENGINE_PROPERTY_TYPES_SNAPSHOT,
  snapshotTypeSet,
  type EnginePropertyTypesSnapshot,
} from "./schema/enginePropertyTypesSnapshot";
import {
  RAIL_ENGINE_BINDING_BY_KEY,
  type RailEngineBinding,
} from "./schema/railEngineBinding";
import {
  COUNTY_RAIL_STATIC_DECLARATION,
} from "./schema/countyRailStatic";
import {
  type AtomFamilyState,
  type CountyRailDeclaration,
} from "./schema/countyRailDimension";

export type FileExistsFn = (filePath: string) => boolean;

export interface DerivationProbeOptions {
  snapshot?: EnginePropertyTypesSnapshot;
  contractSnapshot?: ContractPropertyTypesSnapshot;
  engineRoot?: string;
  ldtRoot?: string;
  fileExists?: FileExistsFn;
  /** When true, fail closed if engineRoot path is missing on disk. Default true. */
  requireEngineRoot?: boolean;
}

/** Walk up from this module until the LDT repo marker file is found. */
function findLdtRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const marker = path.join(
      dir,
      "artifacts",
      "api-server",
      "src",
      "countyGeometryScoreCli.ts",
    );
    if (existsSync(marker)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(dir, "..", "..", "..");
}

const MODULE_ANCHORED_LDT_ROOT = findLdtRepoRoot();

const MODULE_ANCHORED_ENGINE_ROOT = path.resolve(
  MODULE_ANCHORED_LDT_ROOT,
  "..",
  "hauska-engine",
);

export function resolveEngineRoot(override?: string): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env.HAUSKA_ENGINE_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return MODULE_ANCHORED_ENGINE_ROOT;
}

export function resolveLdtRoot(override?: string): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env.LEGACY_DESIGN_TOOLS_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return MODULE_ANCHORED_LDT_ROOT;
}

function bindingFor(railKey: string): RailEngineBinding | undefined {
  return RAIL_ENGINE_BINDING_BY_KEY[railKey];
}

/**
 * Fail closed: unregistered or unknown rail → `missing`.
 * All bound atom entity types must appear in the engine snapshot.
 */
export function deriveAtomFamilyState(
  railKey: string,
  snapshot: EnginePropertyTypesSnapshot = ENGINE_PROPERTY_TYPES_SNAPSHOT,
  binding: RailEngineBinding | undefined = bindingFor(railKey),
  contractSnapshot: ContractPropertyTypesSnapshot = CONTRACT_PROPERTY_TYPES_SNAPSHOT,
): AtomFamilyState {
  if (!binding) return "missing";
  if (binding.atomEntityTypes.length === 0) return "missing";
  const registered = snapshotTypeSet(snapshot);
  const allInEngine = binding.atomEntityTypes.every((t) => registered.has(t));
  if (allInEngine) return "present";
  if (binding.allowContractOnlyRegistration) {
    const contractRegistered = contractTypeSet(contractSnapshot);
    const allInContract = binding.atomEntityTypes.every((t) =>
      contractRegistered.has(t),
    );
    if (allInContract) return "present";
  }
  return "missing";
}

function writerPathsExist(
  binding: RailEngineBinding,
  engineRoot: string,
  ldtRoot: string,
  fileExists: FileExistsFn,
): {
  enginePath: string | null;
  ldtPath: string | null;
  engineProbePath: string | null;
  ldtProbePath: string | null;
} {
  let enginePath: string | null = null;
  let ldtPath: string | null = null;
  let engineProbePath: string | null = null;
  let ldtProbePath: string | null = null;
  if (binding.engineWriterScript) {
    engineProbePath = path.join(
      engineRoot,
      "packages",
      "engine-core",
      "scripts",
      binding.engineWriterScript,
    );
    if (fileExists(engineProbePath)) enginePath = engineProbePath;
  }
  if (binding.ldtScorerPath) {
    ldtProbePath = path.join(
      ldtRoot,
      "artifacts",
      "api-server",
      "src",
      binding.ldtScorerPath,
    );
    if (fileExists(ldtProbePath)) ldtPath = ldtProbePath;
  }
  return { enginePath, ldtPath, engineProbePath, ldtProbePath };
}

/**
 * True ONLY when atom family is `present` AND at least one writer/scorer
 * file exists on disk. Fail closed when engine root is required but missing.
 */
export function deriveHasWriter(
  railKey: string,
  snapshot: EnginePropertyTypesSnapshot = ENGINE_PROPERTY_TYPES_SNAPSHOT,
  binding: RailEngineBinding | undefined = bindingFor(railKey),
  engineRoot: string = resolveEngineRoot(),
  ldtRoot: string = resolveLdtRoot(),
  fileExists: FileExistsFn = existsSync,
  requireEngineRoot = true,
): boolean {
  if (deriveAtomFamilyState(railKey, snapshot, binding) !== "present") {
    return false;
  }
  if (!binding) return false;

  const needsEngineProbe = Boolean(binding.engineWriterScript);
  if (needsEngineProbe && requireEngineRoot && !fileExists(engineRoot)) {
    return false;
  }

  const { enginePath, ldtPath } = writerPathsExist(
    binding,
    engineRoot,
    ldtRoot,
    fileExists,
  );
  return Boolean(enginePath || ldtPath);
}

export interface DerivedRailFields {
  atomFamilyState: AtomFamilyState;
  hasWriter: boolean;
  atomFamilyRef: string | null;
  writerRef: string | null;
  derivationReason: string;
}

export function deriveRailDeclarationFields(
  railKey: string,
  options: DerivationProbeOptions = {},
): DerivedRailFields {
  const snapshot = options.snapshot ?? ENGINE_PROPERTY_TYPES_SNAPSHOT;
  const binding = bindingFor(railKey);
  const engineRoot = resolveEngineRoot(options.engineRoot);
  const ldtRoot = resolveLdtRoot(options.ldtRoot);
  const fileExists = options.fileExists ?? existsSync;
  const requireEngineRoot = options.requireEngineRoot ?? true;

  const atomFamilyState = deriveAtomFamilyState(railKey, snapshot, binding);
  const needsEngineProbe = Boolean(binding?.engineWriterScript);

  const probe =
    binding && atomFamilyState === "present"
      ? writerPathsExist(binding, engineRoot, ldtRoot, fileExists)
      : {
          enginePath: null,
          ldtPath: null,
          engineProbePath: null,
          ldtProbePath: null,
        };

  const hasWriter =
    atomFamilyState === "present" &&
    Boolean(binding) &&
    Boolean(probe.enginePath || probe.ldtPath) &&
    !(needsEngineProbe && requireEngineRoot && !fileExists(engineRoot));

  const reasons: string[] = [];
  if (!binding) {
    reasons.push("no binding");
  } else if (binding.atomEntityTypes.length === 0) {
    reasons.push("no atom entity types bound");
  } else {
    const missingTypes = binding.atomEntityTypes.filter(
      (t) => !snapshotTypeSet(snapshot).has(t),
    );
    if (missingTypes.length > 0) {
      reasons.push(`types not in engine snapshot: ${missingTypes.join(", ")}`);
    } else {
      reasons.push(`types in engine snapshot (${snapshot.engineMainSha})`);
    }
  }

  const hasBoundWriterProbe =
    Boolean(binding?.engineWriterScript) || Boolean(binding?.ldtScorerPath);

  if (atomFamilyState === "present") {
    if (hasWriter) {
      reasons.push("writer/scorer file found on disk");
    } else if (!hasBoundWriterProbe) {
      reasons.push("no writer/scorer bound for rail (confirmed absent)");
    } else {
      const missing: string[] = [];
      if (probe.engineProbePath && !probe.enginePath) {
        missing.push(`engine script missing at ${probe.engineProbePath}`);
      }
      if (probe.ldtProbePath && !probe.ldtPath) {
        missing.push(`ldt scorer missing at ${probe.ldtProbePath}`);
      }
      if (needsEngineProbe && requireEngineRoot && !fileExists(engineRoot)) {
        missing.push(`engine root missing at ${engineRoot}`);
      }
      reasons.push(
        missing.length > 0
          ? `writer probe failed: ${missing.join("; ")}`
          : "writer probe failed: bound paths not found",
      );
    }
  }

  return {
    atomFamilyState,
    hasWriter,
    atomFamilyRef:
      atomFamilyState === "present" ? (binding?.atomFamilyRefLabel ?? null) : null,
    writerRef: hasWriter ? (binding?.writerRefLabel ?? null) : null,
    derivationReason: reasons.join("; "),
  };
}

/** Merge static rail metadata with engine-derived atom/writer fields. */
export function buildEffectiveCountyRailDeclaration(
  options: DerivationProbeOptions = {},
): ReadonlyArray<CountyRailDeclaration> {
  return COUNTY_RAIL_STATIC_DECLARATION.map((meta) => {
    const derived = deriveRailDeclarationFields(meta.railKey, options);
    return {
      ...meta,
      atomFamilyState: derived.atomFamilyState,
      atomFamilyRef: derived.atomFamilyRef,
      hasWriter: derived.hasWriter,
      writerRef: derived.writerRef,
    };
  });
}

/** CP1 self-check: expected manifest cell moves when derived declaration replaces stale hand-edited values. */
export function computeCp1CellMoveExpectations(
  beforeByKey: Readonly<Record<string, { atomFamilyState: AtomFamilyState; hasWriter: boolean }>>,
  afterDeclarations: ReadonlyArray<CountyRailDeclaration>,
  countyCount = 254,
): {
  cellsMovedOutOfNoAtom: number;
  cellsMovedOutOfNoWriter: number;
} {
  const displayState = (
    atomFamilyState: AtomFamilyState,
    hasWriter: boolean,
  ): "no-atom" | "no-writer" | "not-yet" => {
    if (atomFamilyState !== "present") return "no-atom";
    if (!hasWriter) return "no-writer";
    return "not-yet";
  };

  let cellsMovedOutOfNoAtom = 0;
  let cellsMovedOutOfNoWriter = 0;

  for (const after of afterDeclarations) {
    const before = beforeByKey[after.railKey];
    if (!before) continue;
    const beforeDisplay = displayState(before.atomFamilyState, before.hasWriter);
    const afterDisplay = displayState(after.atomFamilyState, after.hasWriter);
    if (beforeDisplay === "no-atom" && afterDisplay !== "no-atom") {
      cellsMovedOutOfNoAtom += countyCount;
    }
    if (beforeDisplay === "no-writer" && afterDisplay === "not-yet") {
      cellsMovedOutOfNoWriter += countyCount;
    }
  }

  return { cellsMovedOutOfNoAtom, cellsMovedOutOfNoWriter };
}
