/**
 * Fail-closed reconciliation gate: does any cell claim a state that
 * contradicts the data behind it? Runs after every county-rail refresh.
 */
import { COVERAGE_CLASS_BY_RAIL_KEY, COUNTY_RAIL_COUNT } from "./schema/countyRailDimension";
import { TEXAS_COUNTY_COUNT } from "./railCoverageCapability";
import {
  ENGINE_PROPERTY_TYPES_SNAPSHOT,
  snapshotTypeSet,
} from "./schema/enginePropertyTypesSnapshot";
import {
  RAIL_ENGINE_BINDING_BY_KEY,
  type RailEngineBinding,
} from "./schema/railEngineBinding";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveEngineRoot,
  resolveLdtRoot,
} from "./railManifestDerivation";

export interface ReconciliationAssertionFailure {
  assertion: string;
  detail: string;
}

/** Minimal manifest cell shape for reconciliation (mirrors countyLedger ManifestCell). */
export interface ReconciliationManifestCell {
  countyFips: string;
  railKey: string;
  displayState: string;
  isPartial: boolean;
  honestCoveragePct: number | null;
  thresholdPct: number | null;
  hasWriter: boolean;
  verifiedByInstrument: string | null;
}

export interface ReconciliationGateInput {
  cells: ReconciliationManifestCell[];
  totalCounties: number;
  totalRails?: number;
  /** Live county_rail rows keyed by railKey — has_writer from DB. */
  railHasWriterByKey: ReadonlyMap<string, boolean>;
}

export interface ReconciliationGateOptions {
  engineRoot?: string;
  ldtRoot?: string;
  fileExists?: (p: string) => boolean;
}

const ASSERTION_COVERAGE_WITHOUT_WRITER =
  "coverage_without_writer: honestCoveragePct > 0 AND hasWriter false";
const ASSERTION_VERIFIED_NO_WRITER =
  "verified_no_writer: verifiedByInstrument set AND displayState no-writer";
const ASSERTION_RAIL_WRITER_EXISTS_BUT_FALSE =
  "rail_writer_exists_but_false: atom types in engine snapshot AND writer script on disk AND hasWriter false";
const ASSERTION_CELL_COUNT_MISMATCH =
  "cell_count_mismatch: totalCells !== totalCounties * totalRails";
const ASSERTION_DEPTH_SATISFIED_BELOW_THRESHOLD =
  "depth_satisfied_below_threshold: jurisdiction-depth rail satisfied-present below threshold";

function writerScriptExistsOnDisk(
  binding: RailEngineBinding,
  engineRoot: string,
  ldtRoot: string,
  fileExists: (p: string) => boolean,
): boolean {
  if (binding.engineWriterScript) {
    const p = path.join(
      engineRoot,
      "packages",
      "engine-core",
      "scripts",
      binding.engineWriterScript,
    );
    if (fileExists(p)) return true;
  }
  if (binding.ldtScorerPath) {
    const p = path.join(
      ldtRoot,
      "artifacts",
      "api-server",
      "src",
      binding.ldtScorerPath,
    );
    if (fileExists(p)) return true;
  }
  return false;
}

function railShouldHaveWriter(
  railKey: string,
  options: ReconciliationGateOptions,
): boolean {
  const binding = RAIL_ENGINE_BINDING_BY_KEY[railKey];
  if (!binding || binding.atomEntityTypes.length === 0) return false;
  const registered = snapshotTypeSet(ENGINE_PROPERTY_TYPES_SNAPSHOT);
  if (!binding.atomEntityTypes.every((t) => registered.has(t))) return false;
  const engineRoot = resolveEngineRoot(options.engineRoot);
  const ldtRoot = resolveLdtRoot(options.ldtRoot);
  const fileExists = options.fileExists ?? existsSync;
  return writerScriptExistsOnDisk(binding, engineRoot, ldtRoot, fileExists);
}

/** Pure gate — returns failures; empty array means pass. */
export function runManifestReconciliationGate(
  input: ReconciliationGateInput,
  options: ReconciliationGateOptions = {},
): ReconciliationAssertionFailure[] {
  const failures: ReconciliationAssertionFailure[] = [];
  const totalRails = input.totalRails ?? COUNTY_RAIL_COUNT;

  if (input.cells.length !== input.totalCounties * totalRails) {
    failures.push({
      assertion: ASSERTION_CELL_COUNT_MISMATCH,
      detail: `cells=${input.cells.length} expected=${input.totalCounties * totalRails} (counties=${input.totalCounties} rails=${totalRails})`,
    });
  }

  for (const cell of input.cells) {
    if (
      cell.honestCoveragePct !== null &&
      cell.honestCoveragePct > 0 &&
      cell.hasWriter === false
    ) {
      failures.push({
        assertion: ASSERTION_COVERAGE_WITHOUT_WRITER,
        detail: `${cell.countyFips}/${cell.railKey}: coverage=${cell.honestCoveragePct}% hasWriter=false display=${cell.displayState}`,
      });
    }

    if (
      cell.verifiedByInstrument &&
      cell.displayState === "no-writer"
    ) {
      failures.push({
        assertion: ASSERTION_VERIFIED_NO_WRITER,
        detail: `${cell.countyFips}/${cell.railKey}: instrument=${cell.verifiedByInstrument}`,
      });
    }

    if (COVERAGE_CLASS_BY_RAIL_KEY[cell.railKey] === "jurisdiction-depth") {
      if (
        cell.displayState === "satisfied-present" &&
        !cell.isPartial &&
        cell.honestCoveragePct !== null &&
        cell.thresholdPct !== null &&
        cell.honestCoveragePct < cell.thresholdPct
      ) {
        failures.push({
          assertion: ASSERTION_DEPTH_SATISFIED_BELOW_THRESHOLD,
          detail: `${cell.countyFips}/${cell.railKey}: coverage=${cell.honestCoveragePct}% threshold=${cell.thresholdPct}%`,
        });
      }
    }
  }

  for (const [railKey, hasWriter] of input.railHasWriterByKey) {
    if (hasWriter) continue;
    if (railShouldHaveWriter(railKey, options)) {
      failures.push({
        assertion: ASSERTION_RAIL_WRITER_EXISTS_BUT_FALSE,
        detail: `rail ${railKey}: engine types registered and writer/scorer on disk but county_rail.has_writer=false`,
      });
    }
  }

  return failures;
}

export class ManifestReconciliationError extends Error {
  constructor(public readonly failures: ReconciliationAssertionFailure[]) {
    super(
      `manifest reconciliation gate failed (${failures.length} assertion(s)): ${failures.map((f) => f.assertion).join(", ")}`,
    );
    this.name = "ManifestReconciliationError";
  }
}

/** Fail closed — throws when any assertion fails. */
export function assertManifestReconciliation(
  input: ReconciliationGateInput,
  options: ReconciliationGateOptions = {},
): void {
  const failures = runManifestReconciliationGate(input, options);
  if (failures.length > 0) {
    throw new ManifestReconciliationError(failures);
  }
}

export const RECONCILIATION_ASSERTIONS = [
  ASSERTION_COVERAGE_WITHOUT_WRITER,
  ASSERTION_VERIFIED_NO_WRITER,
  ASSERTION_RAIL_WRITER_EXISTS_BUT_FALSE,
  ASSERTION_CELL_COUNT_MISMATCH,
  ASSERTION_DEPTH_SATISFIED_BELOW_THRESHOLD,
] as const;

/** Default Texas county count when manifest row count unavailable. */
export { TEXAS_COUNTY_COUNT };
