/**
 * Smart Files data-room query layer (G-56).
 * Reads placements as placed-on edges; never reconstructs folder membership from entityId.
 */

import { and, asc, eq } from "drizzle-orm";
import {
  db,
  smartFileDocuments,
  smartFileFolderRecords,
  smartFileFolders,
  smartFilePlacements,
  smartFileVersions,
  type SmartFileAccessPolicyValue,
  type SmartFileScopeTypeValue,
} from "@workspace/db";

import {
  readDocument,
} from "./smartFileStore";
import type { SmartFileReadResult } from "../atoms/smart-file.contract";

export interface FolderSummary {
  folderId: string;
  label: string;
  scopeType: SmartFileScopeTypeValue;
  scopeId: string;
  accessPolicy: SmartFileAccessPolicyValue;
  parentFolderId: string | null;
}

export interface FolderFileSummary {
  entityId: string;
  title: string;
  accessPolicy: SmartFileAccessPolicyValue;
  currentVersion: number;
  scopeType: SmartFileScopeTypeValue;
  scopeId: string;
  docSlug: string;
  placementCount: number;
}

export async function listFoldersForScope(input: {
  scopeType: SmartFileScopeTypeValue;
  scopeId: string;
}): Promise<FolderSummary[]> {
  const rows = await db
    .select()
    .from(smartFileFolders)
    .where(
      and(
        eq(smartFileFolders.scopeType, input.scopeType),
        eq(smartFileFolders.scopeId, input.scopeId),
      ),
    )
    .orderBy(asc(smartFileFolders.label));

  return rows.map((r) => ({
    folderId: r.folderId,
    label: r.label,
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    accessPolicy: r.accessPolicy,
    parentFolderId: r.parentFolderId,
  }));
}

/**
 * List file-shaped documents in a folder via placed-on edges only.
 * Counting rule: DISTINCT smart_file_documents.id joined from placements
 * WHERE target_type='folder' AND target_id=folderId.
 */
export async function listFilesInFolder(folderId: string): Promise<{
  folder: FolderSummary | null;
  files: FolderFileSummary[];
}> {
  const [folder] = await db
    .select()
    .from(smartFileFolders)
    .where(eq(smartFileFolders.folderId, folderId))
    .limit(1);

  if (!folder) {
    return { folder: null, files: [] };
  }

  const placements = await db
    .select({
      documentId: smartFilePlacements.documentId,
      documentEntityId: smartFilePlacements.documentEntityId,
    })
    .from(smartFilePlacements)
    .where(
      and(
        eq(smartFilePlacements.targetType, "folder"),
        eq(smartFilePlacements.targetId, folderId),
      ),
    );

  const seen = new Map<string, number>();
  for (const p of placements) {
    seen.set(p.documentId, (seen.get(p.documentId) ?? 0) + 1);
  }

  const files: FolderFileSummary[] = [];
  for (const [documentId, placementCount] of seen) {
    const [doc] = await db
      .select()
      .from(smartFileDocuments)
      .where(eq(smartFileDocuments.id, documentId))
      .limit(1);
    if (!doc) continue;
    files.push({
      entityId: doc.entityId,
      title: doc.title,
      accessPolicy: doc.accessPolicy,
      currentVersion: doc.currentVersion,
      scopeType: doc.scopeType,
      scopeId: doc.scopeId,
      docSlug: doc.docSlug,
      placementCount,
    });
  }

  files.sort((a, b) => a.title.localeCompare(b.title));

  return {
    folder: {
      folderId: folder.folderId,
      label: folder.label,
      scopeType: folder.scopeType,
      scopeId: folder.scopeId,
      accessPolicy: folder.accessPolicy,
      parentFolderId: folder.parentFolderId,
    },
    files,
  };
}

export async function listPlacementsForEntity(
  entityId: string,
): Promise<
  ReadonlyArray<{
    targetType: string;
    targetId: string;
    placedAt: string;
    placedBy: string | null;
  }>
> {
  const rows = await db
    .select()
    .from(smartFilePlacements)
    .where(eq(smartFilePlacements.documentEntityId, entityId))
    .orderBy(asc(smartFilePlacements.placedAt));

  return rows.map((r) => ({
    targetType: r.targetType,
    targetId: r.targetId,
    placedAt: r.placedAt.toISOString(),
    placedBy: r.placedBy,
  }));
}

export async function listFolderRecords(folderId: string): Promise<
  ReadonlyArray<{
    recordEntityId: string;
    entityType: string;
    payload: unknown;
    accessPolicy: SmartFileAccessPolicyValue;
  }>
> {
  const rows = await db
    .select()
    .from(smartFileFolderRecords)
    .where(eq(smartFileFolderRecords.folderId, folderId));

  return rows.map((r) => ({
    recordEntityId: r.recordEntityId,
    entityType: r.entityType,
    payload: r.payload,
    accessPolicy: r.accessPolicy,
  }));
}

export async function listDocumentVersions(entityId: string): Promise<
  ReadonlyArray<{
    version: number;
    contentCid: string;
    contentType: string;
    computedAt: string;
    supersededAt: string | null;
  }>
> {
  const rows = await db
    .select()
    .from(smartFileVersions)
    .where(eq(smartFileVersions.documentEntityId, entityId))
    .orderBy(asc(smartFileVersions.version));

  return rows.map((r) => ({
    version: r.version,
    contentCid: r.contentCid,
    contentType: r.contentType,
    computedAt: r.computedAt.toISOString(),
    supersededAt: r.supersededAt?.toISOString() ?? null,
  }));
}

export async function readSmartFileDocument(input: {
  entityId: string;
  version?: number;
  stalenessThresholdSeconds?: number;
}): Promise<SmartFileReadResult> {
  return readDocument(input);
}
