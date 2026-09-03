/**
 * P-113 — expose what P-85's Records Request pipeline already extracted.
 *
 * artifacts/api-server/src/lib/recordsRequestVisionRead.ts and
 * recordsRequestClassifyWrite.ts OCR every purchased courthouse document and
 * classify its instrument type, but merge the result onto
 * records_request_artifacts.metadata (visionRead / classify keys) with no
 * route that ever reads it back out. The existing job-status route
 * (GET /api/engagements/:id/records-request/:jobId, see
 * recordsRequestJobToWire in recordsRequestJobWorker.ts) is job-level only —
 * no artifacts array, no per-document field. This module is the read side:
 * it queries records_request_jobs / records_request_artifacts directly
 * (smartsite-mcp already depends on @workspace/db for exactly this shape of
 * read — see connection-record.ts, auth.ts, identity.ts), scoped to the
 * calling user, for one parcel.
 *
 * THREE-STATE RULE (never collapsed, per doc_repo ENFORCEMENT.md "absent,
 * zero, and unmeasured are different states"): a document's vision-read
 * state is reported as one of four literal values, not folded into a bit.
 *   - "pending": metadata.visionRead is absent — vision read has not run.
 *   - "complete": status "complete" in stored metadata — extractedText
 *     travels with it.
 *   - "failed": status "failed" — an attempt was made and produced no
 *     usable text (e.g. blank_capture, vision_read_produced_no_text).
 *     failureReason travels with it, extractedText never does.
 *   - "skipped": status "skipped" — no attempt was made at all (e.g.
 *     vision_client_unavailable). Kept distinct from "failed" rather than
 *     merged into it, because merging would hide WHY no text exists.
 * classifyState gets the identical treatment: pending | written | refused |
 * skipped, mirroring ArtifactClassifyStatus in
 * recordsRequestClassifyWrite.ts plus "pending" for metadata.classify
 * absent.
 *
 * GATING. Both exported handlers take an already-resolved
 * SmartsiteEntitlementSnapshot and call the EXISTING canRunStudioReport /
 * refuseStudioReport from ./entitlement.ts — the same helper tools.ts
 * already uses to gate run_report's Studio-tier siblings, and whose own doc
 * comment ("Studio deliverables … records package") already named this
 * exact use before this lane existed. This module adds no new copy of the
 * tier check; subscriptionTierGrantsStudio already has independent copies
 * in peEntitlement.ts and this package's entitlement.ts, and a further copy
 * here would be a fourth.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  db as defaultDb,
  recordsRequestArtifacts,
  recordsRequestJobs,
  type RecordsRequestArtifact,
  type RecordsRequestJob,
} from "@workspace/db";

import {
  canRunStudioReport,
  refuseStudioReport,
  type SmartsiteEntitlementSnapshot,
} from "./entitlement.js";
import { looksLikeParcelNodeId } from "./mcp-app.js";
import type { ToolResult } from "./tools-types.js";

/** Minimal shape of the drizzle client this module needs — lets tests
 * inject a real connection to an isolated database instead of the process
 * singleton, without mocking drizzle's query builder. */
export type RecordsExtractionDb = Pick<typeof defaultDb, "select">;

/** propertyExplorer.ts:1711 — `apn:${parcelNodeId}` is the established
 * records_request_jobs.parcelKey shape for a parcel node id. Mirrored here
 * (not imported: api-server is a separate package smartsite-mcp does not
 * depend on) rather than re-derived differently. */
export function parcelKeyFromParcelNodeId(parcelNodeId: string): string {
  return `apn:${parcelNodeId}`;
}

export type VisionReadState = "pending" | "complete" | "failed" | "skipped";
export type ClassifyState = "pending" | "written" | "refused" | "skipped";

interface VisionReadMetadata {
  status?: unknown;
  visionApplied?: unknown;
  failureReason?: unknown;
  extractedText?: unknown;
  readAt?: unknown;
}

