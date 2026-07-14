/**
 * Zip extraction for CAD export drops (yauzl — streaming, zip64-aware;
 * the PACS zips hold single entries past 1 GB, so no whole-archive
 * buffering).
 *
 * Only entries the ingest can use are extracted:
 *  - PACS drops: `*APPRAISAL_INFO.TXT` + `*APPRAISAL_IMPROVEMENT_DETAIL.TXT`
 *    (the other record files, incl. the GB-scale ENTITY_INFO, are skipped).
 *  - Orion drops (Hays): nested `.zip` + `.txt`/`.csv` entries; nested
 *    zips are extracted one level deep (Hays wraps each record-type
 *    file in its own zip inside the drop).
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export type EntryFilter = (entryName: string) => boolean;

export const PACS_ENTRY_FILTER: EntryFilter = (name) =>
  /APPRAISAL_INFO\.TXT$/i.test(name) ||
  /APPRAISAL_IMPROVEMENT_DETAIL\.TXT$/i.test(name);

export const ORION_ENTRY_FILTER: EntryFilter = (name) =>
  /\.(zip|txt|csv)$/i.test(name);

/**
 * Extract entries matching `filter` from `zipPath` into `destDir`
 * (flattened to basenames). Returns extracted file paths.
 */
export function extractZipEntries(
  zipPath: string,
  destDir: string,
  filter: EntryFilter,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const extracted: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error(`could not open ${zipPath}`));
        return;
      }
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        const isDir = /\/$/.test(entry.fileName);
        if (isDir || !filter(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            zip.close();
            reject(streamErr ?? new Error(`could not read ${entry.fileName}`));
            return;
          }
          const dest = join(destDir, basename(entry.fileName));
          log(`extracting ${entry.fileName} (${entry.uncompressedSize} bytes)`);
          mkdir(destDir, { recursive: true })
            .then(() => pipeline(readStream, createWriteStream(dest)))
            .then(() => {
              extracted.push(dest);
              zip.readEntry();
            })
            .catch((e: unknown) => {
              zip.close();
              reject(e);
            });
        });
      });
      zip.on("end", () => resolve(extracted));
      zip.readEntry();
    });
  });
}

/**
 * Extract a CAD drop, following nested zips one level deep. Returns
 * every extracted non-zip file path.
 */
export async function extractCadDrop(
  zipPath: string,
  destDir: string,
  filter: EntryFilter,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const first = await extractZipEntries(zipPath, destDir, filter, log);
  const files: string[] = [];
  for (const f of first) {
    if (/\.zip$/i.test(f)) {
      const nested = await extractZipEntries(f, destDir, filter, log);
      files.push(...nested.filter((n) => !/\.zip$/i.test(n)));
    } else {
      files.push(f);
    }
  }
  return files;
}
