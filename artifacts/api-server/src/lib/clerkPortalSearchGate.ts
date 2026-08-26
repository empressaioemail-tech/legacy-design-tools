import { eq } from "drizzle-orm";
import { db, clerkPortalTerms, type ClerkPortalAutomatedSearch } from "@workspace/db";

export type PortalSearchGateResult =
  | { ok: true; automatedSearch: Exclude<ClerkPortalAutomatedSearch, "unknown" | "prohibited"> }
  | {
      ok: false;
      code: "PORTAL_TERMS_UNKNOWN" | "PORTAL_AUTOMATED_SEARCH_PROHIBITED" | "PORTAL_TERMS_MISSING";
      portalId: string;
      message: string;
    };

/**
 * P-85 WDLL item 1 + item 5 — refuse automated index search when terms are
 * unknown or prohibited. Tolerated and permitted allow search.
 */
export async function assertPortalAllowsAutomatedSearch(
  portalId: string,
): Promise<PortalSearchGateResult> {
  const rows = await db
    .select()
    .from(clerkPortalTerms)
    .where(eq(clerkPortalTerms.portalId, portalId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      code: "PORTAL_TERMS_MISSING",
      portalId,
      message: `No clerk portal terms row for portal_id=${portalId}`,
    };
  }

  if (row.automatedSearch === "unknown") {
    return {
      ok: false,
      code: "PORTAL_TERMS_UNKNOWN",
      portalId,
      message: `Portal ${portalId} has automated_search=unknown; operator ruling required`,
    };
  }

  if (row.automatedSearch === "prohibited") {
    return {
      ok: false,
      code: "PORTAL_AUTOMATED_SEARCH_PROHIBITED",
      portalId,
      message: `Portal ${portalId} prohibits automated search per operator ruling`,
    };
  }

  return {
    ok: true,
    automatedSearch: row.automatedSearch as "permitted" | "tolerated",
  };
}

/** Map gate failure to easement research job needs-human reason. */
export function portalGateToNeedsHumanReason(
  gate: Extract<PortalSearchGateResult, { ok: false }>,
): string {
  return `${gate.code}: ${gate.message}`;
}
