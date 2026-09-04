/**
 * P-85 WDLL item 11 — completion email on Records Request terminal states.
 * Provider: Resend (decision 2026-08-27). Failures recorded on the job scope.
 */

import { eq } from "drizzle-orm";
import { db, recordsRequestJobs, type RecordsRequestJob } from "@workspace/db";
import { loadRecordsRequestJobById } from "./recordsRequestJobWorker";

export type RecordsNotificationKind =
  | "complete"
  | "failed"
  | "needs-human"
  | "awaiting-purchase-approval";

export type NotificationEvent = {
  kind: RecordsNotificationKind;
  at: string;
  status: "sent" | "failed" | "skipped";
  providerId?: string | null;
  error?: string | null;
};

const NOTIFY_KINDS: ReadonlySet<RecordsNotificationKind> = new Set([
  "complete",
  "failed",
  "needs-human",
  "awaiting-purchase-approval",
]);

function scopeRecord(
  job: RecordsRequestJob,
): Record<string, unknown> | null {
  const scope = job.scopeSearched;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return null;
  }
  return scope as Record<string, unknown>;
}

function parcelLabel(job: RecordsRequestJob): string {
  const key = job.parcelKey;
  if (key.startsWith("apn:")) {
    const parts = key.split(":");
    if (parts.length >= 3) {
      return `${parts[1]}:${parts[2]}`;
    }
  }
  return key;
}

function recordsDeepLink(job: RecordsRequestJob): string {
  const base =
    process.env.PE_RECORDS_REQUEST_LINK_BASE?.trim() ||
    "https://smartsite.cloud";
  const node = parcelLabel(job).replace(/^apn:/, "");
  return `${base.replace(/\/$/, "")}/?parcel=${encodeURIComponent(node)}#reports-records`;
}

export function buildRecordsRequestEmail(args: {
  job: RecordsRequestJob;
  kind: RecordsNotificationKind;
}): { subject: string; html: string; text: string } {
  const parcel = parcelLabel(args.job);
  const link = recordsDeepLink(args.job);
  const subjectByKind: Record<RecordsNotificationKind, string> = {
    complete: `Records request finished · ${parcel}`,
    failed: `Records request failed · ${parcel}`,
    "needs-human": `Records request needs clerk follow-up · ${parcel}`,
    "awaiting-purchase-approval": `County clerk fees required · ${parcel}`,
  };
  const bodyByKind: Record<RecordsNotificationKind, string> = {
    complete:
      "Your county clerk index search finished. Open your parcel records to review instruments, scope, and acquisition status.",
    failed:
      "Your county clerk index search could not finish. Open the run record for the error and next steps.",
    "needs-human":
      "The county portal requires a human clerk step before this run can continue. Open the run record for the instrument list.",
    "awaiting-purchase-approval":
      "The county portal charges for document images. Approve the projected county fees in Smart Site to resume acquisition, or decline to keep header-only index rows.",
  };
  const subject = subjectByKind[args.kind];
  const lead = bodyByKind[args.kind];
  const text = `${lead}\n\nParcel: ${parcel}\nOpen records: ${link}\n\nThis is not a title opinion or statement of priority.`;
  const html = `<p>${lead}</p><p><strong>Parcel:</strong> ${parcel}</p><p><a href="${link}">Open property records</a></p><p style="color:#64748b;font-size:12px;">This is not a title opinion or statement of priority.</p>`;
  return { subject, html, text };
}

export async function sendViaResend(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY unset" };
  }
  const from =
    process.env.RECORDS_REQUEST_EMAIL_FROM?.trim() ||
    "Smart Site <records@smartsite.cloud>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : `Resend HTTP ${res.status}`;
    return { ok: false, error: message };
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return { ok: false, error: "Resend response missing id" };
  }
  return { ok: true, id };
}

async function appendNotificationEvent(
  jobId: string,
  event: NotificationEvent,
): Promise<void> {
  const job = await loadRecordsRequestJobById(jobId);
  if (!job) return;
  const prior = scopeRecord(job) ?? {};
  const existing = Array.isArray(prior.notificationEvents)
    ? [...(prior.notificationEvents as NotificationEvent[])]
    : [];
  existing.push(event);
  await db
    .update(recordsRequestJobs)
    .set({
      scopeSearched: { ...prior, notificationEvents: existing },
      updatedAt: new Date(),
    })
    .where(eq(recordsRequestJobs.id, jobId));
}

export async function notifyRecordsRequestCompletion(args: {
  jobId: string;
  kind?: RecordsNotificationKind;
  send?: typeof sendViaResend;
}): Promise<NotificationEvent> {
  const job = await loadRecordsRequestJobById(args.jobId);
  if (!job) {
    throw new Error(`records_request_jobs row not found: ${args.jobId}`);
  }

  const kind =
    args.kind ??
    (NOTIFY_KINDS.has(job.status as RecordsNotificationKind)
      ? (job.status as RecordsNotificationKind)
      : null);
  if (!kind) {
    const skipped: NotificationEvent = {
      kind: "complete",
      at: new Date().toISOString(),
      status: "skipped",
      error: `status ${job.status} is not notifiable`,
    };
    await appendNotificationEvent(args.jobId, skipped);
    return skipped;
  }

  const email = job.userEmail?.trim();
  if (!email) {
    const skipped: NotificationEvent = {
      kind,
      at: new Date().toISOString(),
      status: "skipped",
      error: "user_email absent on job row",
    };
    await appendNotificationEvent(args.jobId, skipped);
    return skipped;
  }

  const mail = buildRecordsRequestEmail({ job, kind });
  const send = args.send ?? sendViaResend;
  const result = await send({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });

  const event: NotificationEvent = result.ok
    ? {
        kind,
        at: new Date().toISOString(),
        status: "sent",
        providerId: result.id,
      }
    : {
        kind,
        at: new Date().toISOString(),
        status: "failed",
        error: result.error,
      };
  await appendNotificationEvent(args.jobId, event);
  return event;
}
