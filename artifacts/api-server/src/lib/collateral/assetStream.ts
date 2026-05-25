/**
 * Stream engagement asset bytes for signed collateral fetch (no session).
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Response } from "express";
import { eq } from "drizzle-orm";
import { db, renderOutputs, sheets, viewpointRenders } from "@workspace/db";
import { logger } from "../logger";
import {
  objectStorageClient,
  usesGcsApplicationDefaultCredentials,
} from "../objectStorage";
import { resolveRenderBucketName } from "../rendersObjectMirror";

export async function streamCollateralAsset(
  assetKey: string,
  res: Response,
): Promise<boolean> {
  if (assetKey.startsWith("render:")) {
    return streamRenderAsset(assetKey.slice("render:".length), res);
  }
  if (assetKey.startsWith("sheet:") && !assetKey.endsWith(":dwg")) {
    return streamSheetAsset(assetKey.slice("sheet:".length), res);
  }
  if (assetKey.startsWith("site:")) {
    return streamBriefingSourceThumb(assetKey.slice("site:".length), res);
  }
  return false;
}

async function streamRenderAsset(
  renderId: string,
  res: Response,
): Promise<boolean> {
  const outs = await db
    .select({
      id: renderOutputs.id,
      role: renderOutputs.role,
      format: renderOutputs.format,
      mirroredObjectKey: renderOutputs.mirroredObjectKey,
    })
    .from(renderOutputs)
    .where(eq(renderOutputs.viewpointRenderId, renderId));
  const primary =
    outs.find((o) => o.role === "primary") ??
    outs.find((o) => o.role === "video-primary") ??
    outs[0];
  if (!primary?.mirroredObjectKey) return false;
  if (!usesGcsApplicationDefaultCredentials) {
    res.status(503).json({ error: "collateral_asset_storage_unavailable" });
    return true;
  }
  let bucketName: string;
  try {
    bucketName = resolveRenderBucketName();
  } catch {
    res.status(503).json({ error: "collateral_asset_storage_unavailable" });
    return true;
  }
  const file = objectStorageClient
    .bucket(bucketName)
    .file(primary.mirroredObjectKey);
  const [exists] = await file.exists();
  if (!exists) return false;
  const [metadata] = await file.getMetadata();
  const contentType =
    (metadata.contentType as string | undefined) ??
    (primary.format === "png" ? "image/png" : "application/octet-stream");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=900");
  if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
  const stream = file.createReadStream();
  stream.on("error", (err) => {
    logger.error({ err, assetKey: `render:${renderId}` }, "collateral render stream");
    if (!res.headersSent) res.status(502).end();
    else res.destroy(err);
  });
  Readable.from(stream).pipe(res);
  return true;
}

async function streamSheetAsset(sheetId: string, res: Response): Promise<boolean> {
  const [row] = await db
    .select({ bytes: sheets.fullPng })
    .from(sheets)
    .where(eq(sheets.id, sheetId))
    .limit(1);
  if (!row?.bytes) return false;
  const buf = Buffer.isBuffer(row.bytes)
    ? row.bytes
    : Buffer.from(row.bytes as Uint8Array);
  const etag = `"${createHash("sha1").update(buf).digest("hex")}"`;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "public, max-age=900");
  res.setHeader("ETag", etag);
  res.end(buf);
  return true;
}

async function streamBriefingSourceThumb(
  _sourceId: string,
  _res: Response,
): Promise<boolean> {
  /** Site-context PNG route not implemented yet — skip until briefing thumbnail serve exists. */
  return false;
}

/** Asset keys allowed for a job (from request payload). */
export function assetKeysForJob(request: {
  assetIds: string[];
  slotMapping: Record<string, string>;
  sheetAssetIds?: string[];
}): Set<string> {
  const keys = new Set<string>(request.assetIds);
  for (const id of Object.values(request.slotMapping)) {
    if (id) keys.add(id);
  }
  for (const id of request.sheetAssetIds ?? []) {
    keys.add(id);
  }
  return keys;
}
