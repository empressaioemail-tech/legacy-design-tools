/**
 * P-85 WDLL item 8 — classify artifacts and write recorded_instruments rows.
 */

import { eq } from "drizzle-orm";
import {
  db,
  recordedInstruments,
  recordsRequestArtifacts,
  recordsRequestJobs,
  restrictionClauses,
  type RecordsRequestArtifact,
  type RecordsRequestJob,
} from "@workspace/db";
import {
  ENCUMBRANCE_EXTRACT_MODEL,
  ENCUMBRANCE_EXTRACT_VERSION,
  extractClauseCandidatesFromPlainText,
  mintClauseDid,
  mintInstrumentDid,
  sourceDocumentCidFromObjectPath,
} from "./encumbranceExtract";
import { clerkPortalsForCounty } from "./p85ClerkPortalRegistry";
import {
  assertDocumentKindWhenOther,
  assertRecordsRequestClauseWritable,
  assertRecordsRequestInstrumentWritable,
  classifyRecordsRequestDocumentType,
  extractRecordsRequestHeaderFacts,
  RECORDS_REQUEST_SOURCE_ADAPTER,
  RecordsRequestClassifyRefuseError,
  type RecordsRequestHeaderFacts,
} from "./recordsRequestInstrumentClassify";

export const RECORDS_REQUEST_CLASSIFY_MODEL = "records-request-classify-v1";

export type ArtifactClassifyStatus = "written" | "refused" | "skipped";

export interface ArtifactClassifyResult {
  artifactId: string;
  status: ArtifactClassifyStatus;
  instrumentId?: string;
  clauseCount?: number;
  instrumentType?: string;
  documentKind?: string;
  refuseCode?: string;
  refuseMessage?: string;
}

function artifactHasImage(artifact: RecordsRequestArtifact): boolean {
  if (artifact.storagePath?.trim()) return true;
  const meta =
    artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
      ? (artifact.metadata as Record<string, unknown>)
      : null;
  const b64 = meta?.capturePngBase64;
  return typeof b64 === "string" && b64.trim().length > 0;
}

function visionTextFromArtifact(artifact: RecordsRequestArtifact): string | null {
  const meta =
    artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
      ? (artifact.metadata as Record<string, unknown>)
      : null;
  const visionRead = meta?.visionRead;
  if (!visionRead || typeof visionRead !== "object" || Array.isArray(visionRead)) {
    return null;
  }
  const extracted = (visionRead as Record<string, unknown>).extractedText;
  return typeof extracted === "string" && extracted.trim() ? extracted : null;
}

function sourceDocumentCidForArtifact(artifact: RecordsRequestArtifact): string {
  if (artifact.storagePath?.trim()) {
    return sourceDocumentCidFromObjectPath(artifact.storagePath);
  }
  return `records-request:sha256:${artifact.contentSha256}`;
}

function recordingForArtifact(
  artifact: RecordsRequestArtifact,
  job: RecordsRequestJob,
): Record<string, string> {
  const countyName =
    clerkPortalsForCounty(job.countyFips)[0]?.countyName ?? `FIPS ${job.countyFips}`;
  const recording: Record<string, string> = {
    county: countyName,
    state: "TX",
  };
  if (artifact.recordingRef?.trim()) {
    recording.instrumentNumber = artifact.recordingRef.trim();
  }
  if (artifact.recordingDate?.trim()) {
    recording.recordedAt = artifact.recordingDate.trim();
  }
  return recording;
}

function appliesToForJob(job: RecordsRequestJob): Record<string, unknown> {
  const payload =
    job.requestPayload && typeof job.requestPayload === "object" && !Array.isArray(job.requestPayload)
      ? (job.requestPayload as Record<string, unknown>)
      : {};
  const legalDescription =
    typeof payload.legalDescription === "string" ? payload.legalDescription : undefined;
  return {
    parcelKey: job.parcelKey,
    legalDescription:
      legalDescription ?? `Parcel ${job.parcelKey} (${job.countyFips})`,
  };
}

async function artifactAlreadyClassified(
  engagementId: string,
  artifactId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      id: recordedInstruments.id,
      extractMetadata: recordedInstruments.extractMetadata,
    })
    .from(recordedInstruments)
    .where(eq(recordedInstruments.engagementId, engagementId));
  for (const row of rows) {
    const meta = row.extractMetadata as Record<string, unknown> | null;
    if (meta?.recordsRequestArtifactId === artifactId) {
      return row.id;
    }
  }
  return null;
}

async function mergeArtifactClassifyMetadata(
  artifactId: string,
  classify: Record<string, unknown>,
): Promise<void> {
  const rows = await db
    .select({ metadata: recordsRequestArtifacts.metadata })
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.id, artifactId))
    .limit(1);
  const prior = rows[0]?.metadata;
  const base =
    prior && typeof prior === "object" && !Array.isArray(prior)
      ? (prior as Record<string, unknown>)
      : {};
  await db
    .update(recordsRequestArtifacts)
    .set({
      metadata: {
        ...base,
        classify,
      },
    })
    .where(eq(recordsRequestArtifacts.id, artifactId));
}

