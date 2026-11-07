/**
 * TARGETED BACKFILL of the two PUBLISHED IDENTIFIER columns onto rows that
 * already exist. P-124 CTX-HAYS-BACKFILL, 2026-09-10.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE INGEST CLI.
 *
 * CTX-HAYS-REBIND added `cad_property.quick_ref_id` and
 * `cad_property.property_number` (migration 0099, applied to production) and
 * taught the Orion parser to read them. Nothing populates them on rows that
 * were loaded before that change, and there was no way to populate them
 * WITHOUT re-running the whole export, because `upsertCadProperties` builds a
 * whole row: `toInsertRow` fills every column, `marketValue` merges as
 * `COALESCE(excluded.market_value, existing)` so a non-null incoming value
 * WINS, and `source_file` / `source_vintage` are overwritten unconditionally.
 *
 * Measured read-only against production on 2026-09-10, joining the store's
 * 134,606 Hays rows at tax_year 2026 to the 8-26-2026 export's 134,591
 * accounts: running that export through `cad-ingest` would change 45,524 of
 * 134,216 market values, about 5.8 billion dollars of absolute movement, and
 * would rewrite `source_file` on every row it touched while leaving
 * `PRELIMINARY` on the 390 it did not. Which drop should be Hays' declared
 * 2026 roll is an open operator question. This tool exists so the geometry
 * rebind does not have to answer it.
 *
 * IDENTITY COLUMNS AND VALUATION COLUMNS HAVE DIFFERENT BLAST RADII.
 * `QuickRefID` and `PropertyNumber` describe the ACCOUNT, so a later drop can
 * supply them for a roll loaded from an earlier one. Market value describes
 * the DROP. That asymmetry is the whole argument for a separate writer.
 *
 * WHAT THIS WRITER CAN DO, STRUCTURALLY:
 *  - it is an `UPDATE ... FROM (VALUES ...)`, so it CANNOT insert. "Never
 *    INSERT" is carried by the shape of the statement, not by a check that
 *    could go missing;
 *  - its SET clause names exactly {@link BACKFILL_WRITABLE_COLUMNS} and
 *    {@link assertBackfillStatementSafe} refuses any other target;
 *  - it does NOT bump `ingested_at`, deliberately, unlike the upsert path.
 *    `ingested_at` says when this row's ROLL data was loaded, and a backfill
 *    of two identity columns loads no roll data. The untouched-columns digest
 *    below enforces that rather than trusting it;
 *  - a blank identifier is COALESCEd away, never written as an empty string.
 *    Migration 0099 says NULL means "not published / not acquired" and a null
 *    key can never produce a bind; an empty string would be a key that binds
 *    nothing while looking populated.
 *
 * THE ARCHIVE TRAP THIS READER REFUSES. Every member of every inner zip in a
 * Hays drop is named `PropertyDataExport<n>.txt` and only the ENCLOSING zip
 * says which record type it is. All six members share their first four
 * columns -- RecordType, PropertyID, QuickRefID, PropertyNumber -- so a header
 * check for the identifier columns passes on the wrong file, and that is
 * exactly how a previous pass read the IMPROVEMENT member (103,490 rows)
 * believing it was the roll (134,592). See
 * {@link discriminateOrionPropertyMember}.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { HeaderIndex, readCsvRows } from "./csv";
import { stripLeadingZeros, textOrNull } from "./normalize";
import {
  resolveDeclaredCadVintage,
  type DeclaredCadVintage,
} from "./vintage";

/* ------------------------------------------------------------------ *
 * member discrimination
 * ------------------------------------------------------------------ */

/**
 * Columns every Orion member carries. Present here ONLY so a file missing
 * them fails with the right message: this set is NECESSARY AND NOT
 * SUFFICIENT, and believing otherwise is what cost the false start.
 */
const IDENTIFIER_COLUMNS = ["propertyid", "quickrefid", "propertynumber"] as const;

/**
 * Columns the PROPERTY member carries and no sibling in a Hays drop does.
 * Measured against the 2026-08-26 archive: OWNER, LAND, IMPROVEMENT, SEGMENT
 * and SALES carry NONE of these.
 */
const PROPERTY_ONLY_COLUMNS = [
  "legaldesc",
  "situs",
  "marketvalue",
  "squarefootage",
  "legalacres",
] as const;

/**
 * A marker column that positively identifies a SIBLING member, so a refusal
 * can say WHICH file it was handed instead of only that it was the wrong one.
 * Order matters: SEGMENT and IMPROVEMENT both carry `instanceid` and only
 * SEGMENT carries `actyrbuilt`.
 */
const SIBLING_MARKERS: ReadonlyArray<{ column: string; member: string }> = [
  { column: "actyrbuilt", member: "SEGMENT" },
  { column: "instanceid", member: "IMPROVEMENT" },
  { column: "ownername", member: "OWNER" },
  { column: "fullname", member: "OWNER" },
  { column: "landtype", member: "LAND" },
  { column: "saledate", member: "SALES" },
];

/**
 * Header width of the 2026-08-26 Hays PROPERTY member. RECORDED, NEVER GATED.
 *
 * The dispatch offered header width as the cheapest discriminator and invited
 * something better. This is the something better, and the argument is short:
 * width uniquely identifies PROPERTY (40) among the six members of this
 * archive, but OWNER, LAND and SEGMENT are ALL 21 columns, so width cannot
 * name the sibling it refused; and an equality on 40 would refuse a valid
 * future drop that adds a column, which is a refusal in the wrong direction
 * for a reason that has nothing to do with the file's meaning. The gate is
 * therefore R2 (a named sibling marker is present) and R3 (the PROPERTY-only
 * columns are present), with width carried in the record so a human can
 * eyeball it.
 */
export const HAYS_PROPERTY_HEADER_WIDTH = 40;

