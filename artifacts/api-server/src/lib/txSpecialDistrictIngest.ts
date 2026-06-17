/**
 * TX Comptroller Special Purpose District registry ingest.
 *
 * Pulls SPDPID entity records from the Comptroller open-data CSV bundle
 * (https://assets.comptroller.texas.gov/open-data-files/spdpid-entity.csv)
 * and normalizes to the mudPidRegistry wire shape.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveTxSpecialDistrictsDataPath } from "./brokerageFederalDataPaths";
import type { TxSpecialDistrictRecord } from "./mudPidRegistry";

/** Official Comptroller SPDPID entity export (SB625). */
export const TX_SPDPID_ENTITY_CSV_URL =
  "https://assets.comptroller.texas.gov/open-data-files/spdpid-entity.csv";

export interface TxSpecialDistrictIngestOptions {
  outputPath?: string;
  fetchImpl?: typeof fetch;
  csvUrl?: string;
}

export interface TxSpecialDistrictIngestResult {
  outputPath: string;
  districtCount: number;
  fetchedAt: string;
  sourceRows: number;
}

/** Parse one CSV row respecting double-quoted fields. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeDistrictType(
  entityType: string,
  name: string,
): TxSpecialDistrictRecord["districtType"] {
  const u = `${entityType} ${name}`.toUpperCase();
  if (u.includes("MUD") || u.includes("MUNICIPAL UTILITY")) return "MUD";
  if (u.includes("PID") || u.includes("PUBLIC IMPROVEMENT")) return "PID";
  if (u.includes("PUD") || u.includes("PLANNED UNIT")) return "PUD";
  return "OTHER";
}

export async function ingestTxSpecialDistrictsFromComptroller(
  options: TxSpecialDistrictIngestOptions = {},
): Promise<TxSpecialDistrictIngestResult> {
  const outputPath = options.outputPath ?? resolveTxSpecialDistrictsDataPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const csvUrl = options.csvUrl ?? TX_SPDPID_ENTITY_CSV_URL;

  const res = await fetchImpl(csvUrl, {
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    throw new Error(
      `TX Comptroller SPDPID ingest failed (${res.status}): ${await res.text()}`,
    );
  }

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("TX Comptroller SPDPID CSV was empty");
  }

  const header = parseCsvLine(lines[0]!);
  const idx = (name: string) => header.indexOf(name);
  const spdIdx = idx("spd_publ_id");
  const nameIdx = idx("ent_dis_nm");
  const typeIdx = idx("ent_ty_tx");
  const yearIdx = idx("rpt_yr");
  const tpIdx = idx("tp_id");
  const cityIdx = idx("city_nm");

  const latestBySpd = new Map<
    string,
    { year: number; row: TxSpecialDistrictRecord }
  >();

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const spdId = cols[spdIdx] ?? "";
    const name = String(cols[nameIdx] ?? "").trim();
    if (!spdId || !name) continue;

    const year = Number(cols[yearIdx] ?? 0);
    const record: TxSpecialDistrictRecord = {
      districtId: spdId,
      districtType: normalizeDistrictType(
        String(cols[typeIdx] ?? ""),
        name,
      ),
      name,
      county: cols[cityIdx] ? String(cols[cityIdx]) : null,
      taxUnitCode: cols[tpIdx] ? String(cols[tpIdx]) : null,
    };

    const prev = latestBySpd.get(spdId);
    if (!prev || year >= prev.year) {
      latestBySpd.set(spdId, { year, row: record });
    }
  }

  const districts = [...latestBySpd.values()].map((v) => v.row);
  const fetchedAt = new Date().toISOString();
  const payload = {
    source: TX_SPDPID_ENTITY_CSV_URL,
    fetchedAt,
    districts,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");

  return {
    outputPath,
    districtCount: districts.length,
    fetchedAt,
    sourceRows: lines.length - 1,
  };
}
