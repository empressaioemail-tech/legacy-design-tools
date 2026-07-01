import type { ReadContract } from "@hauska/atom-contract/read-contract";
import {
  readContractFromExtractConfidence,
  readContractForWire,
  assertedExtractConfidence,
  widthedConfidenceScalar,
} from "@workspace/engine-core";
import {
  RECORDED_INSTRUMENT_SCHEMA,
  RESTRICTION_CLAUSE_SCHEMA,
  type RecordedInstrumentAtomInstance,
  type RestrictionClauseAtomInstance,
} from "@hauska/atom-contract/encumbrances";
import type { RecordedInstrument, RestrictionClause } from "@workspace/db";

export interface EncumbranceInstrumentWire {
  id: string;
  engagementId: string | null;
  listingKey?: string | null;
  installId?: string | null;
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
  /** @deprecated Use readContract */
  confidence: number;
  readContract: ReadContract;
  reasoningSummary: string | null;
  sourceCitation: string;
  humanVerifiedAt: string | null;
  instrumentType: string;
  sourceDocumentUrl: string;
  evaluatedAt: string;
}

export interface PrivateRestrictionsBriefing {
  summary: string;
  /** @deprecated Use readContract */
  confidence: number;
  readContract: ReadContract;
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
    confidence: assertedExtractConfidence(
      Number(row.confidence),
      row.humanVerifiedAt ? 1 : 0,
    ),
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
  return parsed.data as RestrictionClauseAtomInstance;
}

export function pdfServeUrl(objectPath: string): string {
  const entity = objectPath.startsWith("/objects/")
    ? objectPath.slice("/objects/".length)
    : objectPath.replace(/^\/+/, "");
  return `/api/storage/objects/${entity}`;
}

export function formatPrivateRestrictionsForLlm(
  briefing: PrivateRestrictionsBriefing | null | undefined,
): string {
  if (!briefing?.items.length) return "";

  const lines = briefing.items.slice(0, 8).map(
    (item, i) =>
      `- [P${i + 1}] ${item.clausePath}: ${item.bodyText.slice(0, 400)} (${item.sourceCitation})`,
  );

  return [
    "Private recorded restrictions (CC&Rs / deed limits — NOT municipal code):",
    briefing.summary,
    ...lines,
  ].join("\n");
}

export function buildPrivateRestrictionsBriefing(
  instruments: EncumbranceInstrumentWire[],
  clauses: EncumbranceClauseWire[],
): PrivateRestrictionsBriefing | null {
  if (clauses.length === 0) return null;

  const items: PrivateRestrictionBriefingItem[] = clauses.map((c) => {
    const inst = instruments.find((i) => i.id === c.instrumentId);
    const confidence = widthedConfidenceScalar(c.clause.confidence);
    const readContract = readContractForWire(
      readContractFromExtractConfidence(confidence, {
        humanVerified: !!c.clause.humanVerifiedAt,
        assembledAt: c.clause.evaluatedAt,
      }),
    );
    return {
      clauseId: c.id,
      instrumentId: c.instrumentId,
      clausePath: c.clause.clausePath,
      bodyText: c.clause.bodyText,
      legalWeight: c.clause.legalWeight,
      confidence,
      readContract,
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
  const aggregateReadContract = readContractForWire(
    readContractFromExtractConfidence(avgConfidence, {
      n: verifiedCount,
      assembledAt: latestEval,
    }),
  );

  return {
    summary: [
      `${items.length} recorded restriction clause(s) from ${instruments.length} uploaded instrument(s).`,
      "These are private recorded encumbrances — not municipal code.",
      verifiedCount > 0
        ? `${verifiedCount} clause(s) human-verified.`
        : "No clauses human-verified yet; treat as machine-extracted until reviewed.",
    ].join(" "),
    confidence: Math.round(avgConfidence * 1000) / 1000,
    readContract: aggregateReadContract,
    evaluatedAt: latestEval,
    items,
  };
}
