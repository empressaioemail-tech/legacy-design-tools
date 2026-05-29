import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  recordedInstruments,
  restrictionClauses,
} from "@workspace/db";
import {
  extractEncumbranceClausesFromPdf,
  mintClauseDid,
  mintInstrumentDid,
  sourceDocumentCidFromObjectPath,
} from "./encumbranceExtract";
import { ObjectStorageService } from "./objectStorage";
import type { ParsedPdfUpload } from "./encumbranceMultipart";
import {
  pdfServeUrl,
  rowToRecordedInstrumentAtom,
  rowToRestrictionClauseAtom,
  type EncumbranceClauseWire,
  type EncumbranceInstrumentWire,
  type EncumbrancesListWire,
} from "./encumbranceWire";

export type { ParsedPdfUpload };

let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

function wireInstrumentRow(
  row: typeof recordedInstruments.$inferSelect,
): EncumbranceInstrumentWire {
  return {
    id: row.id,
    engagementId: row.engagementId,
    listingKey: row.listingKey,
    installId: row.installId,
    instrument: rowToRecordedInstrumentAtom(row),
    sourceObjectPath: row.sourceObjectPath,
    pdfUrl: pdfServeUrl(row.sourceObjectPath),
    uploadOriginalFilename: row.uploadOriginalFilename,
    uploadContentType: row.uploadContentType,
    uploadByteSize: row.uploadByteSize,
    extractMetadata: (row.extractMetadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadEncumbrancesFromInstrumentRows(
  instrumentRows: Array<typeof recordedInstruments.$inferSelect>,
): Promise<EncumbrancesListWire> {
  if (instrumentRows.length === 0) {
    return { instruments: [], clauses: [] };
  }

  const instrumentIds = instrumentRows.map((r) => r.id);
  const clauseRows = await db
    .select()
    .from(restrictionClauses)
    .where(inArray(restrictionClauses.instrumentId, instrumentIds))
    .orderBy(desc(restrictionClauses.createdAt));

  return {
    instruments: instrumentRows.map(wireInstrumentRow),
    clauses: clauseRows.map((row) => ({
      id: row.id,
      instrumentId: row.instrumentId,
      clause: rowToRestrictionClauseAtom(row),
      sourcePage: row.sourcePage,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function loadEncumbrancesForEngagement(
  engagementId: string,
): Promise<EncumbrancesListWire> {
  const instrumentRows = await db
    .select()
    .from(recordedInstruments)
    .where(eq(recordedInstruments.engagementId, engagementId))
    .orderBy(desc(recordedInstruments.createdAt));

  return loadEncumbrancesFromInstrumentRows(instrumentRows);
}

export async function loadEncumbrancesForBrokerageWorkspace(input: {
  installId: string;
  listingKey: string;
}): Promise<EncumbrancesListWire> {
  const instrumentRows = await db
    .select()
    .from(recordedInstruments)
    .where(
      and(
        eq(recordedInstruments.installId, input.installId),
        eq(recordedInstruments.listingKey, input.listingKey),
      ),
    )
    .orderBy(desc(recordedInstruments.createdAt));

  return loadEncumbrancesFromInstrumentRows(instrumentRows);
}

export async function ingestEncumbrancePdfUpload(input: {
  upload: ParsedPdfUpload;
  scope:
    | { kind: "engagement"; engagementId: string }
    | { kind: "brokerage"; installId: string; listingKey: string };
}): Promise<EncumbrancesListWire> {
  const extract = await extractEncumbranceClausesFromPdf(input.upload.bytes);
  const objectPath = await objectStorage().uploadObjectEntityFromBuffer(
    input.upload.bytes,
    input.upload.contentType,
  );
  const sourceDocumentCid = sourceDocumentCidFromObjectPath(objectPath);
  const scopeKey =
    input.scope.kind === "engagement"
      ? input.scope.engagementId
      : `${input.scope.installId}:${input.scope.listingKey}`;
  const instrumentDid = mintInstrumentDid(scopeKey);
  const extractedAt = new Date(extract.metadata.extractedAt);

  const appliesTo =
    input.scope.kind === "engagement"
      ? { legalDescription: `Engagement ${input.scope.engagementId}` }
      : {
          legalDescription: `Property workspace ${input.scope.listingKey}`,
          listingKey: input.scope.listingKey,
        };

  const [instrument] = await db
    .insert(recordedInstruments)
    .values({
      engagementId:
        input.scope.kind === "engagement" ? input.scope.engagementId : null,
      listingKey:
        input.scope.kind === "brokerage" ? input.scope.listingKey : null,
      installId: input.scope.kind === "brokerage" ? input.scope.installId : null,
      instrumentDid,
      instrumentType: "other",
      recording: null,
      issuerActorDid: "did:hauska:actor:engagement-upload",
      sourceDocumentCid,
      appliesTo,
      accessPolicy: "tenant-private",
      legalWeight: "recorded",
      verificationStatus: "machine",
      extractedAt,
      sourceAdapter: "R4",
      sourceObjectPath: objectPath,
      uploadOriginalFilename: input.upload.filename,
      uploadContentType: input.upload.contentType,
      uploadByteSize: input.upload.bytes.length,
      extractMetadata: extract.metadata,
    })
    .returning();

  const clauseValues = extract.clauses.map((c, index) => ({
    instrumentId: instrument!.id,
    clauseDid: mintClauseDid(instrumentDid, index),
    parentInstrumentCid: sourceDocumentCid,
    clausePath: c.clausePath,
    bodyText: c.bodyText,
    confidence: String(c.confidence),
    extractedBy: extract.metadata.documentModel,
    accessPolicy: "tenant-private",
    legalWeight: "recorded",
    reasoningSummary: c.reasoningSummary,
    sourceCitation: c.sourceCitation,
    evaluatedAt: extractedAt,
    sourcePage: c.sourcePage,
  }));

  if (clauseValues.length > 0) {
    await db.insert(restrictionClauses).values(clauseValues);
  }

  if (input.scope.kind === "engagement") {
    return loadEncumbrancesForEngagement(input.scope.engagementId);
  }
  return loadEncumbrancesForBrokerageWorkspace({
    installId: input.scope.installId,
    listingKey: input.scope.listingKey,
  });
}
