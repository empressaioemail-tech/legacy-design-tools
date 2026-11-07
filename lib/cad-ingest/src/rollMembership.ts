/**
 * Declared-roll membership marking (P-178).
 *
 * `upsertCadProperties` (ingest.ts) writes a WHOLE row and never deletes:
 * re-ingesting a fresher export for a (county, tax_year) only ever touches
 * rows the new export still names. An account present on a PRIOR drop and
 * absent from the new one is otherwise left at its stale values with
 * nothing to say so -- not a bug in upsertCadProperties, a separate,
 * explicit step this module is.
 *
 * Runs POST-UPSERT, never inside upsertCadProperties itself: the upsert
 * path's whole contract is "touch what the export names"; this is the
 * deliberately distinct step that names what it does NOT touch. Called
 * once per successful (non-dry-run) cli.ts ingest, county-and-tax-year
 * scoped, after the new rows are already committed.
 *
 * WHAT COUNTS AS "FELL OFF". Every cad_property row for (county_fips,
 * tax_year) whose OWN source_file is not this run's source_file (i.e. this
 * run's own upsert did not touch it) AND is not already marked with this
 * run's own declared_source_file (idempotent re-run: a second execution
 * against the same drop touches zero rows beyond whatever fell off again
 * in between). NEVER derived from a hand-typed prop_id list -- the query
 * reads cad_property itself, which is the same table upsertCadProperties
 * just wrote.
 *
 * THE RECORD. Every marked account is named in a durable record (one JSONL
 * line per account: prop_id, county_fips, tax_year, declared_source_file,
 * the source_file it fell off from, when), via the SAME
 * BackfillRecordWriter shape publishedIdentifierBackfill.ts already
 * established for "prove what a mutation touched" -- reused, not
 * reinvented, so this program has one record-writer convention, not two.
 */

import {
  createFileRecordWriter,
  createMemoryRecordWriter,
  type BackfillRecordWriter,
} from "./publishedIdentifierBackfill";

export { createFileRecordWriter, createMemoryRecordWriter, type BackfillRecordWriter };

export const ABSENT_FROM_DECLARED_DROP = "absent-from-declared-drop" as const;

export interface RollMembershipDb {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface MarkAbsentFromDeclaredDropOptions {
  countyFips: string;
  taxYear: number;
  /** This run's own cad_property.source_file -- rows carrying anything else were not touched by this run's upsert. */
  declaredSourceFile: string;
  record: BackfillRecordWriter;
  now?: () => string;
}

export interface MarkAbsentFromDeclaredDropResult {
  markedPropIds: string[];
}

/**
 * The one, tested, named UPDATE this program runs for this purpose --
 * never a hand-typed psql command. Parameterized, touches exactly the two
 * columns roll_membership/declared_source_file, scoped to one
 * (county_fips, tax_year), and only rows that actually need the change
 * (IS DISTINCT FROM guards against re-touching an already-correct row on
 * a repeat run, which would otherwise be a silent no-op write every time).
 */
export const MARK_ABSENT_FROM_DECLARED_DROP_SQL = `
UPDATE cad_property
   SET roll_membership = $4,
       declared_source_file = $3
 WHERE county_fips = $1
   AND tax_year = $2::int
   AND source_file <> $3
   AND (roll_membership IS DISTINCT FROM $4
        OR declared_source_file IS DISTINCT FROM $3)
RETURNING prop_id
`;

export async function markAbsentFromDeclaredDrop(
  db: RollMembershipDb,
  opts: MarkAbsentFromDeclaredDropOptions,
): Promise<MarkAbsentFromDeclaredDropResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const { rows } = await db.query<{ prop_id: string }>(MARK_ABSENT_FROM_DECLARED_DROP_SQL, [
    opts.countyFips,
    opts.taxYear,
    opts.declaredSourceFile,
    ABSENT_FROM_DECLARED_DROP,
  ]);
  const markedPropIds = rows.map((r) => r.prop_id).sort();
  const at = now();
  for (const propId of markedPropIds) {
    opts.record.write({
      event: "roll-membership-marked",
      propId,
      countyFips: opts.countyFips,
      taxYear: opts.taxYear,
      declaredSourceFile: opts.declaredSourceFile,
      rollMembership: ABSENT_FROM_DECLARED_DROP,
      at,
    });
  }
  return { markedPropIds };
}