/**
 * R4's ceiling. A PROPERTY member is one row per account; a per-instance
 * member (IMPROVEMENT, SEGMENT, LAND, SALES, OWNER) repeats accounts.
 *
 * Measured on the 2026-08-26 archive: PROPERTY carries 1 duplicate PropertyID
 * in 134,592 rows (0.0007 percent) and IMPROVEMENT carries 5,342 in 103,490
 * (5.2 percent). The ceiling sits three orders of magnitude from both, so it
 * is fitted to neither. It is a BACKSTOP behind R1-R3, which already refuse
 * every sibling in this archive on header alone; R4's job is to be the one
 * rule that reads the ROWS, so that no malformed header can satisfy the whole
 * gate by itself.
 */
export const ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO = 0.001;

/**
 * The row count below which R4 DECLARES ITSELF NOT APPLICABLE rather than
 * firing.
 *
 * A 0.1 percent ceiling cannot express anything on a file of 9 rows -- one
 * duplicate is already 11 percent -- so below this floor the rule would be
 * arithmetic noise dressed as a finding. It reports `r4Applicable: false` into
 * the durable record instead of quietly passing, because a control that skips
 * itself without saying so is the silent degradation this program forbids;
 * degradation is permitted only when declared in the output.
 *
 * The exposure this leaves is real and is named: a PROPERTY-shaped file of
 * under 100 rows gets R1-R3 only. For a Texas county roll that is not a file
 * anyone would mistake for a roll, and R2 still refuses every sibling in a
 * Hays drop on its header alone.
 */
export const ACCOUNT_CARDINALITY_MIN_ROWS = 100;

export interface MemberDiscrimination {
  accepted: boolean;
  /** The rule that decided, pass or fail. */
  decidedBy: string;
  /** Recorded, not gated. See {@link HAYS_PROPERTY_HEADER_WIDTH}. */
  columnCount: number;
  rulesPassed: string[];
  /**
   * Whether R4 (account-cardinality) was ABLE to run on this file, and what it
   * saw. Recorded always, so a skipped rule is visible rather than absent.
   */
  accountCardinality?: {
    applicable: boolean;
    rowsRead: number;
    duplicateRows: number;
    duplicateRatio: number;
    ceiling: number;
    minRows: number;
    note?: string;
  };
  /** Present only when `accepted` is false. */
  refusal?: {
    rule: string;
    reason: string;
    /** The sibling member this file was positively identified as, when known. */
    identifiedAs: string | null;
  };
}

/**
 * Decide whether a CSV header describes an Orion PROPERTY member.
 *
 * THREE HEADER RULES, AND THE FIRST ONE IS THE TRAP.
 *
 *  R1 `identifier-columns-present` -- PropertyID, QuickRefID, PropertyNumber.
 *     Every member of a Hays drop passes this. It is here so a file missing
 *     them fails clearly, and its insufficiency is the documented reason the
 *     other two rules exist.
 *  R2 `sibling-marker-absent` -- refuse when a column that positively names a
 *     sibling is present, and say which sibling.
 *  R3 `property-columns-present` -- LegalDesc, Situs, MarketValue,
 *     SquareFootage, LegalAcres.
 *
 * R4 is not here: it reads rows, so it lives in
 * {@link readPublishedIdentifiers}.
 */
export function discriminateOrionPropertyMember(
  header: HeaderIndex,
  columnCount: number,
): MemberDiscrimination {
  const rulesPassed: string[] = [];

  const missingIds = IDENTIFIER_COLUMNS.filter((c) => !header.has(c));
  if (missingIds.length > 0) {
    return {
      accepted: false,
      decidedBy: "R1 identifier-columns-present",
      columnCount,
      rulesPassed,
      refusal: {
        rule: "R1 identifier-columns-present",
        reason:
          `missing published-identifier column(s): ${missingIds.join(", ")}. ` +
          "This is not an Orion export member.",
        identifiedAs: null,
      },
    };
  }
  rulesPassed.push("R1 identifier-columns-present");

  for (const marker of SIBLING_MARKERS) {
    if (header.has(marker.column)) {
      return {
        accepted: false,
        decidedBy: "R2 sibling-marker-absent",
        columnCount,
        rulesPassed,
        refusal: {
          rule: "R2 sibling-marker-absent",
          reason:
            `column "${marker.column}" identifies this as the ${marker.member} ` +
            "member, not PROPERTY. Every member of a Hays drop is named " +
            "PropertyDataExport<n>.txt and shares PropertyID, QuickRefID and " +
            "PropertyNumber, so the identifier columns alone cannot tell them " +
            "apart.",
          identifiedAs: marker.member,
        },
      };
    }
  }
  rulesPassed.push("R2 sibling-marker-absent");

  const missingProperty = PROPERTY_ONLY_COLUMNS.filter((c) => !header.has(c));
  if (missingProperty.length > 0) {
    return {
      accepted: false,
      decidedBy: "R3 property-columns-present",
      columnCount,
      rulesPassed,
      refusal: {
        rule: "R3 property-columns-present",
        reason:
          `missing PROPERTY-only column(s): ${missingProperty.join(", ")}. ` +
          "No sibling member of a Hays drop carries these.",
        identifiedAs: null,
      },
    };
  }
  rulesPassed.push("R3 property-columns-present");

  return {
    accepted: true,
    decidedBy: "R3 property-columns-present",
    columnCount,
    rulesPassed,
  };
}

/* ------------------------------------------------------------------ *
 * reading the identifiers
 * ------------------------------------------------------------------ */

export interface PublishedIdentifierRow {
  /** CAD PropertyID, leading zeros stripped, exactly as `prop_id` holds it. */
  propId: string;
  quickRefId: string | null;
  propertyNumber: string | null;
}

