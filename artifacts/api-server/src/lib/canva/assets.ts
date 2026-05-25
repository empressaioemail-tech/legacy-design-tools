import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  briefingSources,
  db,
  engagements,
  parcelBriefings,
  renderOutputs,
  sheets,
  snapshots,
  viewpointRenders,
} from "@workspace/db";
import type { CanvaSelectableAsset } from "./wireTypes";

function sheetThumbUrl(sheetId: string): string {
  return `/api/sheets/${sheetId}/thumbnail.png`;
}

function renderFileUrl(outputId: string): string {
  return `/api/render-outputs/${outputId}/file`;
}

export async function listEngagementCanvaAssets(
  engagementId: string,
  baseUrl: string,
): Promise<CanvaSelectableAsset[] | null> {
  const [eng] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!eng) return null;

  const assets: CanvaSelectableAsset[] = [];

  const renderRows = await db
    .select({
      id: viewpointRenders.id,
      kind: viewpointRenders.kind,
      createdAt: viewpointRenders.createdAt,
    })
    .from(viewpointRenders)
    .where(
      and(
        eq(viewpointRenders.engagementId, engagementId),
        eq(viewpointRenders.status, "ready"),
      ),
    )
    .orderBy(desc(viewpointRenders.createdAt));

  if (renderRows.length > 0) {
    const outputRows = await db
      .select({
        viewpointRenderId: renderOutputs.viewpointRenderId,
        id: renderOutputs.id,
        role: renderOutputs.role,
        format: renderOutputs.format,
        mirroredObjectKey: renderOutputs.mirroredObjectKey,
      })
      .from(renderOutputs)
      .where(
        inArray(
          renderOutputs.viewpointRenderId,
          renderRows.map((r) => r.id),
        ),
      );

    const outputsByRender = new Map<string, typeof outputRows>();
    for (const out of outputRows) {
      const list = outputsByRender.get(out.viewpointRenderId) ?? [];
      list.push(out);
      outputsByRender.set(out.viewpointRenderId, list);
    }

    for (const render of renderRows) {
      const outs = outputsByRender.get(render.id) ?? [];
      const primary =
        outs.find((o) => o.role === "primary") ??
        outs.find((o) => o.role === "video-primary") ??
        outs[0];
      if (!primary?.mirroredObjectKey) continue;
      const fileType = (primary.format ?? "png").toUpperCase();
      assets.push({
        id: `render:${render.id}`,
        kind: "render",
        label:
          render.kind === "video"
            ? `Video render · ${render.id.slice(0, 8)}`
            : `Render · ${render.id.slice(0, 8)}`,
        fileType,
        thumbnailUrl: `${baseUrl}${renderFileUrl(primary.id)}`,
        exportable: true,
        sourceTab: "renders",
      });
    }
  }

  const [latestSnapshot] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.engagementId, engagementId))
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);

  if (latestSnapshot) {
    const sheetRows = await db
      .select({
        id: sheets.id,
        sheetNumber: sheets.sheetNumber,
        sheetName: sheets.sheetName,
      })
      .from(sheets)
      .where(eq(sheets.snapshotId, latestSnapshot.id))
      .orderBy(sheets.sortOrder);

    for (const sheet of sheetRows) {
      const isPlan =
        /plan|floor|level|a1/i.test(sheet.sheetNumber) ||
        /plan|floor|level/i.test(sheet.sheetName);
      assets.push({
        id: `sheet:${sheet.id}`,
        kind: isPlan ? "floorplan" : "sheet",
        label: `${sheet.sheetNumber} — ${sheet.sheetName}`,
        fileType: "PNG",
        thumbnailUrl: `${baseUrl}${sheetThumbUrl(sheet.id)}`,
        exportable: true,
        sourceTab: "sheets",
      });
      if (isPlan) {
        assets.push({
          id: `sheet:${sheet.id}:dwg`,
          kind: "floorplan",
          label: `${sheet.sheetNumber} — source DWG`,
          fileType: "DWG",
          exportable: false,
          disabledReason: "Export to PNG or PDF before sending to Canva",
          sourceTab: "sheets",
        });
      }
    }
  }

  const [briefing] = await db
    .select({ id: parcelBriefings.id })
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, engagementId))
    .orderBy(desc(parcelBriefings.createdAt))
    .limit(1);

  if (briefing) {
    const sources = await db
      .select({
        id: briefingSources.id,
        layerKind: briefingSources.layerKind,
        provider: briefingSources.provider,
      })
      .from(briefingSources)
      .where(
        and(
          eq(briefingSources.briefingId, briefing.id),
          isNull(briefingSources.supersededAt),
        ),
      )
      .orderBy(desc(briefingSources.createdAt))
      .limit(8);

    for (const src of sources) {
      assets.push({
        id: `site:${src.id}`,
        kind: "site-context",
        label: src.provider ?? src.layerKind,
        fileType: "PNG",
        thumbnailUrl: `${baseUrl}/api/briefing-sources/${src.id}/thumbnail.png`,
        exportable: true,
        sourceTab: "site",
      });
    }
  }

  return assets;
}

export function resolveAssetFetchUrl(
  assetId: string,
  baseUrl: string,
): string | null {
  if (assetId.startsWith("sheet:") && !assetId.endsWith(":dwg")) {
    const sheetId = assetId.slice("sheet:".length);
    return `${baseUrl}/api/sheets/${sheetId}/full.png`;
  }
  if (assetId.startsWith("site:")) {
    const sourceId = assetId.slice("site:".length);
    return `${baseUrl}/api/briefing-sources/${sourceId}/thumbnail.png`;
  }
  return null;
}

export async function resolveRenderableAssetUrl(
  assetId: string,
  baseUrl: string,
): Promise<string | null> {
  if (assetId.startsWith("render:")) {
    const renderId = assetId.slice("render:".length);
    const outs = await db
      .select({
        id: renderOutputs.id,
        role: renderOutputs.role,
        mirroredObjectKey: renderOutputs.mirroredObjectKey,
      })
      .from(renderOutputs)
      .where(eq(renderOutputs.viewpointRenderId, renderId));
    const primary =
      outs.find((o) => o.role === "primary") ??
      outs.find((o) => o.role === "video-primary") ??
      outs[0];
    if (!primary?.mirroredObjectKey) return null;
    return `${baseUrl}${renderFileUrl(primary.id)}`;
  }
  return resolveAssetFetchUrl(assetId, baseUrl);
}
