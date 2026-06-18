/**
 * Property Brief — workspace-scoped encumbrance upload (R4).
 *
 * Presign routes (request-upload-url / complete-upload) are available to
 * extension_public installs. Multipart upload + list remain operator/dev tier.
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
  ingestEncumbrancePresignedUpload,
  loadEncumbrancesForBrokerageWorkspace,
} from "../lib/encumbranceService";
import { listingKeyFromWorkspaceDid, workspaceDidFromListingKey } from "../lib/encumbranceScope";
import { requireBrokerageDevClient } from "../lib/brokerageExtensionPublic";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

export const brokerageEncumbrancesRouter: IRouter = Router();

/** PB-301 — matches multipart cap in encumbranceMultipart.ts */
export const BROKERAGE_ENCUMBRANCE_PRESIGN_MAX_BYTES = 25 * 1024 * 1024;
export const BROKERAGE_ENCUMBRANCE_PRESIGN_CONTENT_TYPE = "application/pdf" as const;

const objectStorageService = new ObjectStorageService();

brokerageEncumbrancesRouter.use(brokerageCors);
brokerageEncumbrancesRouter.use(requireBrokerageExtensionAuthUnlessService);

const WORKSPACE_DID_QUERY = z.object({
  workspaceDid: z.string().min(1),
});

const PRESIGN_BODY = z.object({
  workspaceDid: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().positive(),
  contentType: z.literal(BROKERAGE_ENCUMBRANCE_PRESIGN_CONTENT_TYPE),
});

const COMPLETE_UPLOAD_BODY = z.object({
  workspaceDid: z.string().min(1),
  objectPath: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().positive(),
  contentType: z.literal(BROKERAGE_ENCUMBRANCE_PRESIGN_CONTENT_TYPE),
});

function resolveBrokerageScope(
  req: Request,
  res: Response,
  workspaceDid: string,
): { installId: string; listingKey: string } | null {
  const installId = isBrokerageServiceCaller(req)
    ? "mcp-service"
    : requireInstallId(req, res);
  if (!installId) return null;

  const listingKey = listingKeyFromWorkspaceDid(workspaceDid);
  if (!listingKey) {
    res.status(400).json({ error: "invalid_workspace_did" });
    return null;
  }
  return { installId, listingKey };
}

/** Presign — extension_public + operator (PB-301). */
brokerageEncumbrancesRouter.post(
  "/encumbrances/request-upload-url",
  async (req: Request, res: Response) => {
    const parsed = PRESIGN_BODY.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_upload_metadata" });
      return;
    }
    if (parsed.data.size > BROKERAGE_ENCUMBRANCE_PRESIGN_MAX_BYTES) {
      res.status(413).json({
        error: `Upload too large: ${parsed.data.size} bytes exceeds the ${BROKERAGE_ENCUMBRANCE_PRESIGN_MAX_BYTES}-byte cap.`,
      });
      return;
    }

    const scope = resolveBrokerageScope(req, res, parsed.data.workspaceDid);
    if (!scope) return;

    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json({
        uploadURL,
        objectPath,
        workspaceDid: workspaceDidFromListingKey(scope.listingKey),
        metadata: {
          name: parsed.data.name,
          size: parsed.data.size,
          contentType: parsed.data.contentType,
        },
      });
    } catch (err) {
      logger.error({ err, installId: scope.installId }, "brokerage encumbrance presign failed");
      res.status(500).json({ error: "presign_failed" });
    }
  },
);

/** Complete presigned upload — tenant-private CC&R ingest. */
brokerageEncumbrancesRouter.post(
  "/encumbrances/complete-upload",
  async (req: Request, res: Response) => {
    const parsed = COMPLETE_UPLOAD_BODY.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_complete_upload_body" });
      return;
    }
    if (parsed.data.size > BROKERAGE_ENCUMBRANCE_PRESIGN_MAX_BYTES) {
      res.status(413).json({ error: "pdf_too_large" });
      return;
    }
    if (!parsed.data.objectPath.startsWith("/objects/")) {
      res.status(400).json({ error: "invalid_object_path" });
      return;
    }

    const scope = resolveBrokerageScope(req, res, parsed.data.workspaceDid);
    if (!scope) return;

    let fileBytes: Buffer;
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(
        parsed.data.objectPath,
      );
      const response = await objectStorageService.downloadObject(objectFile);
      if (!response.body) {
        res.status(404).json({ error: "uploaded_object_missing" });
        return;
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > BROKERAGE_ENCUMBRANCE_PRESIGN_MAX_BYTES) {
            res.status(413).json({ error: "pdf_too_large" });
            return;
          }
          chunks.push(value);
        }
      }
      fileBytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } catch (err) {
      logger.error(
        { err, objectPath: parsed.data.objectPath },
        "brokerage encumbrance complete-upload fetch failed",
      );
      res.status(404).json({ error: "uploaded_object_missing" });
      return;
    }

    try {
      const encumbrances = await ingestEncumbrancePresignedUpload({
        objectPath: parsed.data.objectPath,
        filename: parsed.data.name,
        contentType: parsed.data.contentType,
        bytes: fileBytes,
        scope: {
          kind: "brokerage",
          installId: scope.installId,
          listingKey: scope.listingKey,
        },
      });
      res.status(201).json({
        workspaceDid: workspaceDidFromListingKey(scope.listingKey),
        listingKey: scope.listingKey,
        ...encumbrances,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "pdf_too_large") {
        res.status(413).json({ error: "pdf_too_large" });
        return;
      }
      logger.error({ err, installId: scope.installId }, "brokerage encumbrance complete-upload failed");
      res.status(500).json({ error: "encumbrance_upload_failed" });
    }
  },
);

brokerageEncumbrancesRouter.use((req, res, next) => {
  if (isBrokerageServiceCaller(req)) {
    next();
    return;
  }
  requireBrokerageDevClient(req, res, next);
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
