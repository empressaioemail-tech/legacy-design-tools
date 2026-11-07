/**
 * Blast-radius refusal for repair/patch writers (gate 4 / P4, audit
 * 2026-10-07). Same shape as hauska-engine's `writer-blast-radius-guard.mjs`
 * (P-213) / `destructive-write-declaration.mjs` and hauska-factory's
 * `destructive-write-guard.mjs` (P-320) -- the program-wide number
 * (`MAX_DESTRUCTIVE_SHARE = 0.05`, A-220 2026-09-18) and the override-token
 * shape are the SAME across all three repos, by design, even though this is
 * a separate implementation (LDT is its own git repo; it cannot import
 * hauska-engine's file). A writer here declares the same number rather than
 * inventing its own.
 *
 * WHY THIS EXISTS IN LDT. `nodeFacetPatchCadRollFromCadPropertyCli.ts`
 * ("node-facet-patch-cad-roll", named in the audit's gate-5 onboarding-
 * runbook item) UPDATEs `place_layer_snapshots.payload_json` in bulk, per
 * county, with NO guard of any kind before this: no row cap, no measured
 * population, no override token. hauska-factory's own
 * `DESTRUCTIVE_WRITERS` register (`dollar-fields-patch` entry) judges this
 * class of write out of scope for a STATUS-transition guard because it
 * "writes VALUES onto rows that stay live" rather than retiring anything --
 * that judgment stands for the STATUS question. It is a different question
 * from this one: a bulk VALUE overwrite can still silently replace a
 * CORRECT existing dollar figure with a wrong one at whole-county scale
 * (the audit's own P4 examples -- Robertson, Smith -- are exactly bulk
 * value-level repairs that bypassed review, one touching 95.67% of a
 * county). This guard measures DESTRUCTIVE OVERWRITES specifically: a row
 * whose EXISTING cadRoll field already answered something (`"present"` or
 * `"zero"`, never `"absent"`) and would be CHANGED to a different value.
 * On a first-ever patch (every county starts with every cadRoll field
 * `"absent"`), the destructive share is always 0 by construction -- Burnet
 * is unaffected on its first run. A re-run against a corrected or
 * regressed export is exactly what this catches.
 */

export const MAX_DESTRUCTIVE_SHARE = 0.05;
export const AUTHORISATION_ENV_VAR = "DESTRUCTIVE_WRITE_AUTHORISATION";

export const BLAST_RADIUS_EXCEEDED = "BLAST_RADIUS_EXCEEDED";
export const BLAST_RADIUS_UNMEASURED = "BLAST_RADIUS_UNMEASURED";
export const BLAST_RADIUS_OVERRIDE_MALFORMED = "BLAST_RADIUS_OVERRIDE_MALFORMED";
export const BLAST_RADIUS_OVERRIDE_MISMATCH = "BLAST_RADIUS_OVERRIDE_MISMATCH";

export class BlastRadiusRefusal extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "BlastRadiusRefusal";
    this.code = code;
    this.detail = detail;
  }
}

export interface BlastRadiusOverride {
  writer: string;
  scopeKey: string;
  affected: number;
  population: number;
  raw: string;
}

/** `<writer>:<scopeKey>:<affected>/<population>` -- identical shape to hauska-engine's parser. */
export function parseBlastRadiusOverride(raw: string | null | undefined): BlastRadiusOverride | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  const m = /^([a-z][a-z0-9._-]*):([^:]+):(\d+)\/(\d+)$/i.exec(s);
  if (!m) {
    throw new BlastRadiusRefusal(
      BLAST_RADIUS_OVERRIDE_MALFORMED,
      `${AUTHORISATION_ENV_VAR} must be <writer>:<scopeKey>:<affected>/<population> ` +
        `(e.g. node-facet-patch-cad-roll:48021:120/50000); got ${JSON.stringify(s)}`,
      { raw: s },
    );
  }
  return { writer: m[1]!, scopeKey: m[2]!, affected: Number(m[3]), population: Number(m[4]), raw: s };
}

