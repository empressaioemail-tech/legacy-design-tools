/**
 * PLR-10 — tenant-scoped canned-finding library routes.
 *
 *   GET    /tenants/:tenantId/canned-findings              (reviewer audience)
 *   POST   /tenants/:tenantId/canned-findings              (settings:manage)
 *   PATCH  /tenants/:tenantId/canned-findings/:id          (settings:manage)
 *   DELETE /tenants/:tenantId/canned-findings/:id          (settings:manage; soft-delete)
 */

import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { db, cannedFindings, type CannedFinding } from "@workspace/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  CreateCannedFindingBody,
  UpdateCannedFindingBody,
  PLAN_REVIEW_DISCIPLINE_VALUES,
  isPlanReviewDiscipline,
  type PlanReviewDiscipline,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SETTINGS_MANAGE = "settings:manage";

const requireSettingsManage: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.session.permissions?.includes(SETTINGS_MANAGE)) {
    next();
    return;
  }
  res.status(403).json({ error: "Requires settings:manage permission" });
};

// Mirrors the reviewer-audience guard used by routes/findings.ts so the
// library is reviewer-only on the read side too.
function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "findings_require_internal_audience" });
  return true;
}

/**
 * Defense-in-depth: the path `:tenantId` is client-supplied, so even
 * after a reviewer audience check a logged-in reviewer for tenant A
 * could otherwise read tenant B's library by typing the URL directly.
 * Reject when the session carries a tenant claim that disagrees with
 * the path. The session middleware always populates `tenantId`
 * (`DEFAULT_TENANT_ID` for anonymous / production fail-closed
 * sessions), so this is a strict equality check rather than a
 * "tenant present?" gate.
 */
function requireSessionTenantMatch(
  req: Request,
  res: Response,
  pathTenantId: string,
): boolean {
  const sessionTenant = req.session.tenantId;
  if (sessionTenant === pathTenantId) return false;
  res.status(403).json({ error: "tenant_mismatch" });
  return true;
}

const DISCIPLINES = ["building", "fire", "zoning", "civil"] as const;
type Discipline = (typeof DISCIPLINES)[number];
function isDiscipline(v: unknown): v is Discipline {
  return typeof v === "string" && (DISCIPLINES as readonly string[]).includes(v);
}

/**
 * Track 1 — translation map from the 7-value `PlanReviewDiscipline`
 * (reviewer certification) vocabulary to the 4-value canned-findings
 * `Discipline` vocabulary. Used by the `?reviewerDisciplines=` query
 * filter so a reviewer with disciplines `['building','accessibility']`
 * sees the canned-findings library narrowed to `['building']`.
 *
 * The map is rough by design (and acknowledged so in the BE plan).
 * The legacy 4-value canned-findings vocabulary will be revisited
 * once the broader data-model harmonisation lands; for now this
 * keeps the FE default-filter UX usable without breaking the
 * existing canned_findings.discipline column.
 */
const REVIEWER_TO_CANNED_DISCIPLINE: Record<PlanReviewDiscipline, Discipline[]> =
  {
    building: ["building"],
    electrical: ["building"],
    mechanical: ["building"],
    plumbing: ["building"],
    residential: ["building"],
    "fire-life-safety": ["fire"],
    accessibility: ["building"],
  };

function translateReviewerDisciplines(
  reviewerDisciplines: ReadonlyArray<PlanReviewDiscipline>,
): Discipline[] {
  const out = new Set<Discipline>();
  for (const r of reviewerDisciplines) {
    for (const c of REVIEWER_TO_CANNED_DISCIPLINE[r]) {
      out.add(c);
    }
  }
  return Array.from(out);
}

