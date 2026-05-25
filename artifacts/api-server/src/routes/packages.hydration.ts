import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  renderOutputs,
  sheets,
  viewpointRenders,
  type EngagementPackage,
} from "@workspace/db";
import type { PackageSelectionJson } from "@workspace/db";
import {
  type PackageShareAssetRender,
  type PackageShareAssetSheet,
  type PackageShareAssets,
  type PackageSelectionContext,
  sanitizePackageSelection,
} from "./packages.logic";

export async function loadPackageSelectionContext(
  engagementId: string,
  snapshotId: string | null,
): Promise<PackageSelectionContext> {
  const renderRows = await db
    .select({ id: viewpointRenders.id, kind: viewpointRenders.kind })
    .from(viewpointRenders)
    .where(
      and(
        eq(viewpointRenders.engagementId, engagementId),
        eq(viewpointRenders.status, "ready"),
      ),
    );

  const renderIds = new Set<string>();
  const videoIds = new Set<string>();
  for (const row of renderRows) {
    renderIds.add(row.id);
    if (row.kind === "video") {
      videoIds.add(row.id);
    }
  }

  const sheetIds = new Set<string>();
  if (snapshotId) {
    const sheetRows = await db
      .select({ id: sheets.id })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId));
    for (const row of sheetRows) {
      sheetIds.add(row.id);
    }
  }

  return { renderIds, videoIds, sheetIds };
}

function primaryPreviewUrl(
  outputs: Array<{ id: string; role: string; mirroredObjectKey: string | null }>,
): string | null {
  const primary =
    outputs.find((o) => o.role === "primary") ??
    outputs.find((o) => o.role === "video-primary") ??
    outputs[0];
  return primary?.mirroredObjectKey
    ? `/api/render-outputs/${primary.id}/file`
    : null;
}

async function loadRenderAssets(
  renderIds: string[],
  videoIds: string[],
): Promise<{ renders: PackageShareAssetRender[]; videos: PackageShareAssetRender[] }> {
  const allIds = [...new Set([...renderIds, ...videoIds])];
  if (allIds.length === 0) {
    return { renders: [], videos: [] };
  }

  const rows = await db
    .select({
      id: viewpointRenders.id,
      kind: viewpointRenders.kind,
      createdAt: viewpointRenders.createdAt,
    })
    .from(viewpointRenders)
    .where(inArray(viewpointRenders.id, allIds));

  const outputRows = await db
    .select({
      viewpointRenderId: renderOutputs.viewpointRenderId,
      id: renderOutputs.id,
      role: renderOutputs.role,
      mirroredObjectKey: renderOutputs.mirroredObjectKey,
    })
    .from(renderOutputs)
    .where(inArray(renderOutputs.viewpointRenderId, allIds));

  const outputsByRender = new Map<
    string,
    Array<{ id: string; role: string; mirroredObjectKey: string | null }>
  >();
  for (const out of outputRows) {
    const list = outputsByRender.get(out.viewpointRenderId) ?? [];
    list.push(out);
    outputsByRender.set(out.viewpointRenderId, list);
  }

  const toAsset = (row: (typeof rows)[number]): PackageShareAssetRender => {
    const kindLabel =
      row.kind === "video"
        ? "Video"
        : row.kind === "elevation-set"
          ? "Elevation set"
          : "Still render";
    const date = row.createdAt.toISOString().slice(0, 10);
    return {
      id: row.id,
      kind: row.kind,
      label: `${kindLabel} · ${date}`,
      previewUrl: primaryPreviewUrl(outputsByRender.get(row.id) ?? []),
    };
  };

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const renders = renderIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map(toAsset);
  const videos = videoIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map(toAsset);

  return { renders, videos };
}

async function loadSheetAssets(
  sheetIds: string[],
): Promise<PackageShareAssetSheet[]> {
  if (sheetIds.length === 0) return [];
  const rows = await db
    .select({
      id: sheets.id,
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
    })
    .from(sheets)
    .where(inArray(sheets.id, sheetIds));

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return sheetIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map((row) => ({
      id: row.id,
      sheetNumber: row.sheetNumber,
      sheetName: row.sheetName,
      thumbnailUrl: `/api/sheets/${row.id}/thumbnail.png`,
    }));
}

export async function hydratePackageShareAssets(
  pkg: EngagementPackage,
  selectionOverride?: PackageSelectionJson,
): Promise<PackageShareAssets> {
  const ctx = await loadPackageSelectionContext(
    pkg.engagementId,
    pkg.snapshotId,
  );
  const selection = sanitizePackageSelection(
    selectionOverride ?? (pkg.selection as PackageSelectionJson | undefined),
    ctx,
  );

  const renderIds = selection.renderIds ?? [];
  const videoIds = selection.videoIds ?? [];
  const sheetIds = selection.sheetIds ?? [];

  const [{ renders, videos }, sheetAssets] = await Promise.all([
    loadRenderAssets(renderIds, videoIds),
    loadSheetAssets(sheetIds),
  ]);

  const heroId = selection.heroRenderId ?? null;
  const heroRender =
    (heroId ? renders.find((r) => r.id === heroId) : null) ??
  renders[0] ??
    null;

  return {
    heroRender,
    renders,
    videos,
    sheets: sheetAssets,
  };
}
