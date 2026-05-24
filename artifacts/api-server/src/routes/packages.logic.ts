import { randomBytes } from "node:crypto";

const PACKAGE_TEMPLATE_VALUES = [
  "client-presentation",
  "client-review",
  "publisher-handoff",
  "jurisdiction-manifest",
] as const;

const PACKAGE_STATUS_VALUES = [
  "draft",
  "exported",
  "shared",
  "handed-off",
  "closed",
] as const;

export interface PackageSelectionJson {
  includeIntake?: boolean;
  includeBriefing?: boolean;
  renderIds?: string[];
  videoIds?: string[];
  sheetIds?: string[];
  heroRenderId?: string | null;
}

export interface PackageFormSnapshotJson {
  publisherIntake?: Record<string, unknown>;
  clientHeadline?: string;
  clientTalkingPoints?: string;
  clientReviewNote?: string;
}

export interface EngagementIntakeBlob {
  clientNotes?: string | null;
  clientEmail?: string | null;
  intakeSource?: string | null;
  sourceExcerpt?: string | null;
  capturedAt?: string | null;
}

export interface ClientBriefResponse {
  clientName: string | null;
  clientEmail: string | null;
  clientNotes: string | null;
  intakeSource: string | null;
  capturedAt: string | null;
}

export interface CreateEngagementBody {
  name: string;
  address?: string | null;
  jurisdiction?: string | null;
  projectType?: string | null;
  intakeSource?: string | null;
  applicantFirm?: string | null;
  clientEmail?: string | null;
  clientNotes?: string | null;
  sourceExcerpt?: string | null;
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function extractIntakeFromSiteContextRaw(
  raw: unknown,
): EngagementIntakeBlob | null {
  if (!raw || typeof raw !== "object") return null;
  const intake = (raw as Record<string, unknown>).intake;
  if (!intake || typeof intake !== "object") return null;
  const o = intake as Record<string, unknown>;
  const out: EngagementIntakeBlob = {};
  const notes = trimOrNull(o.clientNotes);
  const email = trimOrNull(o.clientEmail);
  const source = trimOrNull(o.intakeSource);
  const excerpt = trimOrNull(o.sourceExcerpt);
  const capturedAt = trimOrNull(o.capturedAt);
  if (notes) out.clientNotes = notes;
  if (email) out.clientEmail = email;
  if (source) out.intakeSource = source;
  if (excerpt) out.sourceExcerpt = excerpt;
  if (capturedAt) out.capturedAt = capturedAt;
  return Object.keys(out).length > 0 ? out : null;
}

export function mergeSiteContextRaw(
  existing: unknown,
  geoRaw: unknown,
): Record<string, unknown> | null {
  const intake = extractIntakeFromSiteContextRaw(existing);
  const geo =
    geoRaw && typeof geoRaw === "object"
      ? { ...(geoRaw as Record<string, unknown>) }
      : {};
  if (intake) geo.intake = intake;
  return Object.keys(geo).length > 0 ? geo : null;
}

export function buildIntakeSiteContextRaw(
  intake: EngagementIntakeBlob,
): Record<string, unknown> {
  return { intake };
}

export function toClientBrief(row: {
  applicantFirm: string | null;
  siteContextRaw: unknown;
}): ClientBriefResponse | null {
  const intake = extractIntakeFromSiteContextRaw(row.siteContextRaw);
  const clientName = trimOrNull(row.applicantFirm);
  const clientEmail = intake?.clientEmail ?? null;
  const clientNotes = intake?.clientNotes ?? null;
  const intakeSource = intake?.intakeSource ?? null;
  const capturedAt = intake?.capturedAt ?? null;
  if (!clientName && !clientEmail && !clientNotes && !intakeSource) {
    return null;
  }
  return {
    clientName,
    clientEmail: clientEmail ?? null,
    clientNotes: clientNotes ?? null,
    intakeSource: intakeSource ?? null,
    capturedAt: capturedAt ?? null,
  };
}

export interface UpsertPackageBody {
  template: string;
  title?: string;
  status?: string;
  snapshotId?: string | null;
  selection?: PackageSelectionJson;
  formSnapshot?: PackageFormSnapshotJson | null;
  clientReviewDeadline?: string | null;
  linkedSubmissionId?: string | null;
}

export interface CreateShareCommentBody {
  authorName: string;
  body: string;
  sheetId?: string | null;
}

export function parseCreateEngagementBody(
  body: unknown,
): CreateEngagementBody | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Body must be an object" };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.trim().length === 0) {
    return { error: "name is required" };
  }
  return {
    name: o.name.trim(),
    address: trimOrNull(o.address),
    jurisdiction: trimOrNull(o.jurisdiction),
    projectType: trimOrNull(o.projectType),
    intakeSource: trimOrNull(o.intakeSource),
    applicantFirm: trimOrNull(o.applicantFirm),
    clientEmail: trimOrNull(o.clientEmail),
    clientNotes: trimOrNull(o.clientNotes),
    sourceExcerpt:
      typeof o.sourceExcerpt === "string"
        ? o.sourceExcerpt.slice(0, 8000)
        : null,
  };
}

