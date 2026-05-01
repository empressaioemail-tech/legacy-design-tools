/**
 * Client-side avatar resize / re-encode.
 *
 * The avatar is rendered at 14–36px in timelines and ~40px in the admin
 * picker, so a multi-megabyte phone photo is wildly over-spec. We decode
 * the user's pick in the browser, take a center-cropped square, scale it
 * down to {@link AVATAR_TARGET_PX}, and re-encode as JPEG. The result is
 * usually <20KB and uploads in a single round trip.
 *
 * Falls back to the original `File` (returned untouched) if the browser
 * can't decode it (e.g. SVG without a rasterizer, exotic codec, or any
 * other decode error). That keeps the upload path forgiving — a slightly
 * heavy avatar is still better than a hard failure.
 */

const AVATAR_TARGET_PX = 256;
const AVATAR_JPEG_QUALITY = 0.85;
const RESIZED_CONTENT_TYPE = "image/jpeg";
const RESIZED_EXTENSION = "jpg";

export async function resizeAvatar(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) return file;

    // Center-crop to a square in source coordinates so the original aspect
    // ratio is preserved instead of being squashed by a non-uniform scale.
    const side = Math.min(width, height);
    const sx = Math.floor((width - side) / 2);
    const sy = Math.floor((height - side) / 2);

    // Don't upscale: tiny source images stay at their native resolution
    // (re-encoded only) so we don't bloat them by drawing into a 256² box.
    const targetSide = Math.min(AVATAR_TARGET_PX, side);

    const canvas = document.createElement("canvas");
    canvas.width = targetSide;
    canvas.height = targetSide;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, targetSide, targetSide);

    const blob = await canvasToBlob(canvas);
    if (!blob || blob.size === 0) return file;

    const baseName = stripExtension(file.name) || "avatar";
    return new File([blob], `${baseName}.${RESIZED_EXTENSION}`, {
      type: RESIZED_CONTENT_TYPE,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, RESIZED_CONTENT_TYPE, AVATAR_JPEG_QUALITY);
  });
}

function stripExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return name;
  return name.slice(0, lastDot);
}