export function overrideTokenFor(writer: string, scopeKey: string, affected: number, population: number): string {
  return `${AUTHORISATION_ENV_VAR}=${writer}:${scopeKey}:${affected}/${population}`;
}

export interface BlastRadiusVerdict {
  ok: true;
  writer: string;
  scopeKey: string;
  affected: number;
  population: number;
  maxShare: number;
  share: number | null;
  basis: "no-population" | "no-change" | "within-threshold" | "override-authorised";
}

/**
 * Pure. `affected` = count of rows this run would DESTRUCTIVELY overwrite
 * (an existing non-absent value changing to a different value), never the
 * total rows touched. `population` = the scanned denominator. Refuses
 * (throws `BlastRadiusRefusal`) rather than returning a verdict when the
 * share exceeds `maxShare` and no valid, exactly-matching override is
 * present.
 */
export function evaluateBlastRadius(params: {
  writer: string;
  scopeKey: string;
  affected: number;
  population: number;
  maxShare?: number;
  override?: string | null;
}): BlastRadiusVerdict {
  const { writer, scopeKey, affected, population, maxShare = MAX_DESTRUCTIVE_SHARE, override = null } = params;
  if (!writer || !scopeKey) {
    throw new Error("evaluateBlastRadius requires a non-empty writer and scopeKey");
  }
  if (!(typeof maxShare === "number" && maxShare > 0 && maxShare < 1)) {
    throw new Error(`evaluateBlastRadius requires 0 < maxShare < 1; got ${maxShare}`);
  }
  if (!Number.isInteger(affected) || affected < 0 || !Number.isInteger(population) || population < 0) {
    throw new BlastRadiusRefusal(
      BLAST_RADIUS_UNMEASURED,
      `blast-radius guard for ${writer}/${scopeKey} could not measure its population ` +
        `(affected=${JSON.stringify(affected)}, population=${JSON.stringify(population)})`,
      { writer, scopeKey, affected, population },
    );
  }

  const parsedOverride = parseBlastRadiusOverride(override);

  if (population === 0) {
    return { ok: true, writer, scopeKey, affected, population, maxShare, share: null, basis: "no-population" };
  }

  const share = affected / population;
  if (share <= maxShare) {
    return {
      ok: true,
      writer,
      scopeKey,
      affected,
      population,
      maxShare,
      share,
      basis: affected === 0 ? "no-change" : "within-threshold",
    };
  }

  const token = overrideTokenFor(writer, scopeKey, affected, population);
  if (parsedOverride) {
    if (parsedOverride.writer !== writer || parsedOverride.scopeKey !== scopeKey) {
      throw new BlastRadiusRefusal(
        BLAST_RADIUS_OVERRIDE_MISMATCH,
        `${AUTHORISATION_ENV_VAR} authorizes ${parsedOverride.writer}/${parsedOverride.scopeKey}; ` +
          `this run is ${writer}/${scopeKey}. Correct token: ${token}`,
        { writer, scopeKey, override: parsedOverride, expectedToken: token, share, affected, population },
      );
    }
    if (parsedOverride.affected !== affected || parsedOverride.population !== population) {
      throw new BlastRadiusRefusal(
        BLAST_RADIUS_OVERRIDE_MISMATCH,
        `${AUTHORISATION_ENV_VAR} authorizes ${parsedOverride.affected}/${parsedOverride.population}; ` +
          `this run measures ${affected}/${population}. Correct token: ${token}`,
        { writer, scopeKey, override: parsedOverride, expectedToken: token, share, affected, population },
      );
    }
    return { ok: true, writer, scopeKey, affected, population, maxShare, share, basis: "override-authorised" };
  }

  throw new BlastRadiusRefusal(
    BLAST_RADIUS_EXCEEDED,
    `${writer}/${scopeKey} would destructively overwrite ${affected} of ${population} ` +
      `(${(share * 100).toFixed(2)}%) already-answered row(s) (declared threshold ` +
      `${(maxShare * 100).toFixed(2)}%). NOTHING WAS WRITTEN. To authorize THIS measured run and ` +
      `no other, re-execute with ${token}`,
    { writer, scopeKey, share, affected, population, expectedToken: token },
  );
}
