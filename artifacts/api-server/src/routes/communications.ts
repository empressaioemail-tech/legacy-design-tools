/**
 * /api/submissions/:submissionId/communications — PLR-5.
 *
 * Two endpoints, both reviewer-only (`audience: "internal"`):
 *
 *   - GET  /submissions/:submissionId/communications
 *       Newest-first list of `submission_communications` rows for
 *       the submission. Drives the SubmissionDetailModal's
 *       "Last comment letter sent" status pill.
 *
 *   - POST /submissions/:submissionId/communications
 *       Persist a reviewer-edited comment letter, snapshot the
 *       cited findings, and append a single
 *       `communication-event.sent` history event against the new
 *       row's atom id.
 *
 * Email dispatch is intentionally out-of-scope — the api-server has
 * no outbound-mail pipeline yet (`notifications.ts` is the in-app
 * architect surface). The route logs the intended recipient list and
 * persists it for a future dispatcher to pick up.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  engagements,
  findings,
  sheets,
  snapshots,
  submissions,
  submissionCommunications,
  type SubmissionCommunication,
} from "@workspace/db";
import type { FindingCategory, FindingSeverity } from "@workspace/finding-engine";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { renderCommentLetter } from "@workspace/plan-review-pdf";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  CreateSubmissionCommunicationBody,
  CreateSubmissionCommunicationParams,
  DraftSubmissionCommunicationParams,
  ListSubmissionCommunicationsParams,
} from "@workspace/api-zod";
import {
  polishCommentLetter,
  type CommentLetterFinding,
  type CommentLetterFindingStatus,
} from "@workspace/comment-letter";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { Logger } from "pino";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import { COMMUNICATION_EVENT_TYPES } from "../atoms/communication-event.atom";

const router: IRouter = Router();

const COMMUNICATIONS_AUDIENCE_ERROR =
  "communications_require_internal_audience";

interface SubmissionCommunicationWire {
  id: string;
  atomId: string;
  submissionId: string;
  subject: string;
  body: string;
  findingAtomIds: string[];
  recipientUserIds: string[];
  sentBy: { kind: "user" | "agent" | "system"; id: string; displayName?: string | null };
  sentAt: string;
  /**
   * `/objects/<uuid>` path of the rendered comment-letter PDF, or
   * null when the render hasn't completed (or failed). Surfaced so
   * the FE composer can offer an inline download link without a
   * follow-up presence check (PLR-11).
   */
  pdfObjectPath: string | null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function toWire(row: SubmissionCommunication): SubmissionCommunicationWire {
  const sentBy = row.sentBy as unknown as SubmissionCommunicationWire["sentBy"];
  return {
    id: row.id,
    atomId: row.atomId,
    submissionId: row.submissionId,
    subject: row.subject,
    body: row.body,
    findingAtomIds: toStringArray(row.findingAtomIds),
    recipientUserIds: toStringArray(row.recipientUserIds),
    sentBy,
    sentAt: row.sentAt.toISOString(),
    pdfObjectPath: row.pdfObjectPath ?? null,
  };
}

let cachedObjectStorageComm: ObjectStorageService | null = null;
function getObjectStorageComm(): ObjectStorageService {
  if (!cachedObjectStorageComm) {
    cachedObjectStorageComm = new ObjectStorageService();
  }
  return cachedObjectStorageComm;
}

const LETTER_PDF_TENANT_NAME = "City of Empressa";

/**
 * Resolve the page-label → issued-PDF page-number map so the
 * comment-letter renderer can hyperlink each page-label heading
 * back into the issued plan set. Mirrors the snapshot resolver in
 * `routes/sheets.ts` so the page numbering matches the issued PDF
 * the decisions route stamped (sheets are appended in `sortOrder`
 * ascending, which is exactly what `renderStampedPlanSet` consumes).
 */