export interface PublishedIdentifierRead {
  filePath: string;
  discrimination: MemberDiscrimination;
  /** Deduplicated, first occurrence wins, both-blank rows excluded. */
  rows: PublishedIdentifierRow[];
  /**
   * EVERY distinct prop_id the export carried, including the ones that
   * publish no identifier and the ones refused as conflicting duplicates.
   *
   * Separate from `rows` because "the export does not carry this account" and
   * "the export carries it and publishes nothing" are DIFFERENT states, and a
   * record that reports one population for both cannot tell an absence from a
   * blank. That distinction is the entire premise of the two columns.
   */
  seenPropIds: string[];
  rowsRead: number;
  /** Repeat PropertyID whose identifier pair AGREES with the first. */
  duplicateRowsExact: number;
  /** Repeat PropertyID whose identifier pair DISAGREES. Refused, not resolved. */
  duplicateRowsConflicting: number;
  conflictingPropIds: string[];
  blankPropIdRows: number;
  /** Accounts whose export row publishes neither identifier. Never written. */
  rowsWithNoIdentifier: number;
  noIdentifierPropIds: string[];
}

export class BackfillRefusal extends Error {
  readonly rule: string;
  readonly detail: Record<string, unknown>;
  constructor(rule: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "BackfillRefusal";
    this.rule = rule;
    this.detail = detail;
  }
}

/**
 * Read an Orion PROPERTY member into (prop_id, quick_ref_id, property_number).
 *
 * Reads the WHOLE file before returning, on purpose. R4 is a row-derived rule
 * and a gate that fires after the first batch has already been written is not
 * a gate. 134,592 rows of three short strings is about 10 MB, which is a cheap
 * price for a true pre-write refusal.
 *
 * A row publishing NEITHER identifier is counted and dropped: there is nothing
 * to write, and writing an empty string would be a key that binds nothing
 * while looking populated. A row publishing ONE is kept -- the writer
 * COALESCEs, so the absent half leaves its cell alone.
 */
export async function readPublishedIdentifiers(
  filePath: string,
): Promise<PublishedIdentifierRead> {
  let header: HeaderIndex | null = null;
  let discrimination: MemberDiscrimination | null = null;
  const byPropId = new Map<string, PublishedIdentifierRow>();
  const seenPropIds = new Set<string>();
  let rowsRead = 0;
  let duplicateRowsExact = 0;
  let duplicateRowsConflicting = 0;
  const conflictingPropIds: string[] = [];
  let blankPropIdRows = 0;
  const noIdentifierPropIds: string[] = [];

  for await (const row of readCsvRows(filePath)) {
    if (header === null) {
      header = new HeaderIndex(row);
      discrimination = discriminateOrionPropertyMember(header, row.length);
      if (!discrimination.accepted) {
        const r = discrimination.refusal as NonNullable<
          MemberDiscrimination["refusal"]
        >;
        throw new BackfillRefusal(
          r.rule,
          `${filePath}: refused. ${r.reason}`,
          {
            filePath,
            columnCount: discrimination.columnCount,
            identifiedAs: r.identifiedAs,
            rulesPassed: discrimination.rulesPassed,
          },
        );
      }
      continue;
    }
    rowsRead += 1;
    const propId = stripLeadingZeros(header.get(row, "propertyid").trim());
    if (propId.length === 0) {
      blankPropIdRows += 1;
      continue;
    }
    seenPropIds.add(propId);
    const quickRefId = textOrNull(header.get(row, "quickrefid"));
    const propertyNumber = textOrNull(header.get(row, "propertynumber"));

    const existing = byPropId.get(propId);
    if (existing !== undefined) {
      if (
        existing.quickRefId === quickRefId &&
        existing.propertyNumber === propertyNumber
      ) {
        duplicateRowsExact += 1;
      } else {
        // FAIL CLOSED ON THE ACCOUNT, not on the file. Two rows for one
        // account that disagree about its published identifiers cannot both
        // be right, and picking one is a resolution nobody authorised.
        duplicateRowsConflicting += 1;
        conflictingPropIds.push(propId);
        byPropId.delete(propId);
      }
      continue;
    }
    if (quickRefId === null && propertyNumber === null) {
      noIdentifierPropIds.push(propId);
      continue;
    }
    byPropId.set(propId, { propId, quickRefId, propertyNumber });
  }

  if (header === null || discrimination === null) {
    throw new BackfillRefusal(
      "R0 file-has-a-header",
      `${filePath}: refused. The file is empty; no header row was read.`,
      { filePath },
    );
  }

  // R4 account-cardinality: the ONE rule here that reads rows rather than the
  // header, which is what makes the gate as a whole a check between two
  // independently produced things rather than internal consistency on one.
  const duplicateRows = duplicateRowsExact + duplicateRowsConflicting;
  const duplicateRatio = rowsRead === 0 ? 0 : duplicateRows / rowsRead;
  const r4Applicable = rowsRead >= ACCOUNT_CARDINALITY_MIN_ROWS;
  discrimination.accountCardinality = {
    applicable: r4Applicable,
    rowsRead,
    duplicateRows,
    duplicateRatio,
    ceiling: ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO,
    minRows: ACCOUNT_CARDINALITY_MIN_ROWS,
    ...(r4Applicable
      ? {}
      : {
          note:
            `R4 NOT APPLICABLE: ${rowsRead} rows is below the ` +
            `${ACCOUNT_CARDINALITY_MIN_ROWS}-row floor at which a ` +
            `${ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO * 100} percent ceiling ` +
            "means anything. R1-R3 decided this file on their own.",
        }),
  };
  if (r4Applicable && duplicateRatio > ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO) {
    throw new BackfillRefusal(
      "R4 account-cardinality",
      `${filePath}: refused. ${duplicateRows} of ${rowsRead} rows repeat a ` +
        `PropertyID (${(duplicateRatio * 100).toFixed(4)} percent, ceiling ` +
        `${(ACCOUNT_CARDINALITY_MAX_DUPLICATE_RATIO * 100).toFixed(4)} percent). ` +
        "A PROPERTY member is one row per account; a member that repeats " +
        "accounts is a per-instance file (IMPROVEMENT, SEGMENT, LAND, SALES " +
        "or OWNER) whose header did not give it away.",
      { filePath, rowsRead, duplicateRows, duplicateRatio },
    );
  }
  if (r4Applicable) {
    discrimination.rulesPassed.push("R4 account-cardinality");
    discrimination.decidedBy = "R4 account-cardinality";
  } else {
    discrimination.rulesPassed.push("R4 account-cardinality (not applicable)");
  }

  return {
    filePath,
    discrimination,
    rows: [...byPropId.values()],
    seenPropIds: [...seenPropIds],
    rowsRead,
    duplicateRowsExact,
    duplicateRowsConflicting,
    conflictingPropIds,
    blankPropIdRows,
    rowsWithNoIdentifier: noIdentifierPropIds.length,
    noIdentifierPropIds,
  };
}

