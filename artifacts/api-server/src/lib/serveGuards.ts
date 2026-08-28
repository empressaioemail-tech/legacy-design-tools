/**
 * F-06 serve guards (BP-ACCESS-01, BP-ADDRESS-01).
 */
import {
  parseAccessPair,
  AccessParseError,
  type AccessPair,
} from "@empressaio/atom-contract/access";

const PUNCTUATION_ONLY_RE = /^[\s,.\-;:'"`]+$/;

export function assertAccessPair(input: unknown): AccessPair {
  try {
    return parseAccessPair(input);
  } catch (err) {
    if (err instanceof AccessParseError) {
      throw Object.assign(new Error(err.message), { code: "ACCESS_NOT_DEFAULTED" });
    }
    throw err;
  }
}

/**
 * Legacy F-06 writer pairs and their canonical (19_the_instrument_contract, contract 1.30.0) value.
 * The conformant writer stamped every atom `public / anonymous` before 2026-08-28; the bake copied it
 * and the serve guard refused it (ACCESS_NOT_DEFAULTED "unknown discoverability" on every Bastrop
 * facet in production). The translation is declared in the served and baked payload as
 * `accessNormalizedFrom`; anything not in this table and not a canonical pair still refuses.
 */
export const LEGACY_ACCESS_PAIRS: Readonly<Record<string, AccessPair>> = Object.freeze({
  // Retired 2026-08-28 (OPS-19 A-023 item 4): every conformant atom in the eight written counties
  // was re-stamped to the canonical pair by factory-restamp-access with counts read back to zero,
  // and the Bastrop production snapshots were re-baked. A legacy pair reaching serve refuses again.
});

export function normalizeAccessPair(input: unknown): { access: AccessPair; normalizedFrom: string | null } {
  if (input && typeof input === "object") {
    const { discoverability, entitlement } = input as Record<string, unknown>;
    if (typeof discoverability === "string" && typeof entitlement === "string") {
      const key = `${discoverability}/${entitlement}`;
      const legacy = LEGACY_ACCESS_PAIRS[key];
      if (legacy) return { access: { ...legacy }, normalizedFrom: key };
    }
  }
  return { access: assertAccessPair(input), normalizedFrom: null };
}

/** @deprecated use normalizeAccessPair; kept for the F-06 bake tests until they move. */
export function assertF06BakeAccessPair(input: unknown): { discoverability: string; entitlement: string } {
  if (!input || typeof input !== "object") {
    throw Object.assign(new Error("access pair missing"), { code: "ACCESS_NOT_DEFAULTED" });
  }
  const { discoverability, entitlement } = input as Record<string, unknown>;
  if (
    typeof discoverability !== "string" ||
    discoverability.trim() === "" ||
    typeof entitlement !== "string" ||
    entitlement.trim() === ""
  ) {
    throw Object.assign(new Error("access field defaulted or empty"), { code: "ACCESS_NOT_DEFAULTED" });
  }
  return { discoverability, entitlement };
}

export function assertSitusNotPunctuationOnly(situs: unknown): string | null {
  if (situs == null || situs === "") return null;
  const s = String(situs).trim();
  if (s === "" || PUNCTUATION_ONLY_RE.test(s)) {
    throw Object.assign(new Error("situs is punctuation only"), { code: "SITUS_PUNCTUATION_ONLY" });
  }
  return s;
}

export function refusePayloadAtServe(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as Record<string, unknown>;
  if (p.access) {
    const { access, normalizedFrom } = normalizeAccessPair(p.access);
    if (normalizedFrom) {
      p.access = access;
      p.accessNormalizedFrom = normalizedFrom;
    }
  }
  const facets = p.facets as Record<string, unknown> | undefined;
  const base = facets?.base as Record<string, unknown> | undefined;
  if (base?.situsAddress != null) assertSitusNotPunctuationOnly(base.situsAddress);
}
