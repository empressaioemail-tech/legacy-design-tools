/**
 * Municipality-agnostic setback source resolution (WDLL setback geometry unification).
 *
 * Every city uses the same shape: collect eligible candidates, rank by authority
 * tier then effective date, pick the winner. No Bastrop-only branches.
 *
 * Authority tiers (higher wins when dates are ambiguous):
 *   1. codified-ordinance — hash-locked JSON tables with ordinance citation
 *   2. gis-per-parcel — city GIS per-parcel setback record (layer / OnClick)
 *   3. atom-chain — persisted setback-rule atom without a fresher codified row
 */

import {
  getSetbackTableForZoning,
  type SetbackDistrict,
  type SetbackTable,
} from "@workspace/adapters";

import { mapDistrict, type DistrictMappingResult } from "./districtMapping";

export type SetbackScalars = {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
  side_corner_ft?: number;
};

export type SetbackSourceKind =
  | "codified-ordinance"
  | "gis-per-parcel"
  | "atom-chain";

export type AuthoritativeSetbackResolution = {
  scalars: SetbackScalars;
  districtCode: string;
  sourceKind: SetbackSourceKind;
  sourceLabel: string;
  effectiveDate: string;
  citationUrl: string | null;
  table: SetbackTable;
  district: DistrictMappingResult;
};

export type AtomChainSetbackWire = {
  front?: number;
  side?: number;
  rear?: number;
  side_corner?: number;
  sideCorner?: number;
  districtCode?: string | null;
  sourceAdapter?: string | null;
  sourceCitation?: string | null;
  extractedAt?: string | null;
  sourceVintage?: string | null;
};

const TIER_RANK: Record<SetbackSourceKind, number> = {
  "codified-ordinance": 3,
  "gis-per-parcel": 2,
  "atom-chain": 1,
};

type Candidate = {
  scalars: SetbackScalars;
  sourceKind: SetbackSourceKind;
  sourceLabel: string;
  effectiveDate: string;
  citationUrl: string | null;
  table: SetbackTable;
  district: DistrictMappingResult;
};

function parseIsoDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const d = t.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(t);
  return m ? m[1]! : null;
}

/** Table-level effective date when present; else accessed date from note. */
export function effectiveDateForTable(table: SetbackTable): string {
  const explicit = parseIsoDate(
    (table as { effectiveDate?: string }).effectiveDate,
  );
  if (explicit) return explicit;
  const note = table.note ?? "";
  const accessed = /accessed\s+(\d{4}-\d{2}-\d{2})/i.exec(note);
  if (accessed) return accessed[1]!;
  return "1970-01-01";
}

function scalarsFromDistrict(d: SetbackDistrict): SetbackScalars {
  return {
    front_ft: d.front_ft,
    side_ft: d.side_ft,
    rear_ft: d.rear_ft,
    ...(typeof d.side_corner_ft === "number"
      ? { side_corner_ft: d.side_corner_ft }
      : {}),
  };
}

function scalarsFromAtomRule(rule: AtomChainSetbackWire): SetbackScalars | null {
  if (
    typeof rule.front !== "number" ||
    typeof rule.side !== "number" ||
    typeof rule.rear !== "number"
  ) {
    return null;
  }
  const corner =
    typeof rule.side_corner === "number"
      ? rule.side_corner
      : typeof rule.sideCorner === "number"
        ? rule.sideCorner
        : undefined;
  return {
    front_ft: rule.front,
    side_ft: rule.side,
    rear_ft: rule.rear,
    ...(typeof corner === "number" ? { side_corner_ft: corner } : {}),
  };
}

function atomSourceKind(rule: AtomChainSetbackWire): SetbackSourceKind {
  const adapter = (rule.sourceAdapter ?? rule.sourceCitation ?? "").toLowerCase();
  if (
    adapter.includes("layer-23") ||
    adapter.includes("per-parcel") ||
    adapter.includes("onclick")
  ) {
    return "gis-per-parcel";
  }
  return "atom-chain";
}

function atomEffectiveDate(rule: AtomChainSetbackWire): string {
  return (
    parseIsoDate(rule.extractedAt) ??
    parseIsoDate(rule.sourceVintage) ??
    "1970-01-01"
  );
}

function pickWinner(candidates: Candidate[]): Candidate | null {
  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => {
    const tierDiff = TIER_RANK[cur.sourceKind] - TIER_RANK[best.sourceKind];
    if (tierDiff > 0) return cur;
    if (tierDiff < 0) return best;
    return cur.effectiveDate >= best.effectiveDate ? cur : best;
  });
}

/**
 * Resolve setbacks for derive: codified table vs atom-chain/GIS, same rules
 * for every municipality.
 */
export function resolveAuthoritativeSetbacks(args: {
  jurisdictionKey: string | null;
  districtCode: string;
  atomRule: AtomChainSetbackWire | null;
}): AuthoritativeSetbackResolution | null {
  const districtCode = args.districtCode.trim();
  if (!districtCode) return null;
  const jurisdictionKey = args.jurisdictionKey?.trim() || null;
  if (!jurisdictionKey) return null;

  const table = getSetbackTableForZoning(jurisdictionKey, districtCode);
  if (!table?.districts.length) return null;

  const mapped = mapDistrict(table, districtCode);
  if (!mapped || mapped.kind === "fallback-conservative") return null;

  const candidates: Candidate[] = [];
  const tableDate = effectiveDateForTable(table);
  const ordinanceScalars = scalarsFromDistrict(mapped.district);

  candidates.push({
    scalars: ordinanceScalars,
    sourceKind: "codified-ordinance",
    sourceLabel: table.jurisdictionDisplayName,
    effectiveDate: tableDate,
    citationUrl: mapped.district.citation_url ?? null,
    table,
    district: mapped,
  });

  const atomScalars = args.atomRule
    ? scalarsFromAtomRule(args.atomRule)
    : null;
  if (atomScalars && args.atomRule) {
    const kind = atomSourceKind(args.atomRule);
    candidates.push({
      scalars: atomScalars,
      sourceKind: kind,
      sourceLabel:
        args.atomRule.sourceCitation ??
        args.atomRule.sourceAdapter ??
        "property atom-chain setback-rule",
      effectiveDate: atomEffectiveDate(args.atomRule),
      citationUrl: null,
      table,
      district: {
        ...mapped,
        district: {
          ...mapped.district,
          front_ft: atomScalars.front_ft,
          side_ft: atomScalars.side_ft,
          rear_ft: atomScalars.rear_ft,
          side_corner_ft:
            atomScalars.side_corner_ft ?? mapped.district.side_corner_ft,
        },
      },
    });
  }

  const winner = pickWinner(candidates);
  if (!winner) return null;

  const districtWithScalars: DistrictMappingResult = {
    ...winner.district,
    district: {
      ...winner.district.district,
      front_ft: winner.scalars.front_ft,
      side_ft: winner.scalars.side_ft,
      rear_ft: winner.scalars.rear_ft,
      side_corner_ft:
        winner.scalars.side_corner_ft ?? winner.district.district.side_corner_ft,
    },
  };

  return {
    scalars: winner.scalars,
    districtCode,
    sourceKind: winner.sourceKind,
    sourceLabel: winner.sourceLabel,
    effectiveDate: winner.effectiveDate,
    citationUrl: winner.citationUrl,
    table: winner.table,
    district: districtWithScalars,
  };
}
