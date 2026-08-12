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
import {
  type DerivedTriState,
  hasWriterBooleanForStorage,
  isIndeterminate,
  triStateToConfirmedBoolean,
} from "./schema/derivedTriState";

export type { DerivedTriState } from "./schema/derivedTriState";
export {
  isConfirmedFalse,
  isConfirmedTrue,
  isIndeterminate,
  triStateToConfirmedBoolean,
} from "./schema/derivedTriState";

export type FileExistsFn = (filePath: string) => boolean;

export interface DerivationProbeOptions {
  /** When explicitly `null`, snapshot lookup failed → atom-family derivation is indeterminate. */
  snapshot?: EnginePropertyTypesSnapshot | null;
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

function resolveSnapshot(
  options: DerivationProbeOptions,
): EnginePropertyTypesSnapshot | null {
  if (options.snapshot === null) return null;
  return options.snapshot ?? ENGINE_PROPERTY_TYPES_SNAPSHOT;
}

/**
 * Tri-state: is the atom family present in the engine/contract snapshot?
 * `false` = confirmed missing; `indeterminate` = snapshot lookup failed or engine root probe failed.
 */
export function deriveAtomFamilyPresent(
  railKey: string,
  snapshot: EnginePropertyTypesSnapshot | null = ENGINE_PROPERTY_TYPES_SNAPSHOT,
  binding: RailEngineBinding | undefined = bindingFor(railKey),
  contractSnapshot: ContractPropertyTypesSnapshot = CONTRACT_PROPERTY_TYPES_SNAPSHOT,
  engineRoot: string = resolveEngineRoot(),
  fileExists: FileExistsFn = existsSync,
  requireEngineRoot = true,
): DerivedTriState {
  if (snapshot === null) return "indeterminate";
  if (!binding) return false;
  if (binding.atomEntityTypes.length === 0) return false;

  const needsEngineRoot =
    requireEngineRoot && Boolean(binding.engineWriterScript);
  if (needsEngineRoot && !fileExists(engineRoot)) {
    return "indeterminate";
  }

  const registered = snapshotTypeSet(snapshot);
  const allInEngine = binding.atomEntityTypes.every((t) => registered.has(t));
  if (allInEngine) return true;

  if (binding.allowContractOnlyRegistration) {
    const contractRegistered = contractTypeSet(contractSnapshot);
    const allInContract = binding.atomEntityTypes.every((t) =>
      contractRegistered.has(t),
    );
    if (allInContract) return true;
  }

  return false;
}

/**
 * Fail closed: unregistered or unknown rail → `missing`.
 * All bound atom entity types must appear in the engine snapshot.
 */
export function deriveAtomFamilyState(
  railKey: string,
  snapshot: EnginePropertyTypesSnapshot | null = ENGINE_PROPERTY_TYPES_SNAPSHOT,
  binding: RailEngineBinding | undefined = bindingFor(railKey),
  contractSnapshot: ContractPropertyTypesSnapshot = CONTRACT_PROPERTY_TYPES_SNAPSHOT,
  engineRoot: string = resolveEngineRoot(),
  fileExists: FileExistsFn = existsSync,
  requireEngineRoot = true,
): AtomFamilyState {
  const present = deriveAtomFamilyPresent(
    railKey,
    snapshot,
    binding,
    contractSnapshot,
    engineRoot,
    fileExists,
    requireEngineRoot,
  );
  if (present === true) return "present";
  if (present === "indeterminate") return "partial";
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
 * Tri-state writer probe. `false` only when family absent or writer
 * confirmed absent; `indeterminate` when bound probe paths miss on disk.
 */
export function deriveHasWriter(
  railKey: string,
  snapshot: EnginePropertyTypesSnapshot | null = ENGINE_PROPERTY_TYPES_SNAPSHOT,
  binding: RailEngineBinding | undefined = bindingFor(railKey),
  engineRoot: string = resolveEngineRoot(),
  ldtRoot: string = resolveLdtRoot(),
  fileExists: FileExistsFn = existsSync,
  requireEngineRoot = true,
): DerivedTriState {
  const familyPresent = deriveAtomFamilyPresent(
    railKey,
    snapshot,
    binding,
    CONTRACT_PROPERTY_TYPES_SNAPSHOT,
    engineRoot,
    fileExists,
    requireEngineRoot,
  );
  if (familyPresent === false) return false;
  if (familyPresent === "indeterminate") return "indeterminate";
  if (!binding) return false;

  const hasBoundWriterProbe =
    Boolean(binding.engineWriterScript) || Boolean(binding.ldtScorerPath);
  if (!hasBoundWriterProbe) {
    return false;
  }

  const needsEngineProbe = Boolean(binding.engineWriterScript);
  if (needsEngineProbe && requireEngineRoot && !fileExists(engineRoot)) {
    return "indeterminate";
  }

  const { enginePath, ldtPath, engineProbePath, ldtProbePath } =
    writerPathsExist(binding, engineRoot, ldtRoot, fileExists);

  if (enginePath || ldtPath) return true;

  if (
    ldtProbePath &&
    !ldtPath &&
    ldtRoot !== MODULE_ANCHORED_LDT_ROOT
  ) {
    const canonicalPath = path.join(
      MODULE_ANCHORED_LDT_ROOT,
      "artifacts",
      "api-server",
      "src",
      binding.ldtScorerPath!,
    );
    if (fileExists(canonicalPath)) return "indeterminate";
  }

  if (needsEngineProbe && requireEngineRoot && !fileExists(engineRoot)) {
    return "indeterminate";
  }

  return false;
}

export interface DerivedRailFields {
  atomFamilyState: AtomFamilyState;
  atomFamilyPresent: DerivedTriState;
  /** Tri-state alias for atom family derivation (refresh CLI / tests). */
  atomFamilyStateDerivation: DerivedTriState;
  hasWriter: DerivedTriState;
  atomFamilyRef: string | null;
  writerRef: string | null;
  derivationReason: string;
}

export function deriveRailDeclarationFields(
  railKey: string,
  options: DerivationProbeOptions = {},
): DerivedRailFields {
  const snapshot = resolveSnapshot(options);
  const binding = bindingFor(railKey);
  const engineRoot = resolveEngineRoot(options.engineRoot);
  const ldtRoot = resolveLdtRoot(options.ldtRoot);
  const fileExists = options.fileExists ?? existsSync;
  const requireEngineRoot = options.requireEngineRoot ?? true;

  const atomFamilyPresent = deriveAtomFamilyPresent(
    railKey,
    snapshot,
    binding,
    options.contractSnapshot,
    engineRoot,
    fileExists,
    requireEngineRoot,
  );
  const atomFamilyState = deriveAtomFamilyState(
    railKey,
    snapshot,
    binding,
    options.contractSnapshot,
    engineRoot,
    fileExists,
    requireEngineRoot,
  );
  const hasWriter = deriveHasWriter(
    railKey,
    snapshot,
    binding,
    engineRoot,
    ldtRoot,
    fileExists,
    requireEngineRoot,
  );

  const probe =
    binding && atomFamilyPresent === true
      ? writerPathsExist(binding, engineRoot, ldtRoot, fileExists)
      : {
          enginePath: null,
          ldtPath: null,
          engineProbePath: null,
          ldtProbePath: null,
        };

  const reasons: string[] = [];
  if (!binding) {
    reasons.push("no binding");
  } else if (binding.atomEntityTypes.length === 0) {
    reasons.push("no atom entity types bound");
  } else if (snapshot === null) {
    reasons.push("engine snapshot lookup failed");
  } else if (atomFamilyPresent === "indeterminate") {
    reasons.push("atom family probe indeterminate (engine root or snapshot)");
  } else {
    const missingTypes = binding.atomEntityTypes.filter(
      (t) => !snapshotTypeSet(snapshot).has(t),
    );
    if (missingTypes.length > 0 && atomFamilyPresent === false) {
      reasons.push(`types not in engine snapshot: ${missingTypes.join(", ")}`);
    } else {
      reasons.push(`types in engine snapshot (${snapshot.engineMainSha})`);
    }
  }

  const hasBoundWriterProbe =
    Boolean(binding?.engineWriterScript) || Boolean(binding?.ldtScorerPath);

  if (atomFamilyPresent === true) {
    if (hasWriter === true) {
      reasons.push("writer/scorer file found on disk");
    } else if (!hasBoundWriterProbe) {
      reasons.push(
        binding?.noWriterReason ??
          "no writer/scorer bound for rail (confirmed absent)",
      );
    } else if (hasWriter === "indeterminate") {
      const missing: string[] = [];
      if (probe.engineProbePath && !probe.enginePath) {
        missing.push(`engine script missing at ${probe.engineProbePath}`);
      }
      if (probe.ldtProbePath && !probe.ldtPath) {
        missing.push(`ldt scorer missing at ${probe.ldtProbePath}`);
      }
      if (needsEngineRoot(requireEngineRoot, binding) && !fileExists(engineRoot)) {
        missing.push(`engine root missing at ${engineRoot}`);
      }
      reasons.push(
        missing.length > 0
          ? `writer probe indeterminate: ${missing.join("; ")}`
          : "writer probe indeterminate: bound paths not found",
      );
    } else {
      reasons.push("no writer/scorer bound for rail (confirmed absent)");
    }
  }

  const confirmedWriter = triStateToConfirmedBoolean(hasWriter);

  return {
    atomFamilyState,
    atomFamilyPresent,
    atomFamilyStateDerivation: atomFamilyPresent,
    hasWriter,
    atomFamilyRef:
      atomFamilyPresent === true ? (binding?.atomFamilyRefLabel ?? null) : null,
    writerRef: confirmedWriter === true ? (binding?.writerRefLabel ?? null) : null,
    derivationReason: reasons.join("; "),
  };
}

function needsEngineRoot(
  requireEngineRoot: boolean,
  binding: RailEngineBinding | undefined,
): boolean {
  return Boolean(requireEngineRoot && binding?.engineWriterScript);
}

/** Effective declaration with tri-state derivation fields exposed. */
export interface EffectiveCountyRailDeclaration extends CountyRailDeclaration {
  atomFamilyPresent: DerivedTriState;
  /** Tri-state alias used by refresh CLI logging. */
  atomFamilyStateDerivation: DerivedTriState;
  hasWriterDerivation: DerivedTriState;
  derivationReason: string;
}

export function isRailDerivationIndeterminate(
  decl: Pick<
    EffectiveCountyRailDeclaration,
    "hasWriterDerivation" | "atomFamilyPresent" | "atomFamilyStateDerivation"
  >,
): boolean {
  return (
    isIndeterminate(decl.hasWriterDerivation) ||
    isIndeterminate(decl.atomFamilyPresent) ||
    isIndeterminate(decl.atomFamilyStateDerivation)
  );
}

/** Merge static rail metadata with engine-derived atom/writer fields. */
export function buildEffectiveCountyRailDeclaration(
  options: DerivationProbeOptions = {},
): ReadonlyArray<EffectiveCountyRailDeclaration> {
  return COUNTY_RAIL_STATIC_DECLARATION.map((meta) => {
    const derived = deriveRailDeclarationFields(meta.railKey, options);
    return {
      ...meta,
      atomFamilyState: derived.atomFamilyState,
      atomFamilyRef: derived.atomFamilyRef,
      hasWriter: hasWriterBooleanForStorage(derived.hasWriter),
      writerRef: derived.writerRef,
      atomFamilyPresent: derived.atomFamilyPresent,
      atomFamilyStateDerivation: derived.atomFamilyPresent,
      hasWriterDerivation: derived.hasWriter,
      derivationReason: derived.derivationReason,
    };
  });
}

/** True when any rail has an indeterminate derived signal — refresh must fail closed. */
export function hasIndeterminateDerivations(
  declarations: ReadonlyArray<EffectiveCountyRailDeclaration>,
): boolean {
  return declarations.some(
    (d) =>
      isIndeterminate(d.hasWriterDerivation) ||
      isIndeterminate(d.atomFamilyPresent),
  );
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
