import { db, codeAtomSources } from "@workspace/db";
import {
  REQUIRED_CODE_ATOM_SOURCES,
  type RequiredCodeAtomSource,
} from "./sourceRegistry";

export interface BootstrapLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface EnsureCodeAtomSourcesResult {
  /** Total rows considered. */
  required: number;
  /** Rows that already existed (no write performed). */
  alreadyPresent: number;
  /** Rows that were inserted (or updated to match the registry). */
  upserted: number;
  /** Per-row failures. Empty on full success. */
  failures: Array<{ sourceName: string; error: string }>;
}

/**
 * Idempotently ensure every row in `REQUIRED_CODE_ATOM_SOURCES` exists in
 * the `code_atom_sources` table.
 *
 * Invariants:
 *  - Safe to call repeatedly; existing rows are matched by `sourceName`
 *    (which has a UNIQUE constraint) and updated to the registry values
 *    so we don't drift between code and DB.
 *  - Pre-existing data (atoms, queue rows) is untouched: this only writes
 *    to `code_atom_sources` and uses ON CONFLICT (source_name) DO UPDATE.
 *  - Per-row failures are logged but do NOT throw — the API server must
 *    continue starting up even if one row's upsert fails so the rest of
 *    the surface stays available.
 *
 * Designed to be called once at server boot. The cost is one INSERT per
 * required source (~3 round-trips today), which is negligible at startup.
 */
export async function ensureCodeAtomSources(
  logger: BootstrapLogger,
): Promise<EnsureCodeAtomSourcesResult> {
  const result: EnsureCodeAtomSourcesResult = {
    required: REQUIRED_CODE_ATOM_SOURCES.length,
    alreadyPresent: 0,
    upserted: 0,
    failures: [],
  };

  for (const row of REQUIRED_CODE_ATOM_SOURCES) {
    try {
      const upserted = await upsertOne(row);
      if (upserted) {
        result.upserted++;
      } else {
        result.alreadyPresent++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failures.push({ sourceName: row.sourceName, error: message });
      logger.warn(
        { err, sourceName: row.sourceName },
        "ensureCodeAtomSources: failed to upsert row — continuing",
      );
    }
  }

  if (result.failures.length === 0) {
    logger.info(
      {
        required: result.required,
        upserted: result.upserted,
        alreadyPresent: result.alreadyPresent,
      },
      "ensureCodeAtomSources: ok",
    );
  } else {
    logger.error(
      {
        required: result.required,
        upserted: result.upserted,
        alreadyPresent: result.alreadyPresent,
        failures: result.failures,
      },
      "ensureCodeAtomSources: completed with failures",
    );
  }

  return result;
}

/**
 * UPSERT one row. Returns true if a write happened (insert or update),
 * false if the existing row already matched the registry exactly. We
 * detect "actually wrote something" by comparing the returned row to
 * the input — Postgres' ON CONFLICT DO UPDATE ... RETURNING always
 * returns a row, so we have to compare explicitly.
 */
async function upsertOne(row: RequiredCodeAtomSource): Promise<boolean> {
  // Read first so we can report alreadyPresent vs upserted accurately.
  // The race window between SELECT and INSERT is acceptable here: in the
  // worst case we'll report a row as "upserted" when it was actually
  // already present, which is a logging-only concern.
  const existing = await db.query.codeAtomSources.findFirst({
    where: (t, { eq }) => eq(t.sourceName, row.sourceName),
    columns: {
      sourceName: true,
      label: true,
      sourceType: true,
      licenseType: true,
      baseUrl: true,
      notes: true,
    },
  });

  if (
    existing &&
    existing.label === row.label &&
    existing.sourceType === row.sourceType &&
    existing.licenseType === row.licenseType &&
    (existing.baseUrl ?? null) === (row.baseUrl ?? null) &&
    (existing.notes ?? null) === (row.notes ?? null)
  ) {
    return false;
  }

  await db
    .insert(codeAtomSources)
    .values({
      sourceName: row.sourceName,
      label: row.label,
      sourceType: row.sourceType,
      licenseType: row.licenseType,
      baseUrl: row.baseUrl,
      notes: row.notes,
    })
    .onConflictDoUpdate({
      target: codeAtomSources.sourceName,
      set: {
        label: row.label,
        sourceType: row.sourceType,
        licenseType: row.licenseType,
        baseUrl: row.baseUrl,
        notes: row.notes,
      },
    });

  return true;
}