/* ------------------------------------------------------------------ *
 * the declared-vintage gate
 * ------------------------------------------------------------------ */

/**
 * Resolve the tax_year this backfill is allowed to write, from
 * `DECLARED_CAD_VINTAGES` -- NEVER from a flag.
 *
 * A flag is a number the operator can get wrong and nothing would catch. The
 * declared vintage is the same constant every `cad_property` reader filters
 * on, so a backfill keyed off it can only ever write into rows the bake will
 * actually read; identifiers written onto a non-declared year would populate a
 * column nothing queries while looking like progress, which is this program's
 * named defect class.
 *
 * `--tax-year` is still accepted, as a CONFIRMATION that must AGREE. That
 * keeps the invocation self-documenting -- a reader of the shell history can
 * see which year was written -- while making a disagreement a refusal rather
 * than a silent divergence.
 *
 * NOT GATED: the declared TIER. A stratmap-roll county's declared vintage is
 * still the year the bake reads, and published identity columns describe the
 * account rather than the drop, so refusing on tier would be a control broader
 * than its claim. Stated so the exclusion is part of the contract.
 */
export function resolveBackfillTaxYear(
  countyFips: string,
  requestedTaxYear?: number,
): DeclaredCadVintage {
  const declared = resolveDeclaredCadVintage(countyFips);
  if (requestedTaxYear !== undefined && requestedTaxYear !== declared.taxYear) {
    throw new BackfillRefusal(
      "declared-vintage",
      `backfill FAIL CLOSED: --tax-year=${requestedTaxYear} does not match the ` +
        `declared vintage for county ${declared.countyFips}, which is ` +
        `${declared.taxYear} (tier ${declared.tier}). The declared vintage is ` +
        "the only year the bake reads; writing identifiers onto any other year " +
        "would populate a column nothing queries.",
      {
        countyFips: declared.countyFips,
        requestedTaxYear,
        declaredTaxYear: declared.taxYear,
        declaredTier: declared.tier,
      },
    );
  }
  return declared;
}

/* ------------------------------------------------------------------ *
 * the statement
 * ------------------------------------------------------------------ */

/** The ONLY columns this writer may name in a SET clause. */
export const BACKFILL_WRITABLE_COLUMNS = Object.freeze([
  "quick_ref_id",
  "property_number",
] as const);

export interface BackfillStatement {
  text: string;
  values: unknown[];
  /** The prop_ids this statement offers, in order. */
  propIds: string[];
}

/**
 * Build the batched UPDATE.
 *
 * `UPDATE ... FROM (VALUES ...)`, so it cannot INSERT: an account in the
 * export with no row on the roll simply matches nothing. That is why "never
 * INSERT" is carried by the statement's TYPE rather than by a branch that
 * could be forgotten.
 *
 * COALESCE(incoming, existing) on both columns, the same direction
 * `upsertCadProperties` uses for these two and for the same stated reason: the
 * only non-appraisal writer emits null for both, so a write can never erase an
 * identifier a real CAD export established. It is also what makes a
 * half-published row safe -- the absent half leaves its cell alone instead of
 * blanking it.
 *
 * The trailing IS DISTINCT FROM pair suppresses no-op writes, which is what
 * makes `rowsUpdated` mean "this cell actually changed" and makes a second run
 * report zero. Idempotence becomes observable instead of asserted.
 *
 * `ingested_at` is NOT bumped. See the module header.
 */
export function buildBackfillUpdate(
  countyFips: string,
  taxYear: number,
  batch: readonly PublishedIdentifierRow[],
): BackfillStatement {
  if (batch.length === 0) {
    throw new Error("buildBackfillUpdate: empty batch");
  }
  const values: unknown[] = [countyFips, taxYear];
  const tuples: string[] = [];
  const propIds: string[] = [];
  for (const row of batch) {
    const a = values.push(row.propId);
    const b = values.push(row.quickRefId);
    const c = values.push(row.propertyNumber);
    // Cast every tuple: a NULL in a VALUES list used in FROM has no type
    // Postgres can infer, and casting only the first row makes the statement's
    // correctness depend on which row happened to be first.
    tuples.push(`($${a}::text, $${b}::text, $${c}::text)`);
    propIds.push(row.propId);
  }
  const text =
    `UPDATE cad_property AS t\n` +
    `   SET quick_ref_id = COALESCE(v.quick_ref_id, t.quick_ref_id),\n` +
    `       property_number = COALESCE(v.property_number, t.property_number)\n` +
    `  FROM (VALUES ${tuples.join(", ")})\n` +
    `       AS v(prop_id, quick_ref_id, property_number)\n` +
    ` WHERE t.county_fips = $1\n` +
    `   AND t.tax_year = $2::int\n` +
    `   AND t.prop_id = v.prop_id\n` +
    `   AND (t.quick_ref_id IS DISTINCT FROM COALESCE(v.quick_ref_id, t.quick_ref_id)\n` +
    `     OR t.property_number IS DISTINCT FROM COALESCE(v.property_number, t.property_number))\n` +
    `RETURNING t.prop_id`;
  return { text, values, propIds };
}

