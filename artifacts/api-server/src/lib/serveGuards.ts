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

/** F-06 conformant writer pairs (public/anonymous) for tier bake; not atom-contract enum validation. */
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
  if (p.access) assertAccessPair(p.access);
  const facets = p.facets as Record<string, unknown> | undefined;
  const base = facets?.base as Record<string, unknown> | undefined;
  if (base?.situsAddress != null) assertSitusNotPunctuationOnly(base.situsAddress);
}
