/**
 * Small normalization helpers shared by the PACS and Orion parsers.
 * All of them treat blank / zero-padded-blank input as null rather
 * than guessing.
 */

/** Trim; empty string becomes null. */
export function textOrNull(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
}

/**
 * Parse a CAD numeric field into a whole number (dollars, years, sqft).
 * Accepts zero-padded integers ("000000000145090") and explicit
 * decimals ("17140.000000"). Blank returns null; unparsable returns
 * null rather than NaN.
 */
export function wholeNumberOrNull(s: string | undefined): number | null {
  const t = (s ?? "").trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Like {@link wholeNumberOrNull} but zero also becomes null — for
 * fields where 0 means "not applicable" (living area, year built).
 */
export function positiveWholeOrNull(s: string | undefined): number | null {
  const n = wholeNumberOrNull(s);
  return n !== null && n > 0 ? n : null;
}

/**
 * Strip leading zeros from a CAD id ("000000010001" -> "10001").
 * All-zero input normalizes to "0"; non-numeric ids pass through
 * trimmed so alphanumeric quick-ref ids survive.
 */
export function stripLeadingZeros(s: string): string {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, "");
}

/**
 * PACS acreage fields carry 4 implied decimals when they have no
 * explicit decimal point ("00000000000000017716" -> "1.7716").
 * Values with an explicit point parse as-is. Returns a decimal
 * string suitable for a numeric(14,4) column, or null.
 */
export function impliedAcresOrNull(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  if (t.length === 0) return null;
  if (!/^[0-9.]+$/.test(t)) return null;
  const n = t.includes(".") ? Number(t) : Number(t) / 10_000;
  if (!Number.isFinite(n)) return null;
  if (n === 0) return null;
  return n.toFixed(4);
}

/** Explicit-decimal acres ("1.7716", "17140.000000") to numeric(14,4) string. */
export function explicitAcresOrNull(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n === 0) return null;
  return n.toFixed(4);
}

/** Join non-empty parts with a single space. */
export function joinParts(...parts: Array<string | null | undefined>): string | null {
  const joined = parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Build a single mailing-address line out of street lines + city,
 * state, zip. "15 SUNRISE ST, DALE, TX 78616".
 */
export function mailingLine(opts: {
  lines: Array<string | null | undefined>;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  zip4?: string | null;
}): string | null {
  const street = opts.lines
    .map((l) => (l ?? "").trim())
    .filter((l) => l.length > 0);
  const zip = [opts.zip, opts.zip4]
    .map((z) => (z ?? "").trim())
    .filter((z) => z.length > 0)
    .join("-");
  const stateZip = joinParts(opts.state ?? null, zip.length > 0 ? zip : null);
  const segments = [...street, (opts.city ?? "").trim(), stateZip ?? ""]
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments.join(", ") : null;
}
