/**
 * Smart Files data-room HTTP routes (G-56 / Layer 1.5).
 *
 *   GET /api/smart-files/folders?scopeType=&scopeId=
 *   GET /api/smart-files/folders/:folderId/files
 *   GET /api/smart-files/folders/:folderId/records
 *   GET /api/smart-files/files/:entityId
 *   GET /api/smart-files/files/:entityId/placements
 *   GET /api/smart-files/files/:entityId/versions
 *   GET /api/smart-files/files/:entityId/attachment?version=
 *
 * Bearer service token required. accessPolicy enforced on every read.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { isSmartFileHeld } from "../atoms/smart-file.contract";
import {
  accessSubjectFromRequest,
  canReadSmartFilePolicy,
} from "../lib/smartFileAccess";
import {
  listDocumentVersions,
  listFilesInFolder,
  listFolderRecords,
  listFoldersForScope,
  listPlacementsForEntity,
  readSmartFileDocument,
} from "../lib/smartFileServe";
import { requireServiceToken } from "../middlewares/serviceAuth";
import {
  SMART_FILE_SCOPE_TYPES,
  type SmartFileScopeType,
} from "../atoms/smart-file.contract";

const router: IRouter = Router();

router.use(requireServiceToken);

function denyAccess(res: Response, policy: string): void {
  res.status(403).json({
    error: "access_denied",
    accessPolicy: policy,
    message: "Caller is not permitted to read this resource.",
  });
}

function parseScopeType(raw: unknown): SmartFileScopeType | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  return (SMART_FILE_SCOPE_TYPES as readonly string[]).includes(v)
    ? (v as SmartFileScopeType)
    : null;
}

function seedBlobPath(contentCid: string): string {
  const dir =
    process.env.SMART_FILES_SEED_BLOB_DIR?.trim() ||
    join(process.cwd(), "artifacts", "api-server", "seed-blobs", "smart-files");
  return join(dir, `${contentCid}.bin`);
}

router.get("/folders", async (req: Request, res: Response) => {
  const scopeType = parseScopeType(req.query.scopeType);
  const scopeId =
    typeof req.query.scopeId === "string" ? req.query.scopeId.trim() : "";
  if (!scopeType || !scopeId) {
    res.status(400).json({ error: "scopeType and scopeId are required" });
    return;
  }

  const subject = accessSubjectFromRequest(req);
  const folders = await listFoldersForScope({ scopeType, scopeId });
  const allowed = folders.filter((f) =>
    canReadSmartFilePolicy(subject, f.accessPolicy),
  );

  if (allowed.length === 0 && folders.length > 0) {
    denyAccess(res, folders[0]!.accessPolicy);
    return;
  }

  res.json({ scopeType, scopeId, folders: allowed, servedAt: new Date().toISOString() });
});

router.get("/folders/:folderId/files", async (req: Request, res: Response) => {
  const folderId = String(req.params.folderId ?? "");
  const { folder, files } = await listFilesInFolder(folderId);

  if (!folder) {
    res.status(404).json({
      error: "folder_not_found",
      folderId,
      absence: {
        status: "not-sought",
        basis: `No folder registered for id ${JSON.stringify(folderId)}.`,
      },
    });
    return;
  }

  const subject = accessSubjectFromRequest(req);
  if (!canReadSmartFilePolicy(subject, folder.accessPolicy)) {
    denyAccess(res, folder.accessPolicy);
    return;
  }

  const allowedFiles = files.filter((f) =>
    canReadSmartFilePolicy(subject, f.accessPolicy, f.scopeType === "jurisdiction" ? f.scopeId : null),
  );

  res.json({
    folder,
    files: allowedFiles,
    countingRule:
      "DISTINCT smart_file_documents.id via smart_file_placements WHERE target_type='folder' AND target_id=folderId",
    servedAt: new Date().toISOString(),
  });
});

router.get("/folders/:folderId/records", async (req: Request, res: Response) => {
  const folderId = String(req.params.folderId ?? "");
  const { folder } = await listFilesInFolder(folderId);
  if (!folder) {
    res.status(404).json({ error: "folder_not_found", folderId });
    return;
  }

  const subject = accessSubjectFromRequest(req);
  if (!canReadSmartFilePolicy(subject, folder.accessPolicy)) {
    denyAccess(res, folder.accessPolicy);
    return;
  }

  const records = await listFolderRecords(folderId);
  const allowed = records.filter((r) =>
    canReadSmartFilePolicy(subject, r.accessPolicy),
  );

  res.json({ folderId, records: allowed, servedAt: new Date().toISOString() });
});

router.get("/files/:entityId", async (req: Request, res: Response) => {
  const entityId = decodeURIComponent(String(req.params.entityId ?? ""));
  const versionRaw = req.query.version;
  const version =
    typeof versionRaw === "string" && versionRaw.length > 0
      ? Number.parseInt(versionRaw, 10)
      : undefined;

  const result = await readSmartFileDocument({
    entityId,
    version: Number.isFinite(version) ? version : undefined,
  });

  if (!isSmartFileHeld(result)) {
    res.status(result.status === "held-version-absent" ? 404 : 200).json(result);
    return;
  }

  const subject = accessSubjectFromRequest(req);
  const jTenant =
    result.document.scopeType === "jurisdiction" ? result.document.scopeId : null;
  if (!canReadSmartFilePolicy(subject, result.document.accessPolicy, jTenant)) {
    denyAccess(res, result.document.accessPolicy);
    return;
  }

  const versions = await listDocumentVersions(entityId);
  res.json({
    ...result,
    versions,
    attachmentPath: `/api/smart-files/files/${encodeURIComponent(entityId)}/attachment?version=${result.version.version}`,
    servedAt: new Date().toISOString(),
  });
});

router.get("/files/:entityId/placements", async (req: Request, res: Response) => {
  const entityId = decodeURIComponent(String(req.params.entityId ?? ""));
  const result = await readSmartFileDocument({ entityId });
  if (!isSmartFileHeld(result)) {
    res.status(404).json(result);
    return;
  }

  const subject = accessSubjectFromRequest(req);
  const jTenant =
    result.document.scopeType === "jurisdiction" ? result.document.scopeId : null;
  if (!canReadSmartFilePolicy(subject, result.document.accessPolicy, jTenant)) {
    denyAccess(res, result.document.accessPolicy);
    return;
  }

  const placements = await listPlacementsForEntity(entityId);
  res.json({ entityId, placements, servedAt: new Date().toISOString() });
});

router.get("/files/:entityId/attachment", async (req: Request, res: Response) => {
  const entityId = decodeURIComponent(String(req.params.entityId ?? ""));
  const versionRaw = req.query.version;
  const version =
    typeof versionRaw === "string" && versionRaw.length > 0
      ? Number.parseInt(versionRaw, 10)
      : undefined;

  const result = await readSmartFileDocument({
    entityId,
    version: Number.isFinite(version) ? version : undefined,
  });

  if (!isSmartFileHeld(result)) {
    res.status(404).json({
      error: "attachment_unavailable",
      read: result,
    });
    return;
  }

  const subject = accessSubjectFromRequest(req);
  const jTenant =
    result.document.scopeType === "jurisdiction" ? result.document.scopeId : null;
  if (!canReadSmartFilePolicy(subject, result.document.accessPolicy, jTenant)) {
    denyAccess(res, result.document.accessPolicy);
    return;
  }

  const { contentCid, contentType } = result.version;
  const blobPath = seedBlobPath(contentCid);
  if (!existsSync(blobPath)) {
    res.status(404).json({
      error: "blob_not_pinned",
      contentCid,
      message:
        "Bytes for this version are not available on this deployment. Document metadata is held.",
    });
    return;
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Smart-File-Entity-Id", entityId);
  res.setHeader("X-Content-Cid", contentCid);
  createReadStream(blobPath).pipe(res);
});

export { router as smartFilesRouter };
