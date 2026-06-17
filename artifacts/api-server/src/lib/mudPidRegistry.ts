/**
 * TX Comptroller special-district registry ingest (61a horizontal).
 *
 * Resolves MUD/PID/PUD exposure by district name or tax unit code when
 * Cotality per-parcel tax payloads lack explicit flags.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolveTxSpecialDistrictsDataPath } from "./brokerageFederalDataPaths";

export interface TxSpecialDistrictRecord {
  districtId: string;
  districtType: "MUD" | "PID" | "PUD" | "OTHER";
  name: string;
  county: string | null;
  taxUnitCode: string | null;
}

let cachedRegistry: TxSpecialDistrictRecord[] | null = null;

function registryPath(): string | null {
  const path = resolveTxSpecialDistrictsDataPath();
  return existsSync(path) ? path : null;
}

export function loadTxSpecialDistrictRegistry(): TxSpecialDistrictRecord[] {
  if (cachedRegistry) return cachedRegistry;
  const path = registryPath();
  if (!path) {
    cachedRegistry = [];
    return cachedRegistry;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as
    | { districts?: TxSpecialDistrictRecord[] }
    | TxSpecialDistrictRecord[];
  cachedRegistry = Array.isArray(raw) ? raw : (raw.districts ?? []);
  return cachedRegistry;
}

function normalizeType(raw: string): TxSpecialDistrictRecord["districtType"] {
  const u = raw.toUpperCase();
  if (u.includes("MUD")) return "MUD";
  if (u.includes("PID")) return "PID";
  if (u.includes("PUD")) return "PUD";
  return "OTHER";
}

/** Scan free text (tax bill lines, legal desc) against the Comptroller registry. */
export function matchTxSpecialDistricts(text: string): TxSpecialDistrictRecord[] {
  const registry = loadTxSpecialDistrictRegistry();
  if (!text.trim() || registry.length === 0) return [];
  const hay = text.toLowerCase();
  const hits: TxSpecialDistrictRecord[] = [];
  for (const row of registry) {
    if (row.name && hay.includes(row.name.toLowerCase())) hits.push(row);
    else if (row.taxUnitCode && hay.includes(row.taxUnitCode.toLowerCase())) {
      hits.push(row);
    }
  }
  return hits;
}

export function summarizeMudPidExposure(input: {
  cotalityFlags?: {
    mudPidDetected: boolean;
    specialDistrictLabels: string[];
  };
  taxText?: string | null;
}): {
  exposure: "confirmed" | "possible" | "none";
  districts: TxSpecialDistrictRecord[];
  sources: string[];
} {
  const sources: string[] = [];
  const districts: TxSpecialDistrictRecord[] = [];

  if (input.cotalityFlags?.mudPidDetected) {
    sources.push("cotality-tax-payload");
  }

  if (input.taxText) {
    const registryHits = matchTxSpecialDistricts(input.taxText);
    if (registryHits.length) sources.push("tx-comptroller-registry");
    districts.push(...registryHits);
  }

  if (districts.length > 0 || input.cotalityFlags?.mudPidDetected) {
    return {
      exposure: districts.length > 0 ? "confirmed" : "possible",
      districts,
      sources,
    };
  }
  return { exposure: "none", districts: [], sources };
}

/** TEST-ONLY */
export function __resetTxSpecialDistrictCacheForTests(): void {
  cachedRegistry = null;
}
