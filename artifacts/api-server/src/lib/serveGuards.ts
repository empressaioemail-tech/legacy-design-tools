/**
 * F-06 serve guards (BP-ACCESS-01, BP-ADDRESS-01).
 */
const PUNCTUATION_ONLY_RE = /^[\s,.\-;:'"`]+$/;

export function assertAccessPair(access: unknown): { discoverability: string; entitlement: string } {
  if (!access || typeof access !== "object") {
    throw Object.assign(new Error("access pair missing"), { code: "ACCESS_NOT_DEFAULTED" });
  }
  const a = access as Record<string, unknown>;
  const discoverability = a.discoverability;
  const entitlement = a.entitlement;
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