/**
 * Refuse a statement whose SET clause names a column outside the allowlist.
 *
 * HONEST CLASSIFICATION: this is INTERNAL CONSISTENCY. It inspects a string
 * this module built, so one bad edit in this file could in principle satisfy
 * both halves. It catches the realistic failure -- a future change widening
 * the SET clause without touching {@link BACKFILL_WRITABLE_COLUMNS} -- and it
 * is not what proves no other column moved. That is the untouched-columns
 * digest, which is computed by the STORE over columns enumerated from the
 * CATALOG, and which no amount of editing here can forge.
 */
export function assertBackfillStatementSafe(text: string): void {
  const setClause = /\bSET\b([\s\S]*?)\bFROM\b/i.exec(text)?.[1];
  if (setClause === undefined) {
    throw new BackfillRefusal(
      "set-clause-allowlist",
      "backfill FAIL CLOSED: statement has no parsable SET ... FROM clause",
      { text },
    );
  }
  const targets = [...setClause.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map(
    (m) => (m[1] as string).toLowerCase(),
  );
  if (targets.length === 0) {
    throw new BackfillRefusal(
      "set-clause-allowlist",
      "backfill FAIL CLOSED: no assignment targets parsed from the SET clause",
      { setClause },
    );
  }
  const allowed = new Set<string>(BACKFILL_WRITABLE_COLUMNS);
  const rogue = targets.filter((t) => !allowed.has(t));
  if (rogue.length > 0) {
    throw new BackfillRefusal(
      "set-clause-allowlist",
      `backfill FAIL CLOSED: SET clause names ${rogue.join(", ")}, which is ` +
        `outside the allowlist {${[...allowed].join(", ")}}`,
      { rogue, targets },
    );
  }
  if (/\b(insert\s+into|delete\s+from|truncate|drop\s+table)\b/i.test(text)) {
    throw new BackfillRefusal(
      "set-clause-allowlist",
      "backfill FAIL CLOSED: statement carries a non-UPDATE verb",
      { text },
    );
  }
}

/* ------------------------------------------------------------------ *
 * the untouched-columns digest -- THE money control
 * ------------------------------------------------------------------ */

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL that enumerates every `cad_property` column EXCEPT the two this writer
 * may touch, from the CATALOG.
 *
 * From the catalog and not from a list in this file, deliberately: a column
 * added by a later migration is covered automatically, whereas a hand-typed
 * list would silently stop covering the store the day it drifted. This is the
 * "read the authoritative record, never a proxy for it" rule applied to a
 * schema.
 */
/**
 * The columns the digest DOES NOT WATCH, stated as its own literal.
 *
 * WHY THIS IS NOT `BACKFILL_WRITABLE_COLUMNS`, WHICH IT EQUALS. Found by
 * mutation, 2026-09-10, and it is the reason this constant exists at all. The
 * first version of the digest excluded the writer's own allowlist. Adding
 * `market_value` to that allowlist and to the SET clause -- ONE conceptual
 * edit -- moved a dollar on every row AND removed `market_value` from the
 * digest's column list in the same stroke, so the digest reported VERIFIED on
 * a run that had just changed the money. A checker whose exclusion set is
 * derived from the thing it is checking is internal consistency wearing a
 * meaning-shaped costume: one party acting alone satisfies both sides, which
 * is exactly the test ENFORCEMENT sets and exactly what it fails.
 *
 * So this list is written here, independently, and
 * {@link assertDigestScopeIntact} REFUSES the run when the writer's allowlist
 * and this list stop agreeing. Widening the writer now stops the run instead
 * of blinding the check.
 */
export const DIGEST_EXCLUDED_COLUMNS = Object.freeze([
  "quick_ref_id",
  "property_number",
] as const);

/**
 * Columns the digest MUST be watching for the run to be allowed to proceed.
 *
 * The positive half of the same defence. The exclusion assertion catches a
 * widened allowlist; this catches everything else that could quietly shrink
 * the digest's reach -- a short catalog read, a renamed column, a schema the
 * tool is pointed at that is not the one it thinks. Every entry here is a
 * column a wrong write would move and a customer would feel.
 */
export const DIGEST_MUST_COVER = Object.freeze([
  "market_value",
  "assessed_value",
  "land_value",
  "improvement_value",
  "situs_address",
  "owner_name",
  "source_file",
  "source_vintage",
  "ingested_at",
] as const);

/**
 * Refuse when the writer's allowlist and the digest's blind spot have drifted
 * apart, in EITHER direction.
 *
 * The failure this kills is a real one that shipped in this file's first draft
 * and was caught only by mutating the writer and re-running the controls. A
 * control observed only passing has not been observed working.
 */
export function assertDigestScopeIntact(
  writableColumns: readonly string[] = BACKFILL_WRITABLE_COLUMNS,
  excludedColumns: readonly string[] = DIGEST_EXCLUDED_COLUMNS,
): void {
  const writable = [...writableColumns].sort();
  const excluded = [...excludedColumns].sort();
  if (writable.join(",") !== excluded.join(",")) {
    throw new BackfillRefusal(
      "digest-scope",
      "backfill FAIL CLOSED: the writer's allowlist and the digest's " +
        `exclusion set have diverged (writable={${writable.join(", ")}}, ` +
        `digest-excluded={${excluded.join(", ")}}). Widening what this tool ` +
        "may write without widening what the digest watches would leave the " +
        "new column unwatched, which is how a check goes blind.",
      { writable, excluded },
    );
  }
}

/**
 * Does the target store actually HAVE the two columns this tool writes?
 *
 * Measured 2026-09-10 against information_schema on both Neon branches:
 * production carries 23 columns on `cad_property` including both identifiers;
 * the `f06-staging-neondb` branch carries 21 and has NEITHER. Migration 0099
 * is applied to production and NOT to staging, and the dispatch's own sequence
 * -- integration seat runs staging first -- lands straight on that.
 *
 * Without this the run fails anyway, at the first UPDATE, with Postgres'
 * `column "quick_ref_id" of relation "cad_property" does not exist`. That is
 * fail-closed and it is useless: it arrives after the plan and the first
 * digest, and it says nothing about which migration is missing from which
 * branch. This turns it into a named refusal before anything is read or
 * written, which is what the operator on the other end of a staging run needs.
 *
 * READ THE CATALOG, NOT A PROXY. The question "does this column exist" is
 * answered by information_schema, never by the shape of a failed query.
 */
export const TARGET_COLUMNS_SQL =
  `SELECT column_name\n` +
  `  FROM information_schema.columns\n` +
  ` WHERE table_schema = current_schema()\n` +
  `   AND table_name = 'cad_property'\n` +
  `   AND column_name = ANY ($1::text[])`;

export const UNTOUCHED_COLUMNS_SQL =
  `SELECT column_name\n` +
  `  FROM information_schema.columns\n` +
  ` WHERE table_schema = current_schema()\n` +
  `   AND table_name = 'cad_property'\n` +
  `   AND column_name <> ALL ($1::text[])\n` +
  ` ORDER BY ordinal_position`;

/**
 * Build the digest query over the untouched columns of one county-year.
 *
 * WHY THIS IS MEANING SHAPED, AND THE ONE WAY IT WAS NOT. The tool's claim is
 * "I wrote two columns and nothing else". The digest is a SECOND derivation of
 * the same question, produced by Postgres from rows Postgres owns, over a
 * column list read from the CATALOG rather than from this file. To pass it
 * while having moved a dollar, a writer would have to change the store AND
 * forge the store's own aggregate.
 *
 * That held for the column LIST and did NOT hold for the SUBTRACTION. The
 * first draft subtracted the writer's own allowlist, so widening the writer
 * widened the blind spot in the same edit and the digest reported VERIFIED
 * over a run that moved market_value on every row. See
 * {@link DIGEST_EXCLUDED_COLUMNS} and {@link assertDigestScopeIntact}, which
 * exist because a mutation run found it.
 *
 * NULL and the empty string are given different renderings on purpose: a
 * control that cannot tell "absent" from "blank" is the collapse this program
 * hunts everywhere else, and it would be absurd to build it into the control.
 */
export function buildUntouchedDigestSql(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new BackfillRefusal(
      "untouched-digest",
      "backfill FAIL CLOSED: the catalog returned no untouched columns for " +
        "cad_property. Refusing rather than running an unverifiable write.",
      {},
    );
  }
  const parts = columns.map((c) => {
    if (!IDENT_RE.test(c)) {
      throw new BackfillRefusal(
        "untouched-digest",
        `backfill FAIL CLOSED: catalog column name "${c}" is not a plain ` +
          "identifier; refusing to interpolate it",
        { column: c },
      );
    }
    return `coalesce("${c}"::text, '~NULL~')`;
  });
  return (
    `SELECT count(*)::text AS n,\n` +
    `       md5(coalesce(string_agg(rowtext, chr(10) ORDER BY prop_id), '')) AS digest\n` +
    `  FROM (SELECT prop_id, concat_ws(chr(31), ${parts.join(", ")}) AS rowtext\n` +
    `          FROM cad_property\n` +
    `         WHERE county_fips = $1 AND tax_year = $2::int) s`
  );
}