interface ClassifyMetadata {
  status?: unknown;
  instrumentId?: unknown;
  clauseCount?: unknown;
  instrumentType?: unknown;
  documentKind?: unknown;
  sourceDocumentType?: unknown;
  refuseCode?: unknown;
  refuseMessage?: unknown;
  classifiedAt?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function visionReadMetadataOf(artifact: RecordsRequestArtifact): VisionReadMetadata | null {
  const meta = asRecord(artifact.metadata);
  return asRecord(meta?.visionRead);
}

function classifyMetadataOf(artifact: RecordsRequestArtifact): ClassifyMetadata | null {
  const meta = asRecord(artifact.metadata);
  return asRecord(meta?.classify);
}

/** Shared vision-read shaping. summaryOnly omits extractedText (list view);
 * the read (single-document) view carries it in full. */
export interface VisionReadView {
  readState: VisionReadState;
  visionApplied: boolean | null;
  failureReason: string | null;
  readAt: string | null;
  hasExtractedText: boolean;
  textLength: number | null;
  extractedText?: string | null;
}

function visionReadView(
  artifact: RecordsRequestArtifact,
  opts: { includeText: boolean },
): VisionReadView {
  const vr = visionReadMetadataOf(artifact);
  if (!vr) {
    return {
      readState: "pending",
      visionApplied: null,
      failureReason: null,
      readAt: null,
      hasExtractedText: false,
      textLength: null,
      ...(opts.includeText ? { extractedText: null } : {}),
    };
  }
  const status = vr.status;
  const readState: VisionReadState =
    status === "complete" || status === "failed" || status === "skipped"
      ? status
      : "pending";
  const extractedText = asString(vr.extractedText);
  return {
    readState,
    visionApplied: typeof vr.visionApplied === "boolean" ? vr.visionApplied : null,
    failureReason: asString(vr.failureReason),
    readAt: asString(vr.readAt),
    hasExtractedText: extractedText !== null,
    textLength: extractedText !== null ? extractedText.length : null,
    ...(opts.includeText ? { extractedText } : {}),
  };
}

export interface ClassifyView {
  classifyState: ClassifyState;
  instrumentId: string | null;
  clauseCount: number | null;
  instrumentType: string | null;
  documentKind: string | null;
  sourceDocumentType: string | null;
  refuseCode: string | null;
  refuseMessage: string | null;
  classifiedAt: string | null;
}

function classifyView(artifact: RecordsRequestArtifact): ClassifyView {
  const c = classifyMetadataOf(artifact);
  if (!c) {
    return {
      classifyState: "pending",
      instrumentId: null,
      clauseCount: null,
      instrumentType: null,
      documentKind: null,
      sourceDocumentType: null,
      refuseCode: null,
      refuseMessage: null,
      classifiedAt: null,
    };
  }
  const status = c.status;
  const classifyState: ClassifyState =
    status === "written" || status === "refused" || status === "skipped"
      ? status
      : "pending";
  return {
    classifyState,
    instrumentId: asString(c.instrumentId),
    clauseCount: typeof c.clauseCount === "number" ? c.clauseCount : null,
    instrumentType: asString(c.instrumentType),
    documentKind: asString(c.documentKind),
    sourceDocumentType: asString(c.sourceDocumentType),
    refuseCode: asString(c.refuseCode),
    refuseMessage: asString(c.refuseMessage),
    classifiedAt: asString(c.classifiedAt),
  };
}

function documentSummary(artifact: RecordsRequestArtifact) {
  return {
    artifactId: artifact.id,
    documentType: artifact.documentType,
    recordingRef: artifact.recordingRef,
    recordingDate: artifact.recordingDate,
    acquisitionMethod: artifact.acquisitionMethod,
    purchaseCostCents: artifact.purchaseCostCents,
    ...visionReadView(artifact, { includeText: false }),
    ...classifyView(artifact),
  };
}

function documentDetail(artifact: RecordsRequestArtifact) {
  return {
    artifactId: artifact.id,
    jobId: artifact.jobId,
    documentType: artifact.documentType,
    recordingRef: artifact.recordingRef,
    recordingDate: artifact.recordingDate,
    parties: artifact.parties,
    acquisitionMethod: artifact.acquisitionMethod,
    purchaseCostCents: artifact.purchaseCostCents,
    ...visionReadView(artifact, { includeText: true }),
    ...classifyView(artifact),
  };
}

function jobSummary(job: RecordsRequestJob) {
  return {
    jobId: job.id,
    jobStatus: job.status,
    countyFips: job.countyFips,
    runCost: job.runCost,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

function textResult(body: unknown, isError: boolean): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError,
  };
}

/** Same refusal body/wrapping tools.ts already uses for run_report via its
 * local upgradeRequiredResult — reused, not reinvented, here. */
function upgradeRequiredResult(entitlement: SmartsiteEntitlementSnapshot): ToolResult {
  return textResult(refuseStudioReport(entitlement), true);
}

function invalidParcelNodeIdResult(parcelNodeId: unknown): ToolResult {
  return textResult(
    {
      status: "refused",
      reason: "parcel_node_id_invalid",
      message:
        "parcelNodeId must be a county-fips:parcel-id string (e.g. 48453:R123456).",
      parcelNodeId,
    },
    true,
  );
}

export interface ListPurchasedRecordsArgs {
  parcelNodeId: string;
}

/**
 * list_purchased_records — one row per records-request job for this parcel
 * (scoped to the calling user via records_request_jobs.userId, the same
 * ownership column the existing job-status route checks), each carrying its
 * documents with read/classify STATE but never extractedText (kept out of
 * the list response on purpose — see module doc, response-size rationale in
 * CP1). An empty jobs array is a genuine positive result (the query ran,
 * scoped correctly, and found zero rows) — never conflated with a refusal
 * or an error.
 */
export async function listPurchasedRecords(
  entitlement: SmartsiteEntitlementSnapshot,
  userId: string,
  args: ListPurchasedRecordsArgs,
  deps?: { db?: RecordsExtractionDb },
): Promise<ToolResult> {
  if (!canRunStudioReport(entitlement)) {
    return upgradeRequiredResult(entitlement);
  }
  const parcelNodeId = args.parcelNodeId;
  if (typeof parcelNodeId !== "string" || !looksLikeParcelNodeId(parcelNodeId)) {
    return invalidParcelNodeIdResult(parcelNodeId);
  }

  const dbClient = deps?.db ?? defaultDb;
  const parcelKey = parcelKeyFromParcelNodeId(parcelNodeId);

  const jobs = await dbClient
    .select()
    .from(recordsRequestJobs)
    .where(
      and(
        eq(recordsRequestJobs.userId, userId),
        eq(recordsRequestJobs.parcelKey, parcelKey),
      ),
    )
    .orderBy(desc(recordsRequestJobs.createdAt));

  const jobsOut = [];
  for (const job of jobs as RecordsRequestJob[]) {
    const artifacts = await dbClient
      .select()
      .from(recordsRequestArtifacts)
      .where(eq(recordsRequestArtifacts.jobId, job.id))
      .orderBy(desc(recordsRequestArtifacts.createdAt));
    jobsOut.push({
      ...jobSummary(job),
      documents: (artifacts as RecordsRequestArtifact[]).map(documentSummary),
    });
  }

  return textResult(
    { status: "ok", parcelNodeId, parcelKey, jobs: jobsOut },
    false,
  );
}

export interface ReadPurchasedRecordArgs {
  parcelNodeId: string;
  artifactId: string;
}

/**
 * read_purchased_record — exactly one document, full extractedText and
 * classification detail. Re-derives ownership from the DB on every call
 * (artifact -> its job -> job.userId and job.parcelKey) rather than
 * trusting the caller's parcelNodeId as anything but an input to re-check;
 * a mismatch on either userId or parcelKey is indistinguishable from
 * "not found" in the response, so this tool never confirms or denies that
 * an artifact id exists for a parcel or account the caller does not own.
 */
export async function readPurchasedRecord(
  entitlement: SmartsiteEntitlementSnapshot,
  userId: string,
  args: ReadPurchasedRecordArgs,
  deps?: { db?: RecordsExtractionDb },
): Promise<ToolResult> {
  if (!canRunStudioReport(entitlement)) {
    return upgradeRequiredResult(entitlement);
  }
  const { parcelNodeId, artifactId } = args;
  if (typeof parcelNodeId !== "string" || !looksLikeParcelNodeId(parcelNodeId)) {
    return invalidParcelNodeIdResult(parcelNodeId);
  }
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    return textResult(
      {
        status: "refused",
        reason: "artifact_id_missing",
        message: "artifactId is required.",
      },
      true,
    );
  }