async function loadPageLabelToIssuedPage(
  submissionId: string,
): Promise<Map<string, number>> {
  const subRows = await db
    .select({
      engagementId: submissions.engagementId,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return new Map();
  let snapRows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.engagementId, sub.engagementId),
        lte(snapshots.receivedAt, sub.submittedAt),
      ),
    )
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);
  if (snapRows.length === 0) {
    snapRows = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.engagementId, sub.engagementId))
      .orderBy(asc(snapshots.receivedAt))
      .limit(1);
  }
  const snap = snapRows[0];
  if (!snap) return new Map();
  const sheetRows = await db
    .select({ sheetNumber: sheets.sheetNumber })
    .from(sheets)
    .where(eq(sheets.snapshotId, snap.id))
    .orderBy(asc(sheets.sortOrder));
  const map = new Map<string, number>();
  sheetRows.forEach((row, idx) => {
    if (!map.has(row.sheetNumber)) {
      map.set(row.sheetNumber, idx + 1);
    }
  });
  return map;
}

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: COMMUNICATIONS_AUDIENCE_ERROR });
  return true;
}

async function loadSubmission(submissionId: string) {
  const rows = await db
    .select({ id: submissions.id, engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Project a `findings` row into the shape the comment-letter assembler
 * (`@workspace/comment-letter`) consumes. The lib's `CommentLetterFinding`
 * is intentionally a narrow subset of the wire `Finding` so this projection
 * stays an obvious 1:1 — no derived fields, no aggregation, just a
 * column-pick plus the open-finding status filter.
 *
 * `id` is the public atom id (NOT the row uuid) so the audited
 * `findingAtomIds` snapshot the FE later forwards to the create-
 * communication endpoint matches what the assembler grouped under.
 */
function findingsRowToCommentLetterInput(
  rows: ReadonlyArray<typeof findings.$inferSelect>,
): CommentLetterFinding[] {
  return rows.map((row) => ({
    id: row.atomId,
    severity: row.severity as FindingSeverity,
    category: row.category as FindingCategory,
    status: row.status as CommentLetterFindingStatus,
    text: row.text,
    elementRef: row.elementRef ?? null,
  }));
}

/**
 * Resolve a reviewer-facing jurisdiction label for the comment-letter
 * `Re:` line. Mirrors the precedence the FE used to compute on its own
 * (`jurisdictionCity, jurisdictionState` → `jurisdiction` freeform →
 * the fallback "the jurisdiction") so existing letters keep reading
 * the same after the polish endpoint takes over context derivation.
 */
function resolveJurisdictionLabel(
  eng: typeof engagements.$inferSelect | null,
): string {
  if (!eng) return "the jurisdiction";
  const city = eng.jurisdictionCity?.trim();
  const state = eng.jurisdictionState?.trim();
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  if (state) return state;
  const free = eng.jurisdiction?.trim();
  if (free && free.length > 0) return free;
  return "the jurisdiction";
}

/**
 * Anthropic-backed completer wired into the `polishCommentLetter`
 * citation-preserving polish step. Uses the same `claude-sonnet-4-6`
 * model the chat route does (`routes/chat.ts:748`) so capacity tuning
 * stays consolidated.
 *
 * Concatenates every `text` content block in the response (the SDK
 * splits long completions across multiple blocks) and trims the
 * result. Errors propagate so `polishCommentLetter` can stamp the
 * `completer_error` fallback reason.
 */
async function anthropicPolishCompleter(args: {
  system: string;
  user: string;
}): Promise<string> {
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: args.system,
    messages: [{ role: "user", content: args.user }],
  });
  const text = resp.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return text.trim();
}

router.post(
  "/submissions/:submissionId/communications/draft",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = DraftSubmissionCommunicationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const submissionId = params.data.submissionId;

    // Load the submission + parent engagement together so the polish
    // step has the addressee + jurisdiction context the deterministic
    // assembler stamps into the `To:` / `Re:` headers. A failed engagement
    // lookup is not fatal — `resolveJurisdictionLabel` falls back to a
    // generic label and `applicantFirm` is nullable on the schema.
    const subRows = await db
      .select({
        id: submissions.id,
        engagementId: submissions.engagementId,
        submittedAt: submissions.submittedAt,
      })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);
    const sub = subRows[0];
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const engRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, sub.engagementId))
      .limit(1);
    const eng = engRows[0] ?? null;

    const findingRows = await db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submissionId))
      .orderBy(desc(findings.createdAt));

    const input = {
      findings: findingsRowToCommentLetterInput(findingRows),
      context: {
        jurisdictionLabel: resolveJurisdictionLabel(eng),
        applicantFirm: eng?.applicantFirm ?? null,
        submittedAt: sub.submittedAt.toISOString(),
      },
    };

    const polished = await polishCommentLetter(input, anthropicPolishCompleter);

    // Snapshot the open-finding atom-id list the assembler used so the
    // FE can forward it verbatim to the create-communication endpoint.
    // Mirrors the FE's pre-existing filter on `ai-produced` / `accepted`.
    const findingAtomIds = input.findings
      .filter((f) => f.status === "ai-produced" || f.status === "accepted")
      .map((f) => f.id);

    if (polished.fallbackReason && polished.fallbackReason !== "no_open_findings") {
      reqLog.warn(
        {
          submissionId,
          fallbackReason: polished.fallbackReason,
          findingCount: polished.findingCount,
        },
        "comment-letter polish fell back to deterministic skeleton",
      );
    } else {
      reqLog.info(
        {
          submissionId,
          polished: polished.polished,
          findingCount: polished.findingCount,
        },
        "comment-letter draft generated",
      );
    }

    res.json({
      subject: polished.subject,
      body: polished.body,
      polished: polished.polished,
      fallbackReason: polished.fallbackReason,
      findingAtomIds,
      findingCount: polished.findingCount,
    });
  },
);

