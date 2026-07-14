/**
 * Streaming download of a CAD export to disk.
 *
 * CAD websites (WordPress fronted by various WAFs) 403 bare
 * `curl`/undici user agents, and several present certificates that
 * fail Windows schannel revocation checks — so we send a browser UA
 * and stream straight to disk (the drops are tens to hundreds of MB;
 * never buffer them).
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/** Derive a safe local filename from a URL. */
export function filenameFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const base = decodeURIComponent(path.split("/").pop() ?? "download");
  const safe = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return safe.length > 0 ? safe : "download";
}

/**
 * Download `url` into `destDir`, following redirects. Returns the
 * local file path.
 */
export async function downloadToFile(
  url: string,
  destDir: string,
  log: (msg: string) => void = () => {},
): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, filenameFromUrl(url));
  await mkdir(dirname(dest), { recursive: true });

  log(`downloading ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
    redirect: "follow",
  });
  if (!res.ok || res.body === null) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    createWriteStream(dest),
  );
  log(`saved ${dest}`);
  return dest;
}
