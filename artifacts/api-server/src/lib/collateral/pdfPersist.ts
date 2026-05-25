import { randomUUID } from "node:crypto";
import {
  objectStorageClient,
  usesGcsApplicationDefaultCredentials,
} from "../objectStorage";
import { resolveRenderBucketName } from "../rendersObjectMirror";

/** Copy Placid PDF to GCS when ADC is available; otherwise return source URL. */
export async function persistCollateralPdfFromUrl(
  sourceUrl: string,
  jobId: string,
): Promise<string> {
  if (!usesGcsApplicationDefaultCredentials) {
    return sourceUrl;
  }
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Failed to download Placid PDF (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const bucketName = resolveRenderBucketName();
  const key = `collateral-exports/${jobId}/${randomUUID()}.pdf`;
  const file = objectStorageClient.bucket(bucketName).file(key);
  await file.save(buf, {
    contentType: "application/pdf",
    resumable: false,
  });
  return `/api/storage/object/${encodeURIComponent(key)}`;
}