router.get(
  "/submissions/:submissionId/communications",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = ListSubmissionCommunicationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const rows = await db
      .select()
      .from(submissionCommunications)
      .where(eq(submissionCommunications.submissionId, sub.id))
      .orderBy(desc(submissionCommunications.sentAt));

    reqLog.debug(
      { submissionId: sub.id, count: rows.length },
      "listed submission communications",
    );
    res.json({ communications: rows.map(toWire) });
  },
);

router.post(
  "/submissions/:submissionId/communications",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = CreateSubmissionCommunicationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = CreateSubmissionCommunicationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const requestor = req.session.requestor;
    if (!requestor || !requestor.id) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    // Allocate the row pk up-front so we can mint the atom id with
    // the prefixed grammar (`communication-event:{submissionId}:{rowId}`)
    // before the insert lands.
    const rowId = crypto.randomUUID();
    const atomId = `communication-event:${sub.id}:${rowId}`;
    const sentBy = {
      kind: requestor.kind,
      id: requestor.id,
    };

    const inserted = await db
      .insert(submissionCommunications)
      .values({
        id: rowId,
        submissionId: sub.id,
        atomId,
        subject: body.data.subject,
        body: body.data.body,
        findingAtomIds: body.data.findingAtomIds,
        recipientUserIds: body.data.recipientUserIds,
        sentBy,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      reqLog.error(
        { submissionId: sub.id },
        "submission-communication insert returned no row",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    // PLR-11: render the comment-letter PDF from the actual sent
    // body (the source of truth) BEFORE emitting the event so the
    // pdfArtifactRef lands on the same `communication-event.sent`
    // payload. Render is best-effort: failure leaves pdfArtifactRef
    // null and the row is kept.
    let updated: SubmissionCommunication = row;
    let pdfArtifactRef: string | null = null;
    try {
      const findingRows = await db
        .select()
        .from(findings)
        .where(eq(findings.submissionId, sub.id));
      const findingsById = new Map(findingRows.map((f) => [f.atomId, f]));
      const cited = body.data.findingAtomIds
        .map((id) => findingsById.get(id))
        .filter((f): f is NonNullable<typeof f> => Boolean(f))
        .map((f) => ({
          id: f.atomId,
          severity: f.severity as FindingSeverity,
          category: f.category as FindingCategory,
          status: f.status as CommentLetterFindingStatus,
          text: f.text,
          elementRef: f.elementRef ?? null,
        }));

      const engRows = await db
        .select()
        .from(engagements)
        .where(eq(engagements.id, sub.engagementId))
        .limit(1);
      const eng = engRows[0] ?? null;
      const addressLines: string[] = [];
      if (eng?.address) addressLines.push(eng.address);
      const cityState = [eng?.jurisdictionCity, eng?.jurisdictionState]
        .filter((s): s is string => Boolean(s))
        .join(", ");
      if (cityState) addressLines.push(cityState);

      const pageMap = await loadPageLabelToIssuedPage(sub.id);

      const bytes = await renderCommentLetter({
        tenantName: LETTER_PDF_TENANT_NAME,
        tenantAddressLines: addressLines,
        subject: row.subject,
        body: row.body,
        recipientName: eng?.applicantFirm ?? null,
        sentAt: row.sentAt,
        issuedPlanSetUrl: `/api/submissions/${sub.id}/issued-pdf`,
        pageLabelToIssuedPage: pageMap,
        findings: cited,
      });
      pdfArtifactRef = await getObjectStorageComm()
        .uploadObjectEntityFromBuffer(Buffer.from(bytes), "application/pdf");
      const [back] = await db
        .update(submissionCommunications)
        .set({ pdfObjectPath: pdfArtifactRef })
        .where(eq(submissionCommunications.id, row.id))
        .returning();
      if (back) updated = back;
      reqLog.info(
        { communicationId: row.id, pdfArtifactRef },
        "comment-letter PDF rendered and persisted",
      );
    } catch (err) {
      reqLog.error(
        { err, communicationId: row.id },
        "comment-letter PDF render/upload failed — row kept",
      );
    }

    // Append `communication-event.sent` (best-effort). The
    // pdfArtifactRef lives on the row as derived state — the atom's
    // contextSummary surfaces it; keeping it off the event payload
    // means the chain hash doesn't need a back-fill rewrite.
    try {
      await getHistoryService().appendEvent({
        entityType: "communication-event",
        entityId: atomId,
        eventType: COMMUNICATION_EVENT_TYPES[0],
        actor: sentBy,
        payload: {
          communicationId: row.id,
          submissionId: row.submissionId,
          subject: row.subject,
          recipientCount: body.data.recipientUserIds.length,
          findingCount: body.data.findingAtomIds.length,
        },
      });
    } catch (err) {
      reqLog.error(
        { err, communicationId: row.id, atomId },
        "communication-event.sent event append failed — row write kept",
      );
    }

    if (body.data.recipientUserIds.length === 0) {
      reqLog.warn(
        { submissionId: sub.id, communicationId: row.id },
        "comment letter persisted with no recipients — outbound dispatch skipped",
      );
    }

    res.status(201).json({ communication: toWire(updated) });
  },
);

/**
 * PLR-11 — `GET /communications/:id/pdf`. Streams the rendered
 * comment-letter PDF from object storage. 404 when the row exists
 * but the render hadn't completed (or failed), so the FE can hide
 * the link until the back-fill lands.
 *
 * Reviewer-only — same audience guard as the rest of this surface.
 */
router.get(
  "/communications/:id/pdf",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const id = String(req.params["id"] ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const rows = await db
      .select()
      .from(submissionCommunications)
      .where(eq(submissionCommunications.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "communication_not_found" });
      return;
    }
    if (!row.pdfObjectPath) {
      res.status(404).json({ error: "comment_letter_pdf_not_found" });
      return;
    }
    try {
      const bytes = await getObjectStorageComm().getObjectEntityBytes(
        row.pdfObjectPath,
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader(
        "Content-Disposition",
        `inline; filename="comment-letter-${id}.pdf"`,
      );
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(bytes);
    } catch (err) {
      reqLog.error(
        { err, communicationId: id, objectPath: row.pdfObjectPath },
        "comment-letter PDF object fetch failed",
      );
      res.status(404).json({ error: "comment_letter_pdf_not_found" });
    }
  },
);

export default router;
