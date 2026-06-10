/**
 * Property Brief — workspace-scoped encumbrance upload (R4).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  isBrokerageServiceCaller,
  requireBrokerageExtensionAuthUnlessService,
} from "../middlewares/brokerageServiceAuth";
import { brokerageCors } from "../middlewares/brokerageCors";
import { requireInstallId } from "../lib/brokerageInstallId";
import { consumePdfUpload } from "../lib/encumbranceMultipart";
import {
  ingestEncumbrancePdfUpload,
  loadEncumbrancesForBrokerageWorkspace,
} from "../lib/encumbranceService";
import { listingKeyFromWorkspaceDid, workspaceDidFromListingKey } from "../lib/encumbranceScope";
import { requireBrokerageDevClient } from "../lib/brokerageExtensionPublic";
import { logger } from "../lib/logger";

export const brokerageEncumbrancesRouter: IRouter = Router();

brokerageEncumbrancesRouter.use(brokerageCors);
brokerageEncumbrancesRouter.use(requireBrokerageExtensionAuthUnlessService);
brokerageEncumbrancesRouter.use((req, res, next) => {
  if (isBrokerageServiceCaller(req)) {
    next();
    return;
  }
  requireBrokerageDevClient(req, res, next);
});

const WORKSPACE_DID_QUERY = z.object({
  workspaceDid: z.string().min(1),
});

brokerageEncumbrancesRouter.post(
  "/encumbrances/upload",
  async (req: Request, res: Response) => {
    const installId = isBrokerageServiceCaller(req)
      ? "mcp-service"
      : requireInstallId(req, res);
    if (!installId) return;

    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")) {
      res.status(415).json({ error: "expected_multipart" });
      return;
    }

    const parsed = await consumePdfUpload(req);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    const workspaceDid =
      parsed.upload.workspaceDid ??
      (typeof req.query.workspaceDid === "string" ? req.query.workspaceDid : undefined);

    if (!workspaceDid) {
      res.status(400).json({ error: "missing_workspace_did" });
      return;
    }

    const listingKey = listingKeyFromWorkspaceDid(workspaceDid);
    if (!listingKey) {
      res.status(400).json({ error: "invalid_workspace_did" });
      return;
    }

    try {
      const encumbrances = await ingestEncumbrancePdfUpload({
        upload: parsed.upload,
        scope: { kind: "brokerage", installId, listingKey },
      });
      res.status(201).json({
        workspaceDid: workspaceDidFromListingKey(listingKey),
        listingKey,
        ...encumbrances,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "pdf_too_large") {
        res.status(413).json({ error: "pdf_too_large" });
        return;
      }
      logger.error({ err, installId, listingKey }, "brokerage encumbrance upload failed");
      res.status(500).json({ error: "encumbrance_upload_failed" });
    }
  },
);

brokerageEncumbrancesRouter.get("/encumbrances", async (req: Request, res: Response) => {
  const installId = isBrokerageServiceCaller(req)
    ? "mcp-service"
    : requireInstallId(req, res);
  if (!installId) return;

  const q = WORKSPACE_DID_QUERY.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: "missing_workspace_did" });
    return;
  }

  const listingKey = listingKeyFromWorkspaceDid(q.data.workspaceDid);
  if (!listingKey) {
    res.status(400).json({ error: "invalid_workspace_did" });
    return;
  }

  try {
    const encumbrances = await loadEncumbrancesForBrokerageWorkspace({
      installId,
      listingKey,
    });
    res.json({
      workspaceDid: workspaceDidFromListingKey(listingKey),
      listingKey,
      ...encumbrances,
    });
  } catch (err) {
    logger.error({ err, installId, listingKey }, "brokerage encumbrances list failed");
    res.status(500).json({ error: "encumbrances_list_failed" });
  }
});
