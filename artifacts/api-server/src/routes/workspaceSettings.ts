/**
 * Workspace product settings — pilot single-tenant branding (QA-57).
 *
 *   GET   /api/workspace/settings
 *   PATCH /api/workspace/settings
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, workspaceSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const DEFAULT_ID = "default";

router.use(requireServiceTokenOrSession);

function toWire(row: {
  id: string;
  firmDisplayName: string;
  logoUrl: string | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    firmDisplayName: row.firmDisplayName,
    logoUrl: row.logoUrl,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ensureDefaultRow() {
  const [existing] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, DEFAULT_ID))
    .limit(1);
  if (existing) return existing;
  const [inserted] = await db
    .insert(workspaceSettings)
    .values({ id: DEFAULT_ID })
    .returning();
  if (!inserted) throw new Error("workspace_settings insert returned no row");
  return inserted;
}

router.get("/workspace/settings", async (_req: Request, res: Response) => {
  try {
    const row = await ensureDefaultRow();
    res.json(toWire(row));
  } catch (err) {
    logger.error({ err }, "get workspace settings failed");
    res.status(500).json({ error: "Failed to load workspace settings" });
  }
});

router.patch("/workspace/settings", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const firmDisplayName =
    typeof body.firmDisplayName === "string"
      ? body.firmDisplayName.trim()
      : null;
  const logoUrl =
    body.logoUrl === null || body.logoUrl === undefined
      ? undefined
      : typeof body.logoUrl === "string"
        ? body.logoUrl.trim() || null
        : null;

  if (firmDisplayName !== null && firmDisplayName.length === 0) {
    res.status(400).json({ error: "invalid_firm_display_name" });
    return;
  }

  try {
    await ensureDefaultRow();
    const patch: Partial<{
      firmDisplayName: string;
      logoUrl: string | null;
      updatedAt: Date;
    }> = { updatedAt: new Date() };
    if (firmDisplayName !== null) patch.firmDisplayName = firmDisplayName;
    if (logoUrl !== undefined) patch.logoUrl = logoUrl;

    const [row] = await db
      .update(workspaceSettings)
      .set(patch)
      .where(eq(workspaceSettings.id, DEFAULT_ID))
      .returning();
    if (!row) {
      res.status(500).json({ error: "Failed to update workspace settings" });
      return;
    }
    res.json(toWire(row));
  } catch (err) {
    logger.error({ err }, "patch workspace settings failed");
    res.status(500).json({ error: "Failed to update workspace settings" });
  }
});

export default router;
