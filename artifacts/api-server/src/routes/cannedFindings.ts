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
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  CreateCannedFindingBody,
  UpdateCannedFindingBody,
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

const DISCIPLINES = ["building", "fire", "zoning", "civil"] as const;
type Discipline = (typeof DISCIPLINES)[number];
function isDiscipline(v: unknown): v is Discipline {
  return typeof v === "string" && (DISCIPLINES as readonly string[]).includes(v);
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
    const disciplineRaw = req.query.discipline;
    let discipline: Discipline | null = null;
    if (typeof disciplineRaw === "string" && disciplineRaw.length > 0) {
      if (!isDiscipline(disciplineRaw)) {
        res.status(400).json({ error: "invalid_discipline" });
        return;
      }
      discipline = disciplineRaw;
    }
    const includeArchived = String(req.query.includeArchived ?? "") === "true";

    try {
      const conditions = [eq(cannedFindings.tenantId, tenantId)];
      if (discipline) conditions.push(eq(cannedFindings.discipline, discipline));
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
