/**
 * Rail-score PROVENANCE — the denominator travels with the number.
 *
 * DEV_PROCESS 1.1/1.2: a coverage figure travels with its denominator or it
 * does not ship, and the counting rule rides next to the number rather than in
 * an appendix. `county_facet_coverage` stores a percentage; a percentage with
 * no denominator is exactly the shape that rule exists to stop.
 *
 * The live ledger already reaches for this and does it ad hoc. Verified
 * 2026-08-19 against the deployment store, the geometry rows carry:
 *
 *   atoms:entity_type=parcel-node,countyFips=48001;denom=accounted;
 *   rawFeatures=43894;accountedFeatures=31676;foldedExtraFeatures=12218
 *
 * while every other rail carries the bare `atoms:entity_type=X,countyFips=Y`
 * with no denominator at all. One ledger, two formats, one of them lossy, and
 * the only consumer is a regex in a throwaway verify script
 * (`_P1-2_cp2_verify.mjs`). This module makes that a CONTRACT instead of a
 * convention: one canonical string, one formatter, one parser, and a
 * round-trip test, so a reader can always recover what a number was measured
 * over.
 *
 * NO SCHEMA CHANGE. The string lands in the existing `artifact_path` column.
 * A dedicated column would be cleaner and is deliberately not taken here: two
 * sibling lanes have open PRs against this repo, drizzle migrations are
 * sequentially numbered, and a third concurrent migration is a merge-order
 * hazard that buys nothing this format does not already deliver.
 *
 * Format (order is fixed so the string is stable and diffable):
 *
 *   scorer=1;rail=<railKey>;kind=<measurementKind>;num=<n|na>;den=<n|na>;
 *   denKind=<denominatorKind>[;detail=<free text without a semicolon>]
 */

/** Bumped only on a breaking change to the field set or their meanings. */
export const RAIL_SCORE_PROVENANCE_VERSION = "1";

export interface RailScoreProvenance {
  /** The rail key, which is also the `facet` value of the row this describes. */
  rail: string;
  /** The measurement kind that produced the numbers (registry `kind`). */
  kind: string;
  /** Measured numerator, or null when the rail could not be measured. */
  numerator: number | null;
  /** Measured denominator, or null when there was no denominator to measure against. */
  denominator: number | null;
  /** Machine name of the denominator, e.g. `txgio-parcel-distinct-feature-index`. */
  denominatorKind: string;
  /** Optional free text (source pointer, absence evidence path). MUST NOT contain `;`. */
  detail?: string | null;
}

const FIELD_SEPARATOR = ";";
const NOT_APPLICABLE = "na";

function encodeCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_APPLICABLE;
  return String(Math.trunc(value));
}

function decodeCount(raw: string | undefined): number | null {
  if (raw === undefined || raw === NOT_APPLICABLE || raw === "") return null;
  if (!/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Values may not contain the field separator. This throws rather than
 * silently escaping, because a value that needs escaping is a signal that
 * something structured is being smuggled through a free-text field — the
 * habit this module exists to end.
 */
function assertNoSeparator(field: string, value: string): void {
  if (value.includes(FIELD_SEPARATOR)) {
    throw new Error(
      `rail-score provenance field '${field}' may not contain '${FIELD_SEPARATOR}': ${value}`,
    );
  }
}

/** Render the canonical provenance string for one scored cell. */
export function formatRailScoreProvenance(p: RailScoreProvenance): string {
  assertNoSeparator("rail", p.rail);
  assertNoSeparator("kind", p.kind);
  assertNoSeparator("denKind", p.denominatorKind);
  const parts = [
    `scorer=${RAIL_SCORE_PROVENANCE_VERSION}`,
    `rail=${p.rail}`,
    `kind=${p.kind}`,
    `num=${encodeCount(p.numerator)}`,
    `den=${encodeCount(p.denominator)}`,
    `denKind=${p.denominatorKind}`,
  ];
  if (p.detail != null && p.detail !== "") {
    assertNoSeparator("detail", p.detail);
    parts.push(`detail=${p.detail}`);
  }
  return parts.join(FIELD_SEPARATOR);
}

/**
 * Parse a canonical provenance string.
 *
 * Returns null for anything this module did not write — a legacy
 * `atoms:entity_type=...` artifact_path, an empty string, a future version.
 * An unparseable value is reported as unparseable; it is never coerced into a
 * partially-populated object that would read like a measurement.
 */
export function parseRailScoreProvenance(
  raw: string | null | undefined,
): RailScoreProvenance | null {
  if (!raw) return null;
  const fields = new Map<string, string>();
  for (const part of raw.split(FIELD_SEPARATOR)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (fields.get("scorer") !== RAIL_SCORE_PROVENANCE_VERSION) return null;
  const rail = fields.get("rail");
  const kind = fields.get("kind");
  const denominatorKind = fields.get("denKind");
  if (!rail || !kind || !denominatorKind) return null;
  const detail = fields.get("detail");
  return {
    rail,
    kind,
    numerator: decodeCount(fields.get("num")),
    denominator: decodeCount(fields.get("den")),
    denominatorKind,
    detail: detail === undefined ? null : detail,
  };
}
