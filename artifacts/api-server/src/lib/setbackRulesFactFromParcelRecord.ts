/**
 * parcel_record -> SetbackRulesFactRead adapter (F-01, OPS-21 P-148 /
 * P-132), mirroring utilityServiceFactFromParcelRecord.ts's own companion-
 * row-read shape -- NOT the scalar shape setbacksFactFromParcelRecord.ts
 * (its Ft-suffixed sibling adapter) uses. See setbackRulesFactRead.ts's own
 * module doc for the live-verified reason: this rail's content lives
 * entirely in a single companion row (rowIndex 0), never on the cell's own
 * `value` field.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  SETBACK_RULES_FACT_SOURCE,
  SETBACK_RULES_RAIL_KEY,
  type SetbackRulesFactRead,
} from "./setbackRulesFactRead";

const RULE_ROW_INDEX = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function reasonFromBasis(basis: string | Record<string, unknown> | null): string {
  if (typeof basis === "string") return basis;
  const rec = asRecord(basis);
  if (rec) {
    const finding = asNullableString(rec.finding);
    if (finding) return finding;
    return JSON.stringify(rec);
  }
  return "parcel_record marked this cell absent with no basis recorded.";
}

function methodFromBasis(basis: string | Record<string, unknown> | null): string | null {
  const rec = asRecord(basis);
  return rec ? asNullableString(rec.method) : null;
}

function vintageFromBasis(basis: string | Record<string, unknown> | null): string | null {
  const rec = asRecord(basis);
  return rec ? asNullableString(rec.vintage) : null;
}

export async function setbackRulesFactFromParcelRecord(
  parcelNodeId: string,
): Promise<SetbackRulesFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: SETBACK_RULES_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, SETBACK_RULES_RAIL_KEY);

  if (cell.state === "refused") {
    const codeMap = {
      unaccounted: "parcel-record-unaccounted",
      "engine-refused": "parcel-record-engine-refused",
      "no-such-parcel-or-rail": "parcel-record-cell-miss",
      "malformed-cell": "parcel-record-malformed-cell",
      "store-not-configured": "parcel-record-store-not-configured",
    } as const;
    return {
      state: "refused",
      code: codeMap[cell.code],
      source: SETBACK_RULES_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: SETBACK_RULES_FACT_SOURCE,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: vintageFromBasis(cell.basis),
    };
  }

  // cell.state === "present" -- the rule-citation content lives on the
  // companion row, never on cell.value (see module doc).
  const ruleRow: ParcelRecordCompanionRow | undefined = cell.companionRows.find(
    (r) => r.rowIndex === RULE_ROW_INDEX,
  );
  const payload = ruleRow ? asRecord(ruleRow.payload) : null;
  if (!payload) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: SETBACK_RULES_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${SETBACK_RULES_RAIL_KEY} is kind=value but its rowIndex ${RULE_ROW_INDEX} companion row was missing or unreadable. Refusing rather than inventing a rule citation.`,
    };
  }

  return {
    state: "present",
    source: SETBACK_RULES_FACT_SOURCE,
    entityId: placeKey,
    matchKind: asNullableString(payload.matchKind),
    citationUrl: asNullableString(payload.citationUrl),
    districtCode: asNullableString(payload.districtCode),
    districtName: asNullableString(payload.districtName),
    effectiveDate: asNullableString(payload.effectiveDate),
    jurisdictionKey: asNullableString(payload.jurisdictionKey),
    resolvedTableKey: asNullableString(payload.resolvedTableKey),
    note: asNullableString(payload.note),
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
