import {
  getRender,
  type RenderOutputProjection,
  type SheetSummary,
} from "@workspace/api-client-react";
import type { PublisherIntakeForm } from "./types";
import { exportPublisherIntakeCsv } from "./exportPublisherIntakeCsv";
import type {
  PublisherPackageManifest,
  PublisherPackageManifestItem,
  PublisherPackageSelection,
} from "./packageTypes";
import { downloadZipBlob, zipStore, type ZipEntry } from "./zipStore";

function apiBase(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return base.endsWith("/") ? base : `${base}/`;
}

function safeZipSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 72) || "asset";
}

function downloadHrefFor(output: RenderOutputProjection): string | null {
  if (output.downloadUrl) return output.downloadUrl;
  if (output.mirroredObjectKey) {
    return `/api/render-outputs/${output.id}/file?download=1`;
  }
  return output.previewUrl;
}

function sheetFullUrl(sheetId: string): string {
  return `${apiBase()}api/sheets/${sheetId}/full.png`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

function outputsForPackage(
  outputs: RenderOutputProjection[],
  isVideo: boolean,
): RenderOutputProjection[] {
  if (isVideo) {
    const primary = outputs.find((o) => o.role === "video-primary");
    return primary
      ? [primary]
      : outputs.filter((o) => o.format === "mp4" || o.format === "webm");
  }
  const preferred = outputs.filter(
    (o) =>
      o.role === "primary" ||
      o.role.startsWith("elevation-") ||
      o.role === "video-thumbnail",
  );
  return preferred.length > 0 ? preferred : outputs;
}

export interface DeliverablePackageExportResult {
  manifest: PublisherPackageManifest;
  fileCount: number;
  skipped: string[];
}

export async function buildDeliverablePackageZip({
  form,
  engagementName,
  selection,
  items,
  sheets,
  onProgress,
}: {
  form: PublisherIntakeForm;
  engagementName: string;
  selection: PublisherPackageSelection;
  items: PublisherPackageManifestItem[];
  sheets: SheetSummary[];
  onProgress?: (message: string) => void;
}): Promise<DeliverablePackageExportResult> {
  const zipEntries: ZipEntry[] = [];
  const skipped: string[] = [];

  if (selection.includeIntake) {
    onProgress?.("Adding intake sheet…");
    const csv = exportPublisherIntakeCsv(form, engagementName);
    zipEntries.push({
      name: "intake/publisher-intake.csv",
      data: new TextEncoder().encode(csv),
    });
  }

  for (const sheetId of selection.sheetIds) {
    const sheet = sheets.find((s) => s.id === sheetId);
    if (!sheet) {
      skipped.push(`Plan ${sheetId} (not found)`);
      continue;
    }
    const label = `${sheet.sheetNumber}-${sheet.sheetName}`;
    onProgress?.(`Adding plan ${sheet.sheetNumber}…`);
    try {
      const bytes = await fetchBytes(sheetFullUrl(sheet.id));
      zipEntries.push({
        name: `plans/${safeZipSegment(label)}.png`,
        data: bytes,
      });
    } catch (err) {
      skipped.push(
        `Plan ${sheet.sheetNumber} (${err instanceof Error ? err.message : "fetch failed"})`,
      );
    }
  }

  for (const renderId of selection.renderIds) {
    onProgress?.(`Adding rendering ${renderId.slice(0, 8)}…`);
    try {
      const detail = await getRender(renderId);
      const outputs = outputsForPackage(detail.outputs ?? [], false);
      if (outputs.length === 0) {
        skipped.push(`Rendering ${renderId} (no outputs)`);
        continue;
      }
      for (const output of outputs) {
        const href = downloadHrefFor(output);
        if (!href) {
          skipped.push(`Rendering ${renderId} / ${output.role} (no file URL)`);
          continue;
        }
        const bytes = await fetchBytes(href);
        zipEntries.push({
          name: `renderings/${safeZipSegment(renderId)}/${output.role}.${output.format}`,
          data: bytes,
        });
      }
    } catch (err) {
      skipped.push(
        `Rendering ${renderId} (${err instanceof Error ? err.message : "fetch failed"})`,
      );
    }
  }

  for (const videoId of selection.videoIds) {
    onProgress?.(`Adding video ${videoId.slice(0, 8)}…`);
    try {
      const detail = await getRender(videoId);
      const outputs = outputsForPackage(detail.outputs ?? [], true);
      if (outputs.length === 0) {
        skipped.push(`Video ${videoId} (no outputs)`);
        continue;
      }
      for (const output of outputs) {
        const href = downloadHrefFor(output);
        if (!href) {
          skipped.push(`Video ${videoId} / ${output.role} (no file URL)`);
          continue;
        }
        const bytes = await fetchBytes(href);
        zipEntries.push({
          name: `videos/${safeZipSegment(videoId)}/${output.role}.${output.format}`,
          data: bytes,
        });
      }
    } catch (err) {
      skipped.push(
        `Video ${videoId} (${err instanceof Error ? err.message : "fetch failed"})`,
      );
    }
  }

  const manifest: PublisherPackageManifest = {
    engagementName,
    exportedAt: new Date().toISOString(),
    includeIntake: selection.includeIntake,
    itemCount: items.length + (selection.includeIntake ? 1 : 0),
    items,
  };

  if (skipped.length > 0) {
    (manifest as PublisherPackageManifest & { skipped?: string[] }).skipped =
      skipped;
  }

  zipEntries.push({
    name: "manifest.json",
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  if (zipEntries.length === 1 && !selection.includeIntake) {
    throw new Error(
      "Nothing could be downloaded for this package. Check render/sheet availability.",
    );
  }

  onProgress?.("Building ZIP…");
  const archive = zipStore(zipEntries);
  const slug = safeZipSegment(engagementName);
  downloadZipBlob(
    new Blob([new Uint8Array(archive)], { type: "application/zip" }),
    `${slug || "plan"}-deliverable-package.zip`,
  );

  return {
    manifest,
    fileCount: zipEntries.length,
    skipped,
  };
}
