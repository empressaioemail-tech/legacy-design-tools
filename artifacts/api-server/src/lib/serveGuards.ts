/**
 * F-06 serve guards (BP-ACCESS-01, BP-ADDRESS-01).
 */
import {
  parseAccessPair,
  AccessParseError,
  type AccessPair,
} from "@empressaio/atom-contract/access";
import { isEarnedRecordRetirement } from "./recordRetirement";

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

// ---------------------------------------------------------------------------
// SITUS ADDRESS QUALITY (P-124 CTX-B6, 2026-09-10).
//
// `PUNCTUATION_ONLY_RE` above answers ONE question -- is every character in
// this string punctuation -- and CTX-SENTINEL already recorded that the real
// world carries a THIRD and now a FOURTH shape poorer than the two the
// 2026-09-03 refusal-contract split named. `", TX 78756"` contains
// alphanumerics, passes that regex, and is served to a paying customer as
// their address. Measured on staging 2026-09-10: 147,199 stored tier-1 rows
// across the six CTX counties carry a street-less situs STRING -- 146,494 in
// Travis alone, of which 123,120 are the `", TX <zip>"` shape and 16,010 are
// the bare `", TX"` -- plus 696 in McLennan such as `", WACO, TX 76705"`.
// Every one of them carries a real locality or ZIP and no street whatsoever.
//
// THE RULE, and it is the only one this file owns: an address string carries
// a STREET COMPONENT when the segment before its first comma holds at least
// one alphanumeric character. `"4709 SHOALWOOD AVE"` does. `"908 PINE ,
// BASTROP, TX 78602"` (the live Bastrop roll form) does. `", TX 78756"`,
// `", ,"` and `",,AUSTIN, TX 78756"` do not.
//
// WHY HERE. The bake, the bake CLI and this serve guard were three places
// that each decided independently what an unusable situs is, and they
// disagreed -- which is how a shape the Factory's own S1 grade
// (`hauska-factory src/stages/grade/s-rules.mjs` `isSentinelSitus`,
// `/^,\s*,/` and `/^,\s*TX\s+\d{5}/i`) has detected all along still reached
// the store on six figures of rows. One predicate, one module, imported by
// every producer. `classifyRawSitusAddress` is a SUPERSET of both factory
// sentinel regexes by construction and
// `__tests__/serveGuardsSitusAddress.test.ts` proves the containment against
// those two regexes carried as fixtures; the cross-repo single source is a
// leave-behind item, because this repo cannot edit hauska-factory.
//
// NOT ARMED AT SERVE, DELIBERATELY. `refusePayloadAtServe` below still
// refuses only the punctuation-only shape. Arming the street rule there in
// the same change would 422 the 147,199 rows already baked on the old rule
// the instant it deployed, before the re-bake the integration seat owns --
// turning an invisible defect into a visible outage, which is the ordering
// ENFORCEMENT.md's retirement rule exists to prevent. The WRITE is the
// control that lands here (`assertRequiredLeafStatesEarned` in
// `nodeFacetBakeTier1Conformant.ts`); the serve backstop is a named
// leave-behind, not a claim of coverage.
// ---------------------------------------------------------------------------

/** Why a raw claim situs address cannot be presented as the value of the leaf. */
export type SitusAddressUnusableReason = "punctuation-only" | "no-street-component";

export type RawSitusAddressClass =
  /** The claim carries no situsAddress at all (null, empty, or whitespace). */
  | { kind: "blank" }
  /** The claim carries an address with a street component; `value` is trimmed. */
  | { kind: "usable"; value: string }
  /** The claim carries SOMETHING, and it is not presentable. `raw` is verbatim. */
  | { kind: "unusable"; reason: SitusAddressUnusableReason; raw: string };

/**
 * The segment of an address before its first comma, trimmed. Exported so a
 * test can show the predicate reading what it claims to read rather than a
 * whole-string regex that happens to correlate.
 */
export function situsStreetSegment(address: string): string {
  const [first = ""] = String(address).split(",");
  return first.trim();
}

/** True when the pre-comma segment holds at least one alphanumeric character. */
export function situsCarriesStreetComponent(address: string): boolean {
  return /[A-Za-z0-9]/.test(situsStreetSegment(address));
}

/**
 * The ONE classification every producer of `baseFacts.situsAddress` runs.
 *
 * `blank` and `unusable` are deliberately different kinds rather than one
 * "bad" bucket: the first is a claim that was read and carries nothing, the
 * second is a claim that carries something that must not be shown. They earn
 * different absences with different bases, and collapsing them would make the
 * served answer unable to say which happened.
 *
 * The punctuation-only branch delegates to `assertSitusNotPunctuationOnly`
 * rather than re-testing `PUNCTUATION_ONLY_RE`, so that rule keeps exactly
 * one implementation.
 */
export function classifyRawSitusAddress(
  raw: string | null | undefined,
): RawSitusAddressClass {
  if (raw == null) return { kind: "blank" };
  const s = String(raw).trim();
  if (s === "") return { kind: "blank" };
  try {
    assertSitusNotPunctuationOnly(s);
  } catch {
    return { kind: "unusable", reason: "punctuation-only", raw: String(raw) };
  }
  if (!situsCarriesStreetComponent(s)) {
    return { kind: "unusable", reason: "no-street-component", raw: String(raw) };
  }
  return { kind: "usable", value: s };
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
  // CTX-B1 (operator ruling A3, 2026-09-10): an earned record retirement's
  // situs is the account's LAST-KNOWN claim, deliberately written ungated
  // by `situsForRetiredBake` (nodeFacetBakeTier1ConformantCli.ts) so an
  // honest retirement declaration never depends on whether the stale claim
  // happens to carry a well-formed address. Gating it here again -- the
  // same punctuation-only check CTX-SITUS-SKIP applies to ON-roll claims --
  // reintroduced the exact defect CTX-RETIRE fixed: Caldwell 48055:1's
  // last-known ", ," situs 422ing at serve even though the bake wrote it by
  // design. The retirement declaration itself is already gated well-formed
  // by `isEarnedRecordRetirement`, so this is not a blanket exemption.
  if (isEarnedRecordRetirement(p.recordRetirement)) return;
  const facets = p.facets as Record<string, unknown> | undefined;
  const base = facets?.base as Record<string, unknown> | undefined;
  if (base?.situsAddress != null) assertSitusNotPunctuationOnly(base.situsAddress);
}
