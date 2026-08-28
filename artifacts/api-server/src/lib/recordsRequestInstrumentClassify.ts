/**
 * P-85 WDLL item 8 — document type routing for Records Request artifacts.
 *
 * ADR-020 primary types are used where the enum supports them; deed-like kinds
 * land as instrumentType `other` + extractMetadata.documentKind until substrate
 * extends the enum (_inbox/2026-08-26_substrate_request_p85_adr020_instrument_type_extension.md).
 */

export const RECORDS_REQUEST_SOURCE_ADAPTER = "records-request-v1" as const;

export type RecordsRequestDocumentKind =
  | "deed"
  | "deed-of-trust"
  | "release"
  | "notice"
  | "affidavit"
  | "memorandum-of-lease"
  | "mineral-or-royalty"
  | "power-of-attorney"
  | "unclassified";

export type RecordsRequestInstrumentType =
  | "easement"
  | "plat-restriction"
  | "cc-r-declaration"
  | "deed-restriction"
  | "lien"
  | "other";

export interface RecordsRequestTypeRoute {
  instrumentType: RecordsRequestInstrumentType;
  /** Required when instrumentType is `other`. Includes `unclassified`. */
  documentKind?: RecordsRequestDocumentKind;
  /** When true, restriction_clauses rows are written from extracted text. */
  extractsClauses: boolean;
  /** Portal label as published, never normalized. Set when a kind is written. */
  sourceDocumentType?: string;
}

export class RecordsRequestClassifyRefuseError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "RecordsRequestClassifyRefuseError";
    this.code = code;
  }
}

function normalizeDocType(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Map portal index document type labels to ADR-020 routing. */
export function classifyRecordsRequestDocumentType(
  documentType: string | null | undefined,
): RecordsRequestTypeRoute {
  const sourceDocumentType =
    typeof documentType === "string" ? documentType.trim() : "";
  const dt = normalizeDocType(documentType);

  if (!dt) {
    throw new RecordsRequestClassifyRefuseError(
      "unclassifiable_document_type",
      "Document type is absent; refuse rather than invent a kind",
    );
  }

  if (/EASEMENT|RIGHT.?OF.?WAY|ROW\b|UTILITY/.test(dt)) {
    return { instrumentType: "easement", extractsClauses: true };
  }
  if (/PLAT|SUBDIVISION/.test(dt)) {
    return { instrumentType: "plat-restriction", extractsClauses: true };
  }
  if (/CC.?&.?R|COVENANT|DECLARATION OF COVENANT|RESTRICTION DECLARATION/.test(dt)) {
    return { instrumentType: "cc-r-declaration", extractsClauses: true };
  }
  if (/DEED RESTRICTION|RESTRICTIVE COVENANT/.test(dt)) {
    return { instrumentType: "deed-restriction", extractsClauses: true };
  }
  if (/LIEN|TAX LIEN|MECHANIC/.test(dt)) {
    return { instrumentType: "lien", extractsClauses: false };
  }
  if (/DEED OF TRUST|MORTGAGE|DOT\b/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "deed-of-trust",
      extractsClauses: false,
    };
  }
  if (/RELEASE|RECONVEYANCE|SATISFACTION/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "release",
      extractsClauses: false,
    };
  }
  if (/LIS PENDENS|NOTICE|TRUSTEE SALE|ASSOCIATION NOTICE/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "notice",
      extractsClauses: false,
    };
  }
  if (/AFFIDAVIT/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "affidavit",
      extractsClauses: false,
    };
  }
  if (/MEMORANDUM OF LEASE|MEMO.*LEASE/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "memorandum-of-lease",
      extractsClauses: false,
    };
  }
  if (/MINERAL|ROYALTY/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "mineral-or-royalty",
      extractsClauses: false,
    };
  }
  if (/POWER OF ATTORNEY|POA\b/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "power-of-attorney",
      extractsClauses: false,
    };
  }
  if (/DEED\b|WARRANTY DEED|SPECIAL WARRANTY|QUITCLAIM/.test(dt)) {
    return {
      instrumentType: "other",
      documentKind: "deed",
      extractsClauses: false,
      sourceDocumentType,
    };
  }

  return {
    instrumentType: "other",
    documentKind: "unclassified",
    extractsClauses: false,
    sourceDocumentType,
  };
}

export function assertRecordsRequestInstrumentWritable(input: {
  recordingRef: string | null | undefined;
  hasImage: boolean;
}): void {
  const ref = input.recordingRef?.trim();
  if (!ref && !input.hasImage) {
    throw new RecordsRequestClassifyRefuseError(
      "missing_recording_ref_and_image",
      "Instrument refuses without recording reference and without image bytes",
    );
  }
}

export function assertRecordsRequestClauseWritable(clause: {
  sourceCitation: string | null | undefined;
}): void {
  if (!clause.sourceCitation?.trim()) {
    throw new RecordsRequestClassifyRefuseError(
      "clause_missing_source_citation",
      "Clause refuses without sourceCitation",
    );
  }
}

export function assertDocumentKindWhenOther(route: RecordsRequestTypeRoute): void {
  if (route.instrumentType === "other" && !route.documentKind) {
    throw new RecordsRequestClassifyRefuseError(
      "other_without_document_kind",
      "instrumentType other requires documentKind",
    );
  }
}

export interface RecordsRequestHeaderFacts {
  parties: string | null;
  recordingDate: string | null;
  recordingRef: string | null;
  documentType: string | null;
  /** Dollar amounts or stated balances parsed from vision text. */
  statedAmounts: string[];
  /** Cross-referenced instrument numbers when present in text. */
  crossReferences: string[];
}

const AMOUNT_RE =
  /\$\s*[\d,]+(?:\.\d{2})?|\b(?:amount|principal|balance)\s*[:\s]*\$?\s*[\d,]+(?:\.\d{2})?/gi;
const CROSS_REF_RE =
  /\b(?:instrument|doc(?:ument)?|file)\s*(?:no\.?|number|#)\s*[:\s]*([A-Z0-9-]+)/gi;

/** Header facts for deed/lien/header-only types (parties from index + vision text). */
export function extractRecordsRequestHeaderFacts(input: {
  parties: string | null | undefined;
  recordingDate: string | null | undefined;
  recordingRef: string | null | undefined;
  documentType: string | null | undefined;
  visionText?: string | null;
}): RecordsRequestHeaderFacts {
  const text = input.visionText ?? "";
  const statedAmounts = [...text.matchAll(AMOUNT_RE)].map((m) => m[0].trim());
  const crossReferences: string[] = [];
  for (const m of text.matchAll(CROSS_REF_RE)) {
    const ref = m[1]?.trim();
    if (ref) crossReferences.push(ref);
  }

  return {
    parties: input.parties?.trim() ?? null,
    recordingDate: input.recordingDate?.trim() ?? null,
    recordingRef: input.recordingRef?.trim() ?? null,
    documentType: input.documentType?.trim() ?? null,
    statedAmounts: [...new Set(statedAmounts)].slice(0, 8),
    crossReferences: [...new Set(crossReferences)].slice(0, 8),
  };
}
