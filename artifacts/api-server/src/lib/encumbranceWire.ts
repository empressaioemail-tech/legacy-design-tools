import {
  RECORDED_INSTRUMENT_SCHEMA,
  RESTRICTION_CLAUSE_SCHEMA,
  type RecordedInstrumentAtomInstance,
  type RestrictionClauseAtomInstance,
} from "@hauska/atom-contract/encumbrances";
import type { RecordedInstrument, RestrictionClause } from "@workspace/db";

export interface EncumbranceInstrumentWire {
  id: string;
  engagementId: string;
  instrument: RecordedInstrumentAtomInstance;
  sourceObjectPath: string;
  pdfUrl: string;
  uploadOriginalFilename: string | null;
  uploadContentType: string | null;
  uploadByteSize: number | null;
  extractMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface EncumbranceClauseWire {
  id: string;
  instrumentId: string;
  clause: RestrictionClauseAtomInstance;
  sourcePage: number | null;
  createdAt: string;
}

export interface EncumbrancesListWire {
  instruments: EncumbranceInstrumentWire[];
  clauses: EncumbranceClauseWire[];
}

export interface PrivateRestrictionBriefingItem {
  clauseId: string;
  instrumentId: string;
  clausePath: string;
  bodyText: string;
  legalWeight: "recorded" | "advisory";
  confidence: number;
  reasoningSummary: string | null;
  sourceCitation: string;
  humanVerifiedAt: string | null;
  instrumentType: string;
  sourceDocumentUrl: string;
  evaluatedAt: string;
}

export interface PrivateRestrictionsBriefing {
  summary: string;
  confidence: number;
  evaluatedAt: string;
  items: PrivateRestrictionBriefingItem[];
}

export function rowToRecordedInstrumentAtom(
  row: RecordedInstrument,
): RecordedInstrumentAtomInstance {
  const atom: RecordedInstrumentAtomInstance = {
    entityType: "recorded-instrument",
    instrumentDid: row.instrumentDid,
    instrumentType: row.instrumentType as RecordedInstrumentAtomInstance["instrumentType"],
    recording: row.recording as RecordedInstrumentAtomInstance["recording"],
    issuerActorDid: row.issuerActorDid,
    sourceDocumentCid: row.sourceDocumentCid,
    appliesTo: row.appliesTo as RecordedInstrumentAtomInstance["appliesTo"],
    accessPolicy: row.accessPolicy as RecordedInstrumentAtomInstance["accessPolicy"],
    legalWeight: "recorded",
    verificationStatus:
      row.verificationStatus as RecordedInstrumentAtomInstance["verificationStatus"],
    extractedAt: row.extractedAt.toISOString(),
    sourceAdapter: row.sourceAdapter as RecordedInstrumentAtomInstance["sourceAdapter"],
  };
  const parsed = RECORDED_INSTRUMENT_SCHEMA.safeParse(atom);
  if (!parsed.success) {
    throw new Error(`recorded_instrument_schema_invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function rowToRestrictionClauseAtom(
  row: RestrictionClause,
): RestrictionClauseAtomInstance {
  const atom: RestrictionClauseAtomInstance = {
    entityType: "restriction-clause",
    clauseDid: row.clauseDid,
    parentInstrumentCid: row.parentInstrumentCid,
    clausePath: row.clausePath,
    bodyText: row.bodyText,
    structuredFields:
      (row.structuredFields as RestrictionClauseAtomInstance["structuredFields"]) ??
      undefined,
    confidence: Number(row.confidence),
    extractedBy: row.extractedBy,
    humanVerifiedAt: row.humanVerifiedAt?.toISOString(),
    verifiedByActorDid: row.verifiedByActorDid ?? undefined,
    accessPolicy: row.accessPolicy as RestrictionClauseAtomInstance["accessPolicy"],
    legalWeight: "recorded",
    reasoningSummary: row.reasoningSummary ?? undefined,
    sourceCitation: row.sourceCitation,
    evaluatedAt: row.evaluatedAt.toISOString(),
  };
  const parsed = RESTRICTION_CLAUSE_SCHEMA.safeParse(atom);
  if (!parsed.success) {
    throw new Error(`restriction_clause_schema_invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function pdfServeUrl(objectPath: string): string {
  const entity = objectPath.startsWith("/objects/")
    ? objectPath.slice("/objects/".length)
    : objectPath.replace(/^\/+/, "");
  return `/api/storage/objects/${entity}`;
}

export function buildPrivateRestrictionsBriefing(
  instruments: EncumbranceInstrumentWire[],
  clauses: EncumbranceClauseWire[],
): PrivateRestrictionsBriefing | null {
  if (clauses.length === 0) return null;

  const items: PrivateRestrictionBriefingItem[] = clauses.map((c) => {
    const inst = instruments.find((i) => i.id === c.instrumentId);
    return {
      clauseId: c.id,
      instrumentId: c.instrumentId,
      clausePath: c.clause.clausePath,
      bodyText: c.clause.bodyText,
      legalWeight: c.clause.legalWeight,
      confidence: c.clause.confidence,
      reasoningSummary: c.clause.reasoningSummary ?? null,
      sourceCitation: c.clause.sourceCitation,
      humanVerifiedAt: c.clause.humanVerifiedAt ?? null,
      instrumentType: inst?.instrument.instrumentType ?? "other",
      sourceDocumentUrl: inst?.pdfUrl ?? "",
      evaluatedAt: c.clause.evaluatedAt,
    };
  });

  const avgConfidence =
    items.reduce((s, i) => s + i.confidence, 0) / Math.max(items.length, 1);
  const latestEval = items
    .map((i) => i.evaluatedAt)
    .sort()
    .at(-1)!;
  const verifiedCount = items.filter((i) => i.humanVerifiedAt).length;

  return {
    summary: [
      `${items.length} recorded restriction clause(s) from ${instruments.length} uploaded instrument(s).`,
      "These are private recorded encumbrances — not municipal code.",
      verifiedCount > 0
        ? `${verifiedCount} clause(s) human-verified.`
        : "No clauses human-verified yet; treat as machine-extracted until reviewed.",
    ].join(" "),
    confidence: Math.round(avgConfidence * 1000) / 1000,
    evaluatedAt: latestEval,
    items,
  };
}