interface CannedFindingWire {
  id: string;
  tenantId: string;
  discipline: Discipline;
  title: string;
  defaultBody: string;
  severity: "blocker" | "concern" | "advisory";
  category: string;
  color: string;
  codeAtomCitations: Array<{ kind: "code-section"; atomId: string }>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toWire(row: CannedFinding): CannedFindingWire {
  const cites = Array.isArray(row.codeAtomCitations)
    ? (row.codeAtomCitations as Array<{ kind?: unknown; atomId?: unknown }>)
        .filter(
          (c): c is { kind: "code-section"; atomId: string } =>
            !!c &&
            (c as { kind?: unknown }).kind === "code-section" &&
            typeof (c as { atomId?: unknown }).atomId === "string",
        )
        .map((c) => ({ kind: "code-section" as const, atomId: c.atomId }))
    : [];
  return {
    id: row.id,
    tenantId: row.tenantId,
    discipline: row.discipline as Discipline,
    title: row.title,
    defaultBody: row.defaultBody,
    severity: row.severity as CannedFindingWire["severity"],
    category: row.category,
    color: row.color,
    codeAtomCitations: cites,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get(
  "/tenants/:tenantId/canned-findings",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const tenantId = String(req.params.tenantId ?? "").trim();
    if (!tenantId) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    if (requireSessionTenantMatch(req, res, tenantId)) return;
    const disciplineRaw = req.query.discipline;
    let discipline: Discipline | null = null;
    if (typeof disciplineRaw === "string" && disciplineRaw.length > 0) {
      if (!isDiscipline(disciplineRaw)) {
        res.status(400).json({ error: "invalid_discipline" });
        return;
      }
      discipline = disciplineRaw;
    }

    /**
     * Track 1 — optional CSV of `PlanReviewDiscipline` values.
     * Server applies the 7→4 translation map and filters to canned
     * rows whose `discipline` column appears in the translated set.
     * Mutually-exclusive with the legacy `discipline` query param —
     * if both are supplied the 400 error name calls out the conflict
     * so the FE knows which knob it picked. Empty string == absent.
     */
    let translatedDisciplines: Discipline[] | null = null;
    const reviewerDisciplinesRaw = req.query.reviewerDisciplines;
    if (
      typeof reviewerDisciplinesRaw === "string" &&
      reviewerDisciplinesRaw.length > 0
    ) {
      if (discipline) {
        res.status(400).json({
          error: "discipline_and_reviewerDisciplines_mutually_exclusive",
        });
        return;
      }
      const parts = reviewerDisciplinesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const reviewerDisciplines: PlanReviewDiscipline[] = [];
      for (const p of parts) {
        if (!isPlanReviewDiscipline(p)) {
          res.status(400).json({
            error: `invalid_reviewer_discipline; must be one of: ${PLAN_REVIEW_DISCIPLINE_VALUES.join(", ")}`,
          });
          return;
        }
        if (!reviewerDisciplines.includes(p)) reviewerDisciplines.push(p);
      }
      translatedDisciplines = translateReviewerDisciplines(reviewerDisciplines);
      // Empty translation result (only possible if the client sent
      // an empty list once we strip blanks, which we already 0-length
      // guard above; keep for defense). Treat as "no filter."
      if (translatedDisciplines.length === 0) {
        translatedDisciplines = null;
      }
    }

    const includeArchived = String(req.query.includeArchived ?? "") === "true";

    try {
      const conditions = [eq(cannedFindings.tenantId, tenantId)];
      if (discipline) conditions.push(eq(cannedFindings.discipline, discipline));
      if (translatedDisciplines) {
        conditions.push(
          inArray(cannedFindings.discipline, translatedDisciplines as string[]),
        );
      }
      if (!includeArchived) conditions.push(isNull(cannedFindings.archivedAt));
      const rows = await db
        .select()
        .from(cannedFindings)
        .where(and(...conditions))
        .orderBy(asc(cannedFindings.discipline), asc(cannedFindings.title));
      res.json({ cannedFindings: rows.map(toWire) });
    } catch (err) {
      logger.error({ err, tenantId }, "list canned findings failed");
      res.status(500).json({ error: "Failed to list canned findings" });
    }
  },
);

router.post(
  "/tenants/:tenantId/canned-findings",
  requireSettingsManage,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = String(req.params.tenantId ?? "").trim();
    if (!tenantId) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    if (requireSessionTenantMatch(req, res, tenantId)) return;
    const body = CreateCannedFindingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_create_canned_finding_body" });
      return;
    }
    try {
      const cites =
        body.data.codeAtomCitations?.map((c) => ({
          kind: "code-section" as const,
          atomId: c.atomId,
        })) ?? [];
      const [row] = await db
        .insert(cannedFindings)
        .values({
          tenantId,
          discipline: body.data.discipline,
          title: body.data.title.trim(),
          defaultBody: body.data.defaultBody,
          severity: body.data.severity,
          category: body.data.category,
          color: body.data.color ?? "#6b7280",
          codeAtomCitations: cites as unknown as Record<string, unknown>[],
        })
        .returning();
      res.status(201).json({ cannedFinding: toWire(row!) });
    } catch (err) {
      logger.error({ err, tenantId }, "create canned finding failed");
      res.status(500).json({ error: "Failed to create canned finding" });
    }
  },
);

