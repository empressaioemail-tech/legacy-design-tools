/**
 * TX Comptroller Special Purpose District registry ingest.
 *
 * Pulls SPDPID entity records from data.texas.gov (Socrata SODA API)
 * and normalizes to the mudPidRegistry wire shape.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TxSpecialDistrictRecord } from "./mudPidRegistry";

/** SPDPID entity dimension — data.texas.gov resource (SB625). */
export const TX_SPDPID_ENTITIES_RESOURCE =
  "https://data.texas.gov/resource/8y3e-9i7w.json";

export interface TxSpecialDistrictIngestOptions {
  outputPath?: string;
  fetchImpl?: typeof fetch;
  limit?: number;
}

export interface TxSpecialDistrictIngestResult {
  outputPath: string;
  districtCount: number;
  fetchedAt: string;
}

function defaultOutputPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../data/tx-special-districts.json");
}

function normalizeDistrictType(name: string): TxSpecialDistrictRecord["districtType"] {
  const u = name.toUpperCase();
  if (u.includes("MUD")) return "MUD";
  if (u.includes("PID")) return "PID";
  if (u.includes("PUD")) return "PUD";
  return "OTHER";
}

export async function ingestTxSpecialDistrictsFromComptroller(
  options: TxSpecialDistrictIngestOptions = {},
): Promise<TxSpecialDistrictIngestResult> {
  const outputPath = options.outputPath ?? defaultOutputPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? 50_000;
  const rows: TxSpecialDistrictRecord[] = [];
  let offset = 0;
  const pageSize = 1000;

  for (;;) {
    const url = new URL(TX_SPDPID_ENTITIES_RESOURCE);
    url.searchParams.set("$limit", String(pageSize));
    url.searchParams.set("$offset", String(offset));
    url.searchParams.set(
      "$select",
      "spd_publ_id,entity_name,entity_type,entity_county,taxpayer_number",
    );

    const res = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `TX Comptroller SPDPID ingest failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Array<Record<string, string>>;
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const row of batch) {
      const name = String(row.entity_name ?? "").trim();
      if (!name) continue;
      rows.push({
        districtId: String(row.spd_publ_id ?? name),
        districtType: normalizeDistrictType(
          String(row.entity_type ?? name),
        ),
        name,
        county: row.entity_county ? String(row.entity_county) : null,
        taxUnitCode: row.taxpayer_number
          ? String(row.taxpayer_number)
          : null,
      });
    }

    offset += batch.length;
    if (batch.length < pageSize || offset >= limit) break;
  }

  const fetchedAt = new Date().toISOString();
  const payload = {
    source: "data.texas.gov SPDPID (TX Comptroller SB625)",
    fetchedAt,
    districts: rows,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");

  return {
    outputPath,
    districtCount: rows.length,
    fetchedAt,
  };
}
