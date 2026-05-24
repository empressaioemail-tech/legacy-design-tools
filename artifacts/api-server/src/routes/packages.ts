/**
 * Engagement packages — unified outbound builder (client, publisher, jurisdiction).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  engagementPackages,
  engagements,
  packageShareComments,
  packageShares,
  type EngagementPackage,
  type PackageShare,
} from "@workspace/db";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";
import {
  defaultPackageTitle,
  generateShareToken,
  parsePatchPackageBody,
  parseShareCommentBody,
  parseUpsertPackageBody,
} from "./packages.logic";

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function toPackageWire(row: EngagementPackage, shareToken?: string | null) {
  return {
    id: row.id,
    engagementId: row.engagementId,
    template: row.template,
    status: row.status,
    title: row.title,
    snapshotId: row.snapshotId,
    selection: row.selection ?? {},
    formSnapshot: row.formSnapshot ?? null,
    clientReviewDeadline: row.clientReviewDeadline?.toISOString() ?? null,
    linkedSubmissionId: row.linkedSubmissionId,
    exportedAt: row.exportedAt?.toISOString() ?? null,
    shareToken: shareToken ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadShareByToken(token: string): Promise<{
  share: PackageShare;
  pkg: EngagementPackage;
  engagementName: string;
} | null> {
  const [row] = await db
    .select({
      share: packageShares,
      pkg: engagementPackages,
      engagementName: engagements.name,
    })
    .from(packageShares)
    .innerJoin(
      engagementPackages,
      eq(packageShares.packageId, engagementPackages.id),
    )
    .innerJoin(engagements, eq(engagementPackages.engagementId, engagements.id))
    .where(eq(packageShares.token, token))
    .limit(1);
  if (!row) return null;
  if (row.share.expiresAt && row.share.expiresAt.getTime() < Date.now()) {
    return null;
  }
  return row;
}

/* Authenticated engagement-scoped routes */
const authed = Router();
authed.use(requireServiceTokenOrSession);