export interface UntouchedDigest {
  rows: number;
  digest: string;
  columns: string[];
}

/* ------------------------------------------------------------------ *
 * the durable record
 * ------------------------------------------------------------------ */

export interface BackfillRecordWriter {
  write(entry: Record<string, unknown>): void;
  readonly path: string | null;
}

/**
 * JSONL record writer. Truncates and writes nothing on open, which PROVES the
 * path is writable before the caller opens a connection: ENFORCEMENT's rule is
 * that if the record cannot be written, the mutation does not run, and a
 * writer that discovers the path is bad after the first batch has landed does
 * not satisfy it.
 */
export function createFileRecordWriter(path: string): BackfillRecordWriter {
  writeFileSync(path, "", "utf8");
  return {
    path,
    write(entry) {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}

/** For dry runs and tests: keeps entries in memory. */
export function createMemoryRecordWriter(): BackfillRecordWriter & {
  entries: Record<string, unknown>[];
} {
  const entries: Record<string, unknown>[] = [];
  return { path: null, entries, write: (e) => void entries.push(e) };
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

export interface BackfillExecutor {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface BackfillRunOptions {
  countyFips: string;
  taxYear: number;
  /** What the operator passed on the command line. */
  sourceArchive: string;
  /** The member actually read, after discrimination. */
  sourceMember: string;
  sourceSha256: string | null;
  invocation: string;
  batchSize?: number;
  dryRun: boolean;
  record: BackfillRecordWriter;
  now?: () => string;
}

export interface BackfillSummary {
  countyFips: string;
  taxYear: number;
  sourceArchive: string;
  sourceMember: string;
  dryRun: boolean;
  /** Roll rows at (county, declared year), the denominator for everything. */
  rollRows: number;
  /** Export accounts that carry at least one identifier. */
  exportAccountsOffered: number;
  /** Offered accounts that exist on the roll. */
  rowsMatched: number;
  /** Matched rows whose cell actually changed. */
  rowsUpdated: number;
  /** Offered accounts with NO row on the roll. Skipped, never created. */
  rowsSkippedNoRollRow: number;
  /** Export rows publishing neither identifier. Never written. */
  rowsSkippedNullIdentifier: number;
  /** Accounts refused because two export rows disagreed about them. */
  rowsSkippedConflictingDuplicate: number;
  /**
   * Roll rows this run does NOT write, broken out because the three reasons
   * are different states and collapsing them would hide which one moved.
   * `rollRowsNoWrite` is their sum and is the "stays NULL, correctly"
   * population.
   */
  rollRowsNotInExport: number;
  rollRowsInExportWithNoIdentifier: number;
  rollRowsInExportRefusedAsConflicting: number;
  rollRowsNoWrite: number;
  untouchedDigestBefore: UntouchedDigest | null;
  untouchedDigestAfter: UntouchedDigest | null;
  untouchedDigestVerified: boolean;
  batches: number;
}

export const DEFAULT_BACKFILL_BATCH_SIZE = 1000;

async function assertTargetColumnsPresent(
  exec: BackfillExecutor,
  columns: readonly string[] = BACKFILL_WRITABLE_COLUMNS,
): Promise<void> {
  const res = await exec.query<{ column_name: string }>(TARGET_COLUMNS_SQL, [
    [...columns],
  ]);
  const found = new Set(res.rows.map((r) => r.column_name));
  const missing = columns.filter((c) => !found.has(c));
  if (missing.length > 0) {
    throw new BackfillRefusal(
      "target-columns",
      `backfill FAIL CLOSED: cad_property on this store has no ` +
        `${missing.join(", ")} column. Migration ` +
        "0099_cad_property_published_identifiers has not been applied here. " +
        "Apply it to this branch before running the backfill against it; " +
        "verified 2026-09-10 that production has both columns and the " +
        "f06-staging-neondb branch has neither.",
      { missing, found: [...found] },
    );
  }
}

async function readUntouchedDigest(
  exec: BackfillExecutor,
  countyFips: string,
  taxYear: number,
): Promise<UntouchedDigest> {
  assertDigestScopeIntact();
  const cols = await exec.query<{ column_name: string }>(UNTOUCHED_COLUMNS_SQL, [
    [...DIGEST_EXCLUDED_COLUMNS],
  ]);
  const columns = cols.rows.map((r) => r.column_name);
  const missing = DIGEST_MUST_COVER.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new BackfillRefusal(
      "digest-scope",
      `backfill FAIL CLOSED: the untouched-columns digest would not be ` +
        `watching ${missing.join(", ")}. A digest that does not cover the ` +
        "money columns proves nothing about them.",
      { missing, columns },
    );
  }
  const sql = buildUntouchedDigestSql(columns);
  const res = await exec.query<{ n: string; digest: string | null }>(sql, [
    countyFips,
    taxYear,
  ]);
  const row = res.rows[0];
  if (row === undefined) {
    throw new BackfillRefusal(
      "untouched-digest",
      "backfill FAIL CLOSED: the untouched-columns digest returned no row",
      { countyFips, taxYear },
    );
  }
  return { rows: Number(row.n), digest: row.digest ?? "", columns };
}

/**
 * Run the backfill.
 *
 * Order is load bearing:
 *  1. read the roll's prop_ids, so the plan is computed BEFORE anything is
 *     written and a dry run is the same computation as a real one;
 *  2. write the plan into the durable record, naming the ITEMS -- a count is
 *     not a record;
 *  3. stop here on a dry run;
 *  4. take the untouched-columns digest;
 *  5. write, in batches, recording every updated prop_id;
 *  6. take the digest again and REFUSE if it moved.
 *
 * Step 6 fails the run rather than reporting a warning. A control that
 * notices and shrugs is the artifact that exists, is correct, and does
 * nothing.
 */
export async function runPublishedIdentifierBackfill(
  exec: BackfillExecutor,
  read: PublishedIdentifierRead,
  opts: BackfillRunOptions,
): Promise<BackfillSummary> {
  const now = opts.now ?? (() => new Date().toISOString());
  const batchSize = opts.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE;

  opts.record.write({
    kind: "run-start",
    at: now(),
    invocation: opts.invocation,
    countyFips: opts.countyFips,
    taxYear: opts.taxYear,
    sourceArchive: opts.sourceArchive,
    sourceMember: opts.sourceMember,
    sourceSha256: opts.sourceSha256,
    dryRun: opts.dryRun,
    memberDiscrimination: read.discrimination,
    fileCounters: {
      rowsRead: read.rowsRead,
      blankPropIdRows: read.blankPropIdRows,
      duplicateRowsExact: read.duplicateRowsExact,
      duplicateRowsConflicting: read.duplicateRowsConflicting,
      rowsWithNoIdentifier: read.rowsWithNoIdentifier,
      accountsOffered: read.rows.length,
    },
  });

  // BEFORE anything else touches the store: does it even have the columns?
  // A dry run must refuse here too, because a dry run against staging is
  // exactly where this is meant to be discovered.
  await assertTargetColumnsPresent(exec);

  // The roll, at the declared vintage. CAD_PROPERTY_MULTI_YEAR_INVENTORY does
  // not apply: this is a single-year read filtered on the declared vintage
  // resolved by resolveBackfillTaxYear.
  const rollRes = await exec.query<{ prop_id: string }>(
    `SELECT prop_id FROM cad_property WHERE county_fips = $1 AND tax_year = $2::int`,
    [opts.countyFips, opts.taxYear],
  );
  const rollPropIds = new Set(rollRes.rows.map((r) => r.prop_id));

  const toUpdate: PublishedIdentifierRow[] = [];
  const skippedNoRollRow: string[] = [];
  for (const row of read.rows) {
    if (rollPropIds.has(row.propId)) toUpdate.push(row);
    else skippedNoRollRow.push(row.propId);
  }
  const offeredIds = new Set(read.rows.map((r) => r.propId));
  const seenIds = new Set(read.seenPropIds);
  const noIdentifierIds = new Set(read.noIdentifierPropIds);
  const conflictingIds = new Set(read.conflictingPropIds);
  const rollRowsNotInExport = [...rollPropIds].filter((p) => !seenIds.has(p));
  const rollRowsNoIdentifier = [...rollPropIds].filter((p) => noIdentifierIds.has(p));
  const rollRowsConflicting = [...rollPropIds].filter((p) => conflictingIds.has(p));
  const rollRowsNoWrite = [...rollPropIds].filter((p) => !offeredIds.has(p));

  opts.record.write({
    kind: "plan",
    at: now(),
    rollRows: rollPropIds.size,
    accountsOffered: read.rows.length,
    rowsMatched: toUpdate.length,
    rowsSkippedNoRollRow: skippedNoRollRow.length,
    rowsSkippedNullIdentifier: read.rowsWithNoIdentifier,
    rowsSkippedConflictingDuplicate: read.duplicateRowsConflicting,
    rollRowsNotInExport: rollRowsNotInExport.length,
    rollRowsInExportWithNoIdentifier: rollRowsNoIdentifier.length,
    rollRowsInExportRefusedAsConflicting: rollRowsConflicting.length,
    rollRowsNoWrite: rollRowsNoWrite.length,
    // The ITEMS, not only the counts. The fail-closed populations are named in
    // full because they are the ones a later reader will want to audit.
    skippedNoRollRowPropIds: skippedNoRollRow,
    skippedNullIdentifierPropIds: read.noIdentifierPropIds,
    conflictingDuplicatePropIds: read.conflictingPropIds,
    rollRowsNotInExportPropIds: rollRowsNotInExport,
    rollRowsNoWritePropIds: rollRowsNoWrite,
  });

  const summary: BackfillSummary = {
    countyFips: opts.countyFips,
    taxYear: opts.taxYear,
    sourceArchive: opts.sourceArchive,
    sourceMember: opts.sourceMember,
    dryRun: opts.dryRun,
    rollRows: rollPropIds.size,
    exportAccountsOffered: read.rows.length,
    rowsMatched: toUpdate.length,
    rowsUpdated: 0,
    rowsSkippedNoRollRow: skippedNoRollRow.length,
    rowsSkippedNullIdentifier: read.rowsWithNoIdentifier,
    rowsSkippedConflictingDuplicate: read.duplicateRowsConflicting,
    rollRowsNotInExport: rollRowsNotInExport.length,
    rollRowsInExportWithNoIdentifier: rollRowsNoIdentifier.length,
    rollRowsInExportRefusedAsConflicting: rollRowsConflicting.length,
    rollRowsNoWrite: rollRowsNoWrite.length,
    untouchedDigestBefore: null,
    untouchedDigestAfter: null,
    untouchedDigestVerified: false,
    batches: 0,
  };

  if (opts.dryRun) {
    opts.record.write({ kind: "run-end", at: now(), dryRun: true, summary });
    return summary;
  }

  const before = await readUntouchedDigest(exec, opts.countyFips, opts.taxYear);
  summary.untouchedDigestBefore = before;
  opts.record.write({
    kind: "untouched-digest",
    at: now(),
    phase: "before",
    rows: before.rows,
    digest: before.digest,
    columnCount: before.columns.length,
    columns: before.columns,
  });

  for (let i = 0; i < toUpdate.length; i += batchSize) {
    const batch = toUpdate.slice(i, i + batchSize);
    const stmt = buildBackfillUpdate(opts.countyFips, opts.taxYear, batch);
    assertBackfillStatementSafe(stmt.text);
    const res = await exec.query<{ prop_id: string }>(stmt.text, stmt.values);
    const updated = res.rows.map((r) => r.prop_id);
    summary.rowsUpdated += updated.length;
    summary.batches += 1;
    opts.record.write({
      kind: "batch",
      at: now(),
      index: summary.batches,
      offered: batch.length,
      updated: updated.length,
      updatedPropIds: updated,
    });
  }

  const after = await readUntouchedDigest(exec, opts.countyFips, opts.taxYear);
  summary.untouchedDigestAfter = after;
  summary.untouchedDigestVerified = after.digest === before.digest;
  opts.record.write({
    kind: "untouched-digest",
    at: now(),
    phase: "after",
    rows: after.rows,
    digest: after.digest,
    columnCount: after.columns.length,
    matchesBefore: summary.untouchedDigestVerified,
  });

  if (!summary.untouchedDigestVerified) {
    opts.record.write({
      kind: "violation",
      at: now(),
      what: "untouched-columns digest CHANGED across the run",
      before: { rows: before.rows, digest: before.digest },
      after: { rows: after.rows, digest: after.digest },
      read:
        "a column outside {quick_ref_id, property_number} moved, or the row " +
        "set changed. This run is NOT a clean two-column backfill.",
    });
    opts.record.write({ kind: "run-end", at: now(), dryRun: false, summary });
    throw new BackfillRefusal(
      "untouched-digest",
      "backfill FAIL CLOSED: the untouched-columns digest changed across the " +
        `run (${before.rows} rows / ${before.digest} -> ${after.rows} rows / ` +
        `${after.digest}). A column this writer must not touch has moved.`,
      { before, after },
    );
  }

  opts.record.write({ kind: "run-end", at: now(), dryRun: false, summary });
  return summary;
}

/** sha256 of a local file, for the record. */
export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
