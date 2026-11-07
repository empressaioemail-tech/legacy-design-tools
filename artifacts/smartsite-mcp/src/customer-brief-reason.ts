/** P-458 — brief / MCP card reason lines shown to customers. */

export const PLANTED_VINTAGE_GAP_LAND_USE =
  "cad_property has 48453:280238 in another tax_year but not at declared taxYear=2026 (vintage-gap; no silent cross-vintage read)";

export function isMachineCustomerString(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (/taxYear=\d{4}/.test(s)) return true;
  if (/\bcad_property\b/.test(s) && /\d{5}:\d+/.test(s)) return true;
  if (/vintage-gap/i.test(s)) return true;
  if (/\bENVELOPE_ROUTER_[A-Z0-9_]+\b/.test(s)) return true;
  if (/\bSETBACK_ROUTER_[A-Z0-9_]+\b/.test(s)) return true;
  return false;
}

export function customerBriefReason(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (!isMachineCustomerString(trimmed)) return trimmed;
  if (/vintage-gap/i.test(trimmed)) {
    const declared = trimmed.match(/taxYear=(\d{4})/)?.[1];
    if (declared) {
      return `Not on the ${declared} roll yet (an earlier year on file)`;
    }
    return "Not on the declared appraisal roll yet (another year on file)";
  }
  return "Not on file for this parcel at the declared appraisal year.";
}
