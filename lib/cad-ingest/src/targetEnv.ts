/**
 * Staging/production target selection for cad-ingest writes (P-169).
 *
 * Mirrors hauska-factory's `src/lib/publish-target-env.mjs`: a target reads
 * only its own variable, and a missing variable for the selected target
 * refuses TARGET_ENV_MISSING naming the variable (never its value, never a
 * `??` fallback across targets). STAGING_NEONDB_URL / PRODUCTION_NEONDB_URL
 * already exist as `hauska-prod-497015` secrets and already point at the
 * cortex/LDT database that holds `cad_property` — no new secret is needed.
 *
 * Executes: cli.ts before opening its write Pool, whenever `--target` is
 * required (any run that is not `--dry-run`).
 * Triggers: every non-dry-run cad-ingest invocation.
 * Fails: throw TARGET_ENV_MISSING (err.missing = [varName]) or TARGET_UNKNOWN.
 */

export const TARGET_ENV_MISSING = "TARGET_ENV_MISSING";
export const TARGET_UNKNOWN = "TARGET_UNKNOWN";

export const CAD_INGEST_TARGETS = Object.freeze(["staging", "production"] as const);
export type CadIngestTarget = (typeof CAD_INGEST_TARGETS)[number];

const TARGET_VARS: Record<CadIngestTarget, string> = Object.freeze({
  staging: "STAGING_NEONDB_URL",
  production: "PRODUCTION_NEONDB_URL",
});

export interface TargetEnvError extends Error {
  code: string;
  target?: string;
  missing?: string[];
}

export function isKnownTarget(value: string): value is CadIngestTarget {
  return (CAD_INGEST_TARGETS as readonly string[]).includes(value);
}

export function assertKnownTarget(target: string): asserts target is CadIngestTarget {
  if (!isKnownTarget(target)) {
    const err = new Error(`unknown cad-ingest target: ${target}`) as TargetEnvError;
    err.code = TARGET_UNKNOWN;
    throw err;
  }
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
}

/** The write-target database URL for `target`, or TARGET_ENV_MISSING before any write. */
export function resolveTargetDatabaseUrl(
  env: NodeJS.ProcessEnv,
  target: string,
): string {
  assertKnownTarget(target);
  const varName = TARGET_VARS[target];
  if (!present(env, varName)) {
    const err = new Error(`target ${target} is missing ${varName}`) as TargetEnvError;
    err.code = TARGET_ENV_MISSING;
    err.target = target;
    err.missing = [varName];
    throw err;
  }
  return env[varName] as string;
}