authed.get(
  "/engagements/:engagementId/packages",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const rows = await db
        .select()
        .from(engagementPackages)
        .where(eq(engagementPackages.engagementId, engagementId))
        .orderBy(desc(engagementPackages.updatedAt));
      const shares = await db.select().from(packageShares);
      const tokenByPackage = new Map(
        shares.map((s) => [s.packageId, s.token] as const),
      );
      res.json(
        rows.map((r) => toPackageWire(r, tokenByPackage.get(r.id) ?? null)),
      );
    } catch (err) {
      logger.error({ err, engagementId }, "list packages failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.post(
  "/engagements/:engagementId/packages",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = parseUpsertPackageBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const [eng] = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: "Engagement not found" });
        return;
      }
      const now = new Date();
      const [row] = await db
        .insert(engagementPackages)
        .values({
          engagementId,
          template: parsed.template,
          title: parsed.title ?? defaultPackageTitle(parsed.template),
          status: parsed.status ?? "draft",
          snapshotId: parsed.snapshotId ?? null,
          selection: parsed.selection ?? {},
          formSnapshot: parsed.formSnapshot ?? null,
          clientReviewDeadline: parsed.clientReviewDeadline
            ? new Date(parsed.clientReviewDeadline)
            : null,
          linkedSubmissionId: parsed.linkedSubmissionId ?? null,
          updatedAt: now,
        })
        .returning();
      res.status(201).json(toPackageWire(row!));
    } catch (err) {
      logger.error({ err, engagementId }, "create package failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.patch(
  "/packages/:packageId",
  async (req: Request, res: Response) => {
    const packageId = routeParam(req.params.packageId);
    if (!UUID_RE.test(packageId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = parsePatchPackageBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const patch: Partial<typeof engagementPackages.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (parsed.template !== undefined) patch.template = parsed.template;
      if (parsed.title !== undefined) patch.title = parsed.title;
      if (parsed.status !== undefined) patch.status = parsed.status;
      if (parsed.snapshotId !== undefined) patch.snapshotId = parsed.snapshotId;
      if (parsed.selection !== undefined) patch.selection = parsed.selection;
      if (parsed.formSnapshot !== undefined) {
        patch.formSnapshot = parsed.formSnapshot;
      }
      if (parsed.clientReviewDeadline !== undefined) {
        patch.clientReviewDeadline = parsed.clientReviewDeadline
          ? new Date(parsed.clientReviewDeadline)
          : null;
      }
      if (parsed.linkedSubmissionId !== undefined) {
        patch.linkedSubmissionId = parsed.linkedSubmissionId;
      }
      if (parsed.status === "exported" || parsed.status === "handed-off") {
        patch.exportedAt = new Date();
      }
      const [row] = await db
        .update(engagementPackages)
        .set(patch)
        .where(eq(engagementPackages.id, packageId))
        .returning();
      if (!row) {
        res.status(404).json({ error: "Package not found" });
        return;
      }
      const [share] = await db
        .select()
        .from(packageShares)
        .where(eq(packageShares.packageId, packageId))
        .limit(1);
      res.json(toPackageWire(row, share?.token ?? null));
    } catch (err) {
      logger.error({ err, packageId }, "update package failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.post(
  "/packages/:packageId/share",
  async (req: Request, res: Response) => {
    const packageId = routeParam(req.params.packageId);
    if (!UUID_RE.test(packageId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const [pkg] = await db
        .select()
        .from(engagementPackages)
        .where(eq(engagementPackages.id, packageId))
        .limit(1);
      if (!pkg) {
        res.status(404).json({ error: "Package not found" });
        return;
      }
      const existing = await db
        .select()
        .from(packageShares)
        .where(eq(packageShares.packageId, packageId))
        .limit(1);
      let share = existing[0];
      if (!share) {
        const token = generateShareToken();
        [share] = await db
          .insert(packageShares)
          .values({ packageId, token })
          .returning();
      }
      await db
        .update(engagementPackages)
        .set({ status: "shared", updatedAt: new Date() })
        .where(eq(engagementPackages.id, packageId));
      res.status(201).json({
        token: share!.token,
        shareUrl: `/share/${share!.token}`,
      });
    } catch (err) {
      logger.error({ err, packageId }, "create share failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.get(
  "/packages/:packageId/comments",
  async (req: Request, res: Response) => {
    const packageId = routeParam(req.params.packageId);
    if (!UUID_RE.test(packageId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const [share] = await db
        .select()
        .from(packageShares)
        .where(eq(packageShares.packageId, packageId))
        .limit(1);
      if (!share) {
        res.json([]);
        return;
      }
      const rows = await db
        .select()
        .from(packageShareComments)
        .where(eq(packageShareComments.shareId, share.id))
        .orderBy(packageShareComments.createdAt);
      res.json(
        rows.map((r) => ({
          id: r.id,
          authorName: r.authorName,
          body: r.body,
          sheetId: r.sheetId,
          createdAt: r.createdAt.toISOString(),
        })),
      );
    } catch (err) {
      logger.error({ err, packageId }, "list package comments failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

router.use(authed);

/* Public share viewer — no auth */
router.get("/package-shares/:token", async (req: Request, res: Response) => {
  const loaded = await loadShareByToken(routeParam(req.params.token));
  if (!loaded) {
    res.status(404).json({ error: "Share link not found or expired" });
    return;
  }
  const comments = await db
    .select()
    .from(packageShareComments)
    .where(eq(packageShareComments.shareId, loaded.share.id))
    .orderBy(packageShareComments.createdAt);
  res.json({
    engagementName: loaded.engagementName,
    package: toPackageWire(loaded.pkg),
    comments: comments.map((c) => ({
      id: c.id,
      authorName: c.authorName,
      body: c.body,
      sheetId: c.sheetId,
      createdAt: c.createdAt.toISOString(),
    })),
  });
});

router.post(
  "/package-shares/:token/comments",
  async (req: Request, res: Response) => {
    const loaded = await loadShareByToken(routeParam(req.params.token));
    if (!loaded) {
      res.status(404).json({ error: "Share link not found or expired" });
      return;
    }
    const parsed = parseShareCommentBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const [row] = await db
      .insert(packageShareComments)
      .values({
        shareId: loaded.share.id,
        authorName: parsed.authorName,
        body: parsed.body,
        sheetId: parsed.sheetId ?? null,
      })
      .returning();
    res.status(201).json({
      id: row!.id,
      authorName: row!.authorName,
      body: row!.body,
      sheetId: row!.sheetId,
      createdAt: row!.createdAt.toISOString(),
    });
  },
);

export default router;
