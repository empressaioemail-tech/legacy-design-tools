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
import {
  readContractForWire,
  readContractFromExtractConfidence,
} from "@workspace/engine-core";

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
    clauses: clauseRows.map((row) => {
      const atom = rowToRestrictionClauseAtom(row);
      return {
        id: row.id,
        instrumentId: row.instrumentId,
        clause: {
          ...atom,
          readContract: readContractForWire(
            readContractFromExtractConfidence(atom.confidence, {
              humanVerified: !!atom.humanVerifiedAt,
              assembledAt: atom.evaluatedAt,
            }),
          ),
        },
        sourcePage: row.sourcePage,
        createdAt: row.createdAt.toISOString(),
      };
    }),
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
  return persistEncumbranceExtract({
    extract,
    objectPath,
    upload: input.upload,
    scope: input.scope,
  });
}

/** Ingest after client PUT to a presigned GCS URL (plan-review pattern). */
export async function ingestEncumbrancePresignedUpload(input: {
  objectPath: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  scope:
    | { kind: "engagement"; engagementId: string }
    | { kind: "brokerage"; installId: string; listingKey: string };
}): Promise<EncumbrancesListWire> {
  const extract = await extractEncumbranceClausesFromPdf(input.bytes);
  return persistEncumbranceExtract({
    extract,
    objectPath: input.objectPath,
    upload: {
      bytes: input.bytes,
      filename: input.filename,
      contentType: input.contentType,
    },
    scope: input.scope,
  });
}

async function persistEncumbranceExtract(input: {
  extract: Awaited<ReturnType<typeof extractEncumbranceClausesFromPdf>>;
  objectPath: string;
  upload: Pick<ParsedPdfUpload, "bytes" | "filename" | "contentType">;
  scope:
    | { kind: "engagement"; engagementId: string }
    | { kind: "brokerage"; installId: string; listingKey: string };
}): Promise<EncumbrancesListWire> {
  const { extract, objectPath, upload, scope } = input;
  const sourceDocumentCid = sourceDocumentCidFromObjectPath(objectPath);
  const scopeKey =
    scope.kind === "engagement"
      ? scope.engagementId
      : `${scope.installId}:${scope.listingKey}`;
  const instrumentDid = mintInstrumentDid(scopeKey);
  const extractedAt = new Date(extract.metadata.extractedAt);

  const appliesTo =
    scope.kind === "engagement"
      ? { legalDescription: `Engagement ${scope.engagementId}` }
      : {
          legalDescription: `Property workspace ${scope.listingKey}`,
          listingKey: scope.listingKey,
        };

  const [instrument] = await db
    .insert(recordedInstruments)
    .values({
      engagementId: scope.kind === "engagement" ? scope.engagementId : null,
      listingKey: scope.kind === "brokerage" ? scope.listingKey : null,
      installId: scope.kind === "brokerage" ? scope.installId : null,
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
      uploadOriginalFilename: upload.filename,
      uploadContentType: upload.contentType,
      uploadByteSize: upload.bytes.length,
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

  if (scope.kind === "engagement") {
    return loadEncumbrancesForEngagement(scope.engagementId);
  }
  return loadEncumbrancesForBrokerageWorkspace({
    installId: scope.installId,
    listingKey: scope.listingKey,
  });
}
