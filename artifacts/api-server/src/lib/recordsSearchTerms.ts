/**
 * P-85 item 5 — resolve clerk index search terms from TxGIO + CAD at enqueue time.
 */

import { queryTxgioParcelByPropId } from "./txgioParcelStore";
import { makeCadPropertyLookup } from "./cadPropertyLookup";
import { P85_CLERK_PORTALS } from "./p85ClerkPortalRegistry";
import { parseSubdivisionLotBlockFromLegal } from "./recordsSearchQueryPlan";

function countyNameForFips(countyFips: string): string {
  const hit = P85_CLERK_PORTALS.find((p) => p.countyFips === countyFips);
  return hit?.countyName ?? `County ${countyFips}`;
}

function parseParcelKeyParts(
  parcelKey: string,
): { countyFips: string; propId: string } | null {
  if (!parcelKey.startsWith("apn:")) return null;
  const rest = parcelKey.slice(4);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const countyFips = rest.slice(0, idx).trim();
  const propId = rest.slice(idx + 1).trim();
  if (!/^\d{5}$/.test(countyFips) || !propId) return null;
  return { countyFips, propId };
}

export type RecordsSearchTermsPayload = {
  propId: string;
  ownerName: string | null;
  situsAddress: string | null;
  legalDescription: string | null;
  subdivision: string | null;
  block: string | null;
  lot: string | null;
};

export async function resolveRecordsSearchTerms(input: {
  parcelKey: string;
  countyFips: string;
}): Promise<RecordsSearchTermsPayload | null> {
  const parsed = parseParcelKeyParts(input.parcelKey);
  if (!parsed || parsed.countyFips !== input.countyFips.trim()) {
    return null;
  }

  const cadLookup = makeCadPropertyLookup();
  const cad = await cadLookup(parsed.countyFips, parsed.propId);

  const txgio = await queryTxgioParcelByPropId({
    countyFips: parsed.countyFips,
    countyName: countyNameForFips(parsed.countyFips),
    propId: parsed.propId,
  });

  const feature = txgio?.geojson.features[0];
  const props =
    feature && typeof feature === "object"
      ? ((feature as { properties?: Record<string, unknown> }).properties ?? {})
      : {};

  const ownerName =
    cad?.ownerName?.trim() ||
    (typeof props.owner === "string" && props.owner.trim()) ||
    (typeof props.ownerName === "string" && props.ownerName.trim()) ||
    null;
  const situsAddress =
    cad?.situsAddress?.trim() ||
    (typeof props.situsAddress === "string" && props.situsAddress.trim()) ||
    null;
  const legalDescription = cad?.legalDescription?.trim() ?? null;
  const parsedLegal = parseSubdivisionLotBlockFromLegal(legalDescription);

  return {
    propId: parsed.propId,
    ownerName,
    situsAddress,
    legalDescription,
    subdivision: parsedLegal.subdivision,
    block: parsedLegal.block,
    lot: parsedLegal.lot,
  };
}
