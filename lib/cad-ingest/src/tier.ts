/**
 * Source-tier recording for CAD ingest rows.
 *
 * Tier is stamped into `source_vintage` (no schema migration) so SQL
 * can grade loads via `source_vintage LIKE 'tier:cad-export;%'`.
 */

export type CadSourceTier = "cad-export" | "stratmap-roll";

export interface SourceVintageParts {
  tier: CadSourceTier;
  adapter: string;
  drop: string;
}

/** Build the structured source_vintage prefix. */
export function formatSourceVintage(parts: SourceVintageParts): string {
  const { tier, adapter, drop } = parts;
  return `tier:${tier};adapter:${adapter};drop:${drop}`;
}

/**
 * Parse a structured source_vintage string. Returns partial parts when
 * the label is legacy/unstructured.
 */
export function parseSourceVintage(vintage: string): Partial<SourceVintageParts> {
  const out: Partial<SourceVintageParts> = {};
  for (const segment of vintage.split(";")) {
    const eq = segment.indexOf(":");
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (key === "tier" && (val === "cad-export" || val === "stratmap-roll")) {
      out.tier = val;
    } else if (key === "adapter") {
      out.adapter = val;
    } else if (key === "drop") {
      out.drop = val;
    }
  }
  return out;
}