export async function classifyAndWriteRecordsRequestArtifact(input: {
  artifact: RecordsRequestArtifact;
  job: RecordsRequestJob;
}): Promise<ArtifactClassifyResult> {
  const { artifact, job } = input;
  const artifactId = artifact.id;

  try {
    assertRecordsRequestInstrumentWritable({
      recordingRef: artifact.recordingRef,
      hasImage: artifactHasImage(artifact),
    });

    const existingId = await artifactAlreadyClassified(job.engagementId, artifactId);
    if (existingId) {
      return {
        artifactId,
        status: "skipped",
        instrumentId: existingId,
        refuseCode: "already_classified",
      };
    }

    const route = classifyRecordsRequestDocumentType(artifact.documentType);
    assertDocumentKindWhenOther(route);

    const visionText = visionTextFromArtifact(artifact);
    const headerFacts: RecordsRequestHeaderFacts = extractRecordsRequestHeaderFacts({
      parties: artifact.parties,
      recordingDate: artifact.recordingDate,
      recordingRef: artifact.recordingRef,
      documentType: artifact.documentType,
      visionText,
    });

    const extractedAt = new Date();
    const sourceDocumentCid = sourceDocumentCidForArtifact(artifact);
    const instrumentDid = mintInstrumentDid(`${job.engagementId}:${artifactId}`);
    const recording = recordingForArtifact(artifact, job);
    const appliesTo = appliesToForJob(job);

    const extractMetadata: Record<string, unknown> = {
      documentModel: RECORDS_REQUEST_CLASSIFY_MODEL,
      documentModelVersion: "1.0.0",
      extractedAt: extractedAt.toISOString(),
      recordsRequestArtifactId: artifactId,
      recordsRequestJobId: job.id,
      portalId: artifact.portalId,
      acquisitionMethod: artifact.acquisitionMethod,
      headerFacts,
      ...(route.documentKind ? { documentKind: route.documentKind } : {}),
      ...(route.sourceDocumentType
        ? { sourceDocumentType: route.sourceDocumentType }
        : {}),
      visionTextPresent: !!visionText,
    };

    const [instrument] = await db
      .insert(recordedInstruments)
      .values({
        engagementId: job.engagementId,
        listingKey: null,
        installId: null,
        instrumentDid,
        instrumentType: route.instrumentType,
        recording,
        issuerActorDid: "did:hauska:actor:records-request-v1",
        sourceDocumentCid,
        appliesTo,
        accessPolicy: "tenant-private",
        legalWeight: "recorded",
        verificationStatus: "machine",
        extractedAt,
        sourceAdapter: RECORDS_REQUEST_SOURCE_ADAPTER,
        sourceObjectPath: artifact.storagePath ?? `/records-request/${artifact.contentSha256}`,
        uploadOriginalFilename: artifact.recordingRef ?? artifact.documentType,
        uploadContentType: artifact.storagePath ? "application/pdf" : "image/png",
        uploadByteSize: artifact.byteSize,
        extractMetadata,
      })
      .returning();

    let clauseCount = 0;
    if (route.extractsClauses && visionText) {
      const pageCount = Math.max(1, Math.ceil(visionText.length / 3000));
      const candidates = extractClauseCandidatesFromPlainText(visionText, pageCount);
      const clauseValues = candidates.map((c, index) => {
        assertRecordsRequestClauseWritable(c);
        return {
          instrumentId: instrument!.id,
          clauseDid: mintClauseDid(instrumentDid, index),
          parentInstrumentCid: sourceDocumentCid,
          clausePath: c.clausePath,
          bodyText: c.bodyText,
          confidence: String(c.confidence),
          extractedBy: ENCUMBRANCE_EXTRACT_MODEL,
          accessPolicy: "tenant-private" as const,
          legalWeight: "recorded" as const,
          reasoningSummary: c.reasoningSummary,
          sourceCitation: c.sourceCitation,
          evaluatedAt: extractedAt,
          sourcePage: c.sourcePage,
        };
      });
      if (clauseValues.length > 0) {
        await db.insert(restrictionClauses).values(clauseValues);
        clauseCount = clauseValues.length;
      }
    }

    const result: ArtifactClassifyResult = {
      artifactId,
      status: "written",
      instrumentId: instrument!.id,
      clauseCount,
      instrumentType: route.instrumentType,
      documentKind: route.documentKind,
    };

    await mergeArtifactClassifyMetadata(artifactId, {
      status: "written",
      instrumentId: instrument!.id,
      clauseCount,
      instrumentType: route.instrumentType,
      documentKind: route.documentKind ?? null,
      sourceDocumentType: route.sourceDocumentType ?? artifact.documentType ?? null,
      classifiedAt: extractedAt.toISOString(),
    });

    return result;
  } catch (err) {
    if (err instanceof RecordsRequestClassifyRefuseError) {
      await mergeArtifactClassifyMetadata(artifactId, {
        status: "refused",
        refuseCode: err.code,
        refuseMessage: err.message,
        classifiedAt: new Date().toISOString(),
      });
      return {
        artifactId,
        status: "refused",
        refuseCode: err.code,
        refuseMessage: err.message,
      };
    }
    throw err;
  }
}

export async function processRecordsRequestJobClassification(
  jobId: string,
): Promise<ArtifactClassifyResult[]> {
  const jobRows = await db
    .select()
    .from(recordsRequestJobs)
    .where(eq(recordsRequestJobs.id, jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) {
    throw new Error("records_request_job_not_found");
  }

  const artifacts = await db
    .select()
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.jobId, jobId));

  const results: ArtifactClassifyResult[] = [];
  for (const artifact of artifacts) {
    results.push(await classifyAndWriteRecordsRequestArtifact({ artifact, job }));
  }
  return results;
}

/** @internal test seam — validate clause batch before insert */
export function validateClauseBatchForWrite(
  clauses: Array<{ sourceCitation: string | null | undefined }>,
): void {
  for (const c of clauses) {
    assertRecordsRequestClauseWritable(c);
  }
}
