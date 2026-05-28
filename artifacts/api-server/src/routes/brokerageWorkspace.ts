/**
 * Brokerage property workspaces — recent, reopen, attachments, share.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  brokerageWorkspaces,
  brokerageWorkspaceAttachments,
  type BrokerageAttachmentKind,
} from "@workspace/db";
import { brokerageCors } from "../middlewares/brokerageCors";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import {
  installIdFromRequest,
  requireInstallId,
} from "../lib/brokerageInstallId";
import {
  createWorkspaceShare,
  listingKeyFromAddress,
  loadWorkspacePackage,
  resolveShareByToken,
  serializeWorkspacePackage,
  touchWorkspaceOpen,
  upsertWorkspaceFromBrief,
} from "../lib/brokerageWorkspace";
import { recordGtmEvent } from "../lib/recordGtmEvent";

const ATTACHMENT_BODY = z.object({
  kind: z.enum(["link", "image", "pdf", "note"]),
  uri: z.string().url().optional(),
  body: z.string().max(20000).optional(),
  title: z.string().max(256).optional(),
});

const OPEN_BODY = z.object({
  address: z.string().min(1),
  mls_id: z.string().optional(),
  page_url: z.string().url().optional(),
  run_id: z.string().uuid().optional(),
});

const SHARE_BODY = z.object({
  collaboratorInstallId: z.string().min(8).max(128).optional(),
});

export const brokerageWorkspaceRouter: IRouter = Router();

brokerageWorkspaceRouter.use(brokerageCors);
brokerageWorkspaceRouter.use(brokerageAuth);

brokerageWorkspaceRouter.get(
  "/recent",
  async (req: Request, res: Response) => {
    const installId = requireInstallId(req, res);
    if (!installId) return;

    const limit = Math.min(
      Number.parseInt(String(req.query.limit ?? "20"), 10) || 20,
      50,
    );

    const rows = await db
      .select({
        id: brokerageWorkspaces.id,
        listingKey: brokerageWorkspaces.listingKey,
        address: brokerageWorkspaces.address,
        sourceListingUrl: brokerageWorkspaces.sourceListingUrl,
        latestRunId: brokerageWorkspaces.latestRunId,
        openedAt: brokerageWorkspaces.openedAt,
        updatedAt: brokerageWorkspaces.updatedAt,
      })
      .from(brokerageWorkspaces)
      .where(eq(brokerageWorkspaces.installId, installId))
      .orderBy(desc(brokerageWorkspaces.openedAt))
      .limit(limit);

    res.json({
      workspaces: rows.map((r) => ({
        id: r.id,
        listingKey: r.listingKey,
        address: r.address,
        sourceListingUrl: r.sourceListingUrl,
        latestRunId: r.latestRunId,
        openedAt: r.openedAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  },
);

brokerageWorkspaceRouter.post("/open", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const parse = OPEN_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request", message: "Invalid open body" });
    return;
  }

  const { address, mls_id, page_url, run_id } = parse.data;
  const listingKey = listingKeyFromAddress(address, mls_id);

  await upsertWorkspaceFromBrief({
    installId,
    listingKey,
    address,
    sourceListingUrl: page_url ?? null,
    runId: run_id ?? null,
  });

  const [ws] = await db
    .select()
    .from(brokerageWorkspaces)
    .where(
      and(
        eq(brokerageWorkspaces.installId, installId),
        eq(brokerageWorkspaces.listingKey, listingKey),
      ),
    )
    .limit(1);

  if (!ws) {
    res.status(500).json({ error: "workspace_missing" });
    return;
  }

  if (run_id) {
    await db
      .update(brokerageWorkspaces)
      .set({ latestRunId: run_id, updatedAt: new Date() })
      .where(eq(brokerageWorkspaces.id, ws.id));
  }

  await touchWorkspaceOpen(installId, ws.id);
  const pkg = await loadWorkspacePackage(ws.id);
  res.json(serializeWorkspacePackage(pkg!));
});

brokerageWorkspaceRouter.get(
  "/shared/:shareToken",
  async (req: Request, res: Response) => {
    const raw = req.params.shareToken;
    const shareToken = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!shareToken) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const resolved = await resolveShareByToken(shareToken);
    if (!resolved) {
      res.status(404).json({ error: "not_found", message: "Share not found or revoked" });
      return;
    }

    const viewerInstallId = installIdFromRequest(req);
    if (viewerInstallId) {
      recordGtmEvent({
        installId: viewerInstallId,
        eventType: "share_viewed",
        listingKey: resolved.package.workspace.listingKey,
        payload: { shareTokenPrefix: shareToken.slice(0, 8) },
      });
    }

    res.json({
      ...serializeWorkspacePackage(resolved.package),
      sharedByInstallId: resolved.share.ownerInstallId.slice(0, 8) + "…",
      shareCreatedAt: resolved.share.createdAt.toISOString(),
    });
  },
);

brokerageWorkspaceRouter.get("/:id", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const raw = req.params.id;
  const workspaceId = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!workspaceId) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const [ws] = await db
    .select()
    .from(brokerageWorkspaces)
    .where(
      and(
        eq(brokerageWorkspaces.id, workspaceId),
        eq(brokerageWorkspaces.installId, installId),
      ),
    )
    .limit(1);

  if (!ws) {
    res.status(404).json({ error: "not_found", message: "Workspace not found" });
    return;
  }

  await touchWorkspaceOpen(installId, workspaceId);
  const pkg = await loadWorkspacePackage(workspaceId);
  res.json(serializeWorkspacePackage(pkg!));
});

brokerageWorkspaceRouter.get(
  "/:id/attachments",
  async (req: Request, res: Response) => {
    const installId = requireInstallId(req, res);
    if (!installId) return;

    const workspaceId = String(req.params.id);
    const [ws] = await db
      .select({ id: brokerageWorkspaces.id })
      .from(brokerageWorkspaces)
      .where(
        and(
          eq(brokerageWorkspaces.id, workspaceId),
          eq(brokerageWorkspaces.installId, installId),
        ),
      )
      .limit(1);

    if (!ws) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const attachments = await db
      .select()
      .from(brokerageWorkspaceAttachments)
      .where(eq(brokerageWorkspaceAttachments.workspaceId, workspaceId))
      .orderBy(desc(brokerageWorkspaceAttachments.createdAt));

    res.json({
      attachments: attachments.map((a) => ({
        id: a.id,
        kind: a.kind,
        uri: a.uri,
        body: a.body,
        title: a.title,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  },
);

brokerageWorkspaceRouter.post(
  "/:id/attachments",
  async (req: Request, res: Response) => {
    const installId = requireInstallId(req, res);
    if (!installId) return;

    const parse = ATTACHMENT_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const workspaceId = String(req.params.id);
    const [ws] = await db
      .select({ id: brokerageWorkspaces.id })
      .from(brokerageWorkspaces)
      .where(
        and(
          eq(brokerageWorkspaces.id, workspaceId),
          eq(brokerageWorkspaces.installId, installId),
        ),
      )
      .limit(1);

    if (!ws) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { kind, uri, body, title } = parse.data;
    if ((kind === "note" && !body?.trim()) || (kind !== "note" && !uri?.trim())) {
      res.status(400).json({
        error: "invalid_attachment",
        message: "Notes require body; link/image/pdf require uri",
      });
      return;
    }

    const [row] = await db
      .insert(brokerageWorkspaceAttachments)
      .values({
        workspaceId,
        kind: kind as BrokerageAttachmentKind,
        uri: uri ?? null,
        body: body ?? null,
        title: title ?? null,
        createdByInstallId: installId,
      })
      .returning();

    res.status(201).json({
      id: row!.id,
      kind: row!.kind,
      uri: row!.uri,
      body: row!.body,
      title: row!.title,
      createdAt: row!.createdAt.toISOString(),
    });
  },
);

brokerageWorkspaceRouter.delete(
  "/:id/attachments/:attachmentId",
  async (req: Request, res: Response) => {
    const installId = requireInstallId(req, res);
    if (!installId) return;

    const workspaceId = String(req.params.id);
    const attachmentId = String(req.params.attachmentId);

    const [ws] = await db
      .select({ id: brokerageWorkspaces.id })
      .from(brokerageWorkspaces)
      .where(
        and(
          eq(brokerageWorkspaces.id, workspaceId),
          eq(brokerageWorkspaces.installId, installId),
        ),
      )
      .limit(1);

    if (!ws) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await db
      .delete(brokerageWorkspaceAttachments)
      .where(
        and(
          eq(brokerageWorkspaceAttachments.id, attachmentId),
          eq(brokerageWorkspaceAttachments.workspaceId, workspaceId),
        ),
      );

    res.json({ ok: true });
  },
);

brokerageWorkspaceRouter.post(
  "/:id/share",
  async (req: Request, res: Response) => {
    const installId = requireInstallId(req, res);
    if (!installId) return;

    const parse = SHARE_BODY.safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const workspaceId = String(req.params.id);
    const [ws] = await db
      .select()
      .from(brokerageWorkspaces)
      .where(
        and(
          eq(brokerageWorkspaces.id, workspaceId),
          eq(brokerageWorkspaces.installId, installId),
        ),
      )
      .limit(1);

    if (!ws) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const share = await createWorkspaceShare({
      workspaceId,
      ownerInstallId: installId,
      collaboratorInstallId: parse.data.collaboratorInstallId,
    });

    recordGtmEvent({
      installId,
      eventType: "share_created",
      listingKey: ws.listingKey,
      payload: {
        workspaceId,
        shareTokenPrefix: share.shareToken.slice(0, 8),
        collaboratorInstallId: parse.data.collaboratorInstallId ?? null,
      },
    });

    res.status(201).json({
      shareToken: share.shareToken,
      sharePath: `/api/brokerage/v1/workspaces/shared/${share.shareToken}`,
      createdAt: share.createdAt.toISOString(),
    });
  },
);