router.patch(
  "/tenants/:tenantId/canned-findings/:cannedFindingId",
  requireSettingsManage,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = String(req.params.tenantId ?? "").trim();
    const id = String(req.params.cannedFindingId ?? "").trim();
    if (!tenantId || !id) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }
    if (requireSessionTenantMatch(req, res, tenantId)) return;
    const body = UpdateCannedFindingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_update_canned_finding_body" });
      return;
    }
    try {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.data.discipline !== undefined) set.discipline = body.data.discipline;
      if (body.data.title !== undefined) set.title = body.data.title.trim();
      if (body.data.defaultBody !== undefined) set.defaultBody = body.data.defaultBody;
      if (body.data.severity !== undefined) set.severity = body.data.severity;
      if (body.data.category !== undefined) set.category = body.data.category;
      if (body.data.color !== undefined) set.color = body.data.color;
      if (body.data.codeAtomCitations !== undefined) {
        set.codeAtomCitations = body.data.codeAtomCitations.map((c) => ({
          kind: "code-section" as const,
          atomId: c.atomId,
        }));
      }
      if (body.data.archivedAt !== undefined) {
        set.archivedAt = body.data.archivedAt
          ? new Date(body.data.archivedAt)
          : null;
      }
      const [row] = await db
        .update(cannedFindings)
        .set(set)
        .where(
          and(
            eq(cannedFindings.id, id),
            eq(cannedFindings.tenantId, tenantId),
          ),
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: "canned_finding_not_found" });
        return;
      }
      res.json({ cannedFinding: toWire(row) });
    } catch (err) {
      logger.error({ err, tenantId, id }, "update canned finding failed");
      res.status(500).json({ error: "Failed to update canned finding" });
    }
  },
);

router.delete(
  "/tenants/:tenantId/canned-findings/:cannedFindingId",
  requireSettingsManage,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = String(req.params.tenantId ?? "").trim();
    const id = String(req.params.cannedFindingId ?? "").trim();
    if (!tenantId || !id) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }
    if (requireSessionTenantMatch(req, res, tenantId)) return;
    try {
      // Idempotent: if already archived, return the existing row unchanged.
      const existing = await db
        .select()
        .from(cannedFindings)
        .where(
          and(
            eq(cannedFindings.id, id),
            eq(cannedFindings.tenantId, tenantId),
          ),
        )
        .limit(1);
      const current = existing[0];
      if (!current) {
        res.status(404).json({ error: "canned_finding_not_found" });
        return;
      }
      if (current.archivedAt) {
        res.json({ cannedFinding: toWire(current) });
        return;
      }
      const now = new Date();
      const [row] = await db
        .update(cannedFindings)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(cannedFindings.id, id))
        .returning();
      res.json({ cannedFinding: toWire(row!) });
    } catch (err) {
      logger.error({ err, tenantId, id }, "archive canned finding failed");
      res.status(500).json({ error: "Failed to archive canned finding" });
    }
  },
);

export default router;