export function parseUpsertPackageBody(
  body: unknown,
): UpsertPackageBody | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Body must be an object" };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.template !== "string") {
    return { error: "template is required" };
  }
  if (
    !(PACKAGE_TEMPLATE_VALUES as readonly string[]).includes(o.template)
  ) {
    return { error: `template must be one of: ${PACKAGE_TEMPLATE_VALUES.join(", ")}` };
  }
  const out: UpsertPackageBody = { template: o.template };
  if (typeof o.title === "string") out.title = o.title.trim();
  if (typeof o.status === "string") {
    if (!(PACKAGE_STATUS_VALUES as readonly string[]).includes(o.status)) {
      return { error: `status must be one of: ${PACKAGE_STATUS_VALUES.join(", ")}` };
    }
    out.status = o.status;
  }
  if (o.snapshotId === null || typeof o.snapshotId === "string") {
    out.snapshotId = o.snapshotId;
  }
  if (o.selection && typeof o.selection === "object") {
    out.selection = o.selection as PackageSelectionJson;
  }
  if (o.formSnapshot === null || (o.formSnapshot && typeof o.formSnapshot === "object")) {
    out.formSnapshot = o.formSnapshot as PackageFormSnapshotJson | null;
  }
  if (o.clientReviewDeadline === null || typeof o.clientReviewDeadline === "string") {
    out.clientReviewDeadline = o.clientReviewDeadline;
  }
  if (o.linkedSubmissionId === null || typeof o.linkedSubmissionId === "string") {
    out.linkedSubmissionId = o.linkedSubmissionId;
  }
  return out;
}

export function parseShareCommentBody(
  body: unknown,
): CreateShareCommentBody | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Body must be an object" };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.authorName !== "string" || o.authorName.trim().length === 0) {
    return { error: "authorName is required" };
  }
  if (typeof o.body !== "string" || o.body.trim().length === 0) {
    return { error: "body is required" };
  }
  return {
    authorName: o.authorName.trim(),
    body: o.body.trim(),
    sheetId: typeof o.sheetId === "string" ? o.sheetId : null,
  };
}

export function defaultPackageTitle(template: string): string {
  switch (template) {
    case "client-presentation":
      return "Client presentation";
    case "client-review":
      return "Client plan review";
    case "publisher-handoff":
      return "Publisher handoff";
    case "jurisdiction-manifest":
      return "Submittal manifest";
    default:
      return "Package";
  }
}

export function parsePatchPackageBody(
  body: unknown,
): Omit<UpsertPackageBody, "template"> & { template?: string } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Body must be an object" };
  }
  const o = body as Record<string, unknown>;
  const out: Omit<UpsertPackageBody, "template"> & { template?: string } = {};
  if (typeof o.template === "string") {
    if (!(PACKAGE_TEMPLATE_VALUES as readonly string[]).includes(o.template)) {
      return { error: `template must be one of: ${PACKAGE_TEMPLATE_VALUES.join(", ")}` };
    }
    out.template = o.template;
  }
  if (typeof o.title === "string") out.title = o.title.trim();
  if (typeof o.status === "string") {
    if (!(PACKAGE_STATUS_VALUES as readonly string[]).includes(o.status)) {
      return { error: `status must be one of: ${PACKAGE_STATUS_VALUES.join(", ")}` };
    }
    out.status = o.status;
  }
  if (o.snapshotId === null || typeof o.snapshotId === "string") {
    out.snapshotId = o.snapshotId;
  }
  if (o.selection && typeof o.selection === "object") {
    out.selection = o.selection as PackageSelectionJson;
  }
  if (o.formSnapshot === null || (o.formSnapshot && typeof o.formSnapshot === "object")) {
    out.formSnapshot = o.formSnapshot as PackageFormSnapshotJson | null;
  }
  if (o.clientReviewDeadline === null || typeof o.clientReviewDeadline === "string") {
    out.clientReviewDeadline = o.clientReviewDeadline;
  }
  if (o.linkedSubmissionId === null || typeof o.linkedSubmissionId === "string") {
    out.linkedSubmissionId = o.linkedSubmissionId;
  }
  return out;
}

export function generateShareToken(): string {
  return randomBytes(24).toString("hex");
}
