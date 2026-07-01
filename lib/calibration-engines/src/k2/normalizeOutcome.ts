import { randomUUID } from "node:crypto";

import type { ResolvedEdition } from "./editionResolve.js";
import {
  classifyAustinPermitDomain,
  classifySanAntonioPermitDomain,
  scopeFromPermitDomain,
} from "./permitPartition.js";

/** Normalized outcome record — K1_OUTCOME_LANDING_SCHEMA pass. */
export type NormalizedOutcomeRecord = {
  outcomeId: string;
  subjectKey: string;
  caseDate: string;
  outcomeLabel:
    | "issued"
    | "approved-clean"
    | "approved-with-variance"
    | "variance-required"
    | "denied"
    | "withdrawn"
    | "unknown";
  outcomeKind: "permit" | "variance" | "inspection" | "appeal" | "incident";
  editionInEffect: ResolvedEdition | null;
  jurisdictionTenant: string;
  parcelKey: string | null;
  rawSource: Record<string, string>;
  /** IBC-family rows without historical ICC text — pending ingest. */
  scope: "local-code" | "pending-icc";
  /** Dominant provision domain for permits (partition audit). */
  provisionDomain?: "local-code-evaluable" | "icode-dependent" | "deferred-ambiguous";
};

function parseFlexibleDate(raw: string | undefined): string | null {
  if (!raw?.trim() || raw.trim().toUpperCase() === "N/A") return null;
  const d = Date.parse(raw.replace(/\//g, "-"));
  return Number.isFinite(d) ? new Date(d).toISOString() : null;
}

function mapPermitOutcomeDetailed(
  status: string,
  workClass: string,
): {
  label: NormalizedOutcomeRecord["outcomeLabel"];
  disposition: "issued-clean" | "with-condition" | "denied" | "withdrawn" | "unknown";
} {
  const s = status.trim().toLowerCase();
  const wc = workClass.trim().toLowerCase();
  if (s.includes("denied") || s.includes("void")) {
    return { label: "denied", disposition: "denied" };
  }
  if (s.includes("withdraw")) {
    return { label: "withdrawn", disposition: "withdrawn" };
  }
  if (
    s.includes("condition") ||
    wc.includes("variance") ||
    s.includes("variance")
  ) {
    return { label: "approved-with-variance", disposition: "with-condition" };
  }
  if (s.includes("active") || s.includes("final") || s.includes("issued")) {
    return { label: "issued", disposition: "issued-clean" };
  }
  return { label: "unknown", disposition: "unknown" };
}

function mapPermitOutcome(status: string, workClass: string): NormalizedOutcomeRecord["outcomeLabel"] {
  return mapPermitOutcomeDetailed(status, workClass).label;
}

function mapVarianceOutcome(status: string): NormalizedOutcomeRecord["outcomeLabel"] {
  const s = status.trim().toLowerCase();
  if (s.includes("denied")) return "denied";
  if (s.includes("withdraw")) return "withdrawn";
  if (s.includes("approved")) return "approved-with-variance";
  return "variance-required";
}

export function normalizeAustinPermitRow(
  row: Record<string, string>,
  edition: ResolvedEdition | null,
): NormalizedOutcomeRecord | null {
  const issued = parseFlexibleDate(row["Issued Date"] ?? row["issued_date"]);
  const applied = parseFlexibleDate(row["Applied Date"] ?? row["applied_date"]);
  const caseDate = issued ?? applied;
  if (!caseDate) return null;

  const permitNum = (row["Permit Num"] ?? row["permit_number"] ?? "").trim();
  if (!permitNum) return null;

  const domain = classifyAustinPermitDomain(row);
  const { label } = mapPermitOutcomeDetailed(
    row["Status Current"] ?? row["status"] ?? "",
    row["Work Class"] ?? "",
  );

  return {
    outcomeId: randomUUID(),
    subjectKey: `austin_tx:permit:${permitNum}`,
    caseDate,
    outcomeLabel: label,
    outcomeKind: "permit",
    editionInEffect: edition,
    jurisdictionTenant: "austin_tx",
    parcelKey: row["TCAD ID"]?.trim() || null,
    rawSource: row,
    scope: scopeFromPermitDomain(domain),
    provisionDomain: domain,
  };
}

export function normalizeAustinVarianceRow(
  row: Record<string, string>,
  edition: ResolvedEdition | null,
): NormalizedOutcomeRecord | null {
  const hearing = parseFlexibleDate(row["Hearing_Date"]);
  const applied = parseFlexibleDate(row["Applied_Date"]);
  const issued = parseFlexibleDate(row["Issued_Date"]);
  const caseDate = hearing ?? applied ?? issued;
  if (!caseDate) return null;

  const permitNumber = (row["Permit_Number"] ?? "").trim();
  const folderRsn = (row["Folderrsn"] ?? "").trim();
  const subject = permitNumber || folderRsn;
  if (!subject) return null;

  return {
    outcomeId: randomUUID(),
    subjectKey: `austin_tx:variance:${subject}`,
    caseDate,
    outcomeLabel: mapVarianceOutcome(row["Status_Current"] ?? ""),
    outcomeKind: "variance",
    editionInEffect: edition,
    jurisdictionTenant: "austin_tx",
    parcelKey: row["Appraisal_Id"]?.trim() || null,
    rawSource: row,
    scope: "local-code",
  };
}

export function normalizeSanAntonioPermitRow(
  row: Record<string, string>,
  edition: ResolvedEdition | null,
): NormalizedOutcomeRecord | null {
  const issued =
    parseFlexibleDate(row["ISSUEDATE"] ?? row["Issue Date"] ?? row["issue_date"]) ??
    parseFlexibleDate(row["PERMIT_DATE"]);
  if (!issued) return null;

  const permitId = (
    row["PERMIT"] ?? row["Permit Number"] ?? row["PERMIT_NUMBER"] ?? ""
  ).trim();
  if (!permitId) return null;

  const status = (row["STATUS"] ?? row["Status"] ?? "issued").trim();
  const domain = classifySanAntonioPermitDomain(row);

  return {
    outcomeId: randomUUID(),
    subjectKey: `san_antonio_tx:permit:${permitId}`,
    caseDate: issued,
    outcomeLabel: mapPermitOutcome(status, row["WORK_TYPE"] ?? ""),
    outcomeKind: "permit",
    editionInEffect: edition,
    jurisdictionTenant: "san_antonio_tx",
    parcelKey: row["PARCEL"]?.trim() || null,
    rawSource: row,
    scope: scopeFromPermitDomain(domain),
    provisionDomain: domain,
  };
}

export function normalizeSanAntonioVarianceRow(
  row: Record<string, string>,
  edition: ResolvedEdition | null,
): NormalizedOutcomeRecord | null {
  const caseDate =
    parseFlexibleDate(row["BOA Meeting Date"] ?? row["CASE_DATE"] ?? row["Case Date"]) ??
    parseFlexibleDate(row["Date Submitted"] ?? row["HEARING_DATE"]);
  if (!caseDate) return null;

  const caseNum = (
    row["Case Number"] ?? row["CASE_NUMBER"] ?? row["Case Number"] ?? ""
  ).trim();
  if (!caseNum) return null;

  const disposition = (
    row["Request Status"] ?? row["DISPOSITION"] ?? row["Disposition"] ?? ""
  ).trim();

  return {
    outcomeId: randomUUID(),
    subjectKey: `san_antonio_tx:variance:${caseNum}`,
    caseDate,
    outcomeLabel: mapVarianceOutcome(disposition || "variance"),
    outcomeKind: "variance",
    editionInEffect: edition,
    jurisdictionTenant: "san_antonio_tx",
    parcelKey: null,
    rawSource: row,
    scope: "local-code",
  };
}

/** Parse a single CSV line respecting quoted fields. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsvToRecords(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]!);
  const records: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] ?? "";
    }
    records.push(row);
  }
  return records;
}