  const dbClient = deps?.db ?? defaultDb;
  const parcelKey = parcelKeyFromParcelNodeId(parcelNodeId);

  const artifactRows = await dbClient
    .select()
    .from(recordsRequestArtifacts)
    .where(eq(recordsRequestArtifacts.id, artifactId))
    .limit(1);
  const artifact = (artifactRows as RecordsRequestArtifact[])[0];
  if (!artifact) {
    return textResult(
      {
        status: "refused",
        reason: "artifact_not_found",
        message: "No document with that artifactId for this parcel.",
        parcelNodeId,
        artifactId,
      },
      true,
    );
  }

  const jobRows = await dbClient
    .select()
    .from(recordsRequestJobs)
    .where(eq(recordsRequestJobs.id, artifact.jobId))
    .limit(1);
  const job = (jobRows as RecordsRequestJob[])[0];

  if (!job || job.userId !== userId || job.parcelKey !== parcelKey) {
    // Same refusal as "not found" — ownership/parcel mismatch never
    // distinguishes itself from absence in the response body.
    return textResult(
      {
        status: "refused",
        reason: "artifact_not_found",
        message: "No document with that artifactId for this parcel.",
        parcelNodeId,
        artifactId,
      },
      true,
    );
  }

  return textResult(
    {
      status: "ok",
      parcelNodeId,
      jobStatus: job.status,
      ...documentDetail(artifact),
    },
    false,
  );
}
