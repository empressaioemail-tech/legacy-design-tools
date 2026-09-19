/**
 * P-91 stub depth for get_smart_site: label, node id, canonical url,
 * five-state value per rail. Drainage is unread when never fetched.
 * atom-miss maps to unknown. absent-verified only from pipeline
 * present-outside or a :sd:outside bind.
 *
 * The stub is a projection of the node (P-91 v2, triage D2): every rail
 * that has a brief section is that section's disposition mapped through
 * `railStateFromSectionDisposition`, and the disposition predicates live in
 * `r1BriefCompose`. There is one derivation, read at two depths.
 */

import { SMARTSITE_PARCEL_URL_PREFIX } from "./parcelDrawStub";
import {
  drainageDisposition,
  envelopeDisposition,
  factReadDisposition,
  landUseDisposition,
  zoningDisposition,
  type R1BriefSectionDisposition,
} from "./r1BriefCompose";
import { composeSitusLabel, resolveSitusCity } from "./situsCompose";
import type { CityLimitsFactServed } from "./cityLimitsFactServeCutover";
import type { ZoningFactRead } from "./zoningFactFromParcelRecord";
import type { SetbacksFactRead } from "./setbacksFactFromParcelRecord";

export const SMART_SITE_RAIL_STATES = [
  "present",
  "absent-verified",
  "unknown",
  "refused",
  "unread",
] as const;

export type SmartSiteRailState = (typeof SMART_SITE_RAIL_STATES)[number];

export const SMART_SITE_STUB_RAILS = [
  "situs",
  "zoning",
  "landUse",
  "flood",
  "drainage",
  "envelope",
] as const;

export type SmartSiteStubRail = (typeof SMART_SITE_STUB_RAILS)[number];

export type SmartSiteStub = {
  parcelNodeId: string;
  label: string;
  url: string;
  situs: SmartSiteRailState;
  zoning: SmartSiteRailState;
  landUse: SmartSiteRailState;
  flood: SmartSiteRailState;
  drainage: SmartSiteRailState;
  envelope: SmartSiteRailState;
};

export type RailReadKind = "pipeline" | "sd" | "flood" | "other";

export type RailReadInput = {
  attempted: boolean;
  state?: "present" | "absent" | "refused";
  code?: string;
  kind?: RailReadKind;
  /** Pipeline present-outside: nearPipeline === false. */
  presentOutside?: boolean;
  entityId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSdOutsideEntityId(entityId: string | undefined): boolean {
  if (!entityId) return false;
  return /:sd:outside$/i.test(entityId);
}

/**
 * Node section disposition into the rail vocabulary. `absent` (no
 * determination, no refusal) is `unknown` on the rail: `absent-verified`
 * needs a positive typed result (WDLL item 5) that no section carries.
 */
export function railStateFromSectionDisposition(
  disposition: R1BriefSectionDisposition,
): SmartSiteRailState {
  switch (disposition) {
    case "present":
      return "present";
    case "refused":
      return "refused";
    case "unread":
      return "unread";
    case "absent":
      return "unknown";
  }
}

/**
 * Fifth-state mapper. unread is only legal when the read was not attempted.
 * atom-miss is unknown, never absent-verified. Outside the two positive
 * typed results, a read projects exactly as its section would.
 */
export function railStateFromRead(read: RailReadInput): SmartSiteRailState {
  if (!read.attempted) return "unread";
  if (read.state == null) return "unknown";
  if (read.kind === "pipeline" && read.state === "present" && read.presentOutside) {
    return "absent-verified";
  }
  if (read.kind === "sd" && (read.state === "absent" || isSdOutsideEntityId(read.entityId))) {
    return "absent-verified";
  }
  return railStateFromSectionDisposition(
    factReadDisposition({ state: read.state, code: read.code }),
  );
}

/**
 * OPS-16 A-096/A-097/A-098: parcel_record's own zoning determination, when
 * the rail reaches the parcel_record path (P-297 / A-193: the SLATE decides
 * that, and it is (county, zoningDistrict) on the slate), takes priority over
 * the bake-derived zoningDisposition -- present maps to "present",
 * absent-verified/not-applicable (the only two absence kinds
 * ParcelRecordCellAbsent carries) both map to "absent-verified" (this app's
 * one vocabulary token for a verified/positive absence).
 *
 * P-297 / A-193 REVERSES THE REFUSAL BRANCH HERE. Until this card, a
 * `refused` record fact fell through to the legacy bake-derived computation
 * ("never regress a parcel with a real answer"). On a slated rail that
 * fall-through IS the defect the ruling names: a refused or unaccounted cell
 * is a declared refusal with the cell's reason, and the legacy or baked value
 * is never the answer. The bake-derived computation now serves only the case
 * this function is not called for at all (no record fact), and the caller
 * keeps that branch. r1BriefCompose.ts's own zoning section is flipped to
 * match, so the two depths cannot disagree (D2/D3: the stub is a projection
 * of the node).
 */
function railStateFromZoningFact(fact: ZoningFactRead): SmartSiteRailState {
  if (fact.state === "present") return "present";
  if (fact.state === "absent") return "absent-verified";
  return "refused";
}

/**
 * Setbacks' own mirror of railStateFromZoningFact -- see that function's doc
 * for the shared reasoning, including the P-297/A-193 reversal of the refusal
 * branch.
 */
function railStateFromSetbacksFact(fact: SetbacksFactRead): SmartSiteRailState {
  if (fact.state === "present") return "present";
  if (fact.state === "absent") return "absent-verified";
  return "refused";
}

export function composeSmartSiteStub(input: {
  parcelNodeId: string;
  facets: unknown;
  flood?: RailReadInput;
  drainage?: RailReadInput;
  envelopeBriefRefusal?: { state?: string } | null;
  /** OPS-16 A-096/A-097/A-098. Non-null only when (county, zoningDistrict) is slated and gate-passing. */
  parcelRecordZoningFact?: ZoningFactRead | null;
  /** OPS-16 A-096/A-097/A-098. Non-null only when (county, setbackFrontFt) is slated and gate-passing. */
  parcelRecordSetbacksFact?: SetbacksFactRead | null;
  /**
   * P-270 CITY HALF (2026-09-19). The served city-limits determination, when the
   * caller made one. It exists here for ONE reason: the licence in
   * `situsCompose.resolveSitusCity` may name the city whose limits contain this
   * parcel where the payload's own roll city is a DECLARED `absent-verified`
   * absence. Omitted/null means no determination was in hand, and then the label
   * names no city — never a guess.
   *
   * A caller pays for this read only when the payload's roll city is that
   * declared absence (`rollSitusCityIsDeclaredAbsent`), so the ordinary label
   * path is unchanged.
   */
  cityLimitsFact?: CityLimitsFactServed | null;
}): SmartSiteStub {
  const root = asRecord(input.facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  const situsAddress =
    (typeof root.situsAddress === "string" ? root.situsAddress : null) ??
    (typeof baseFacts.situsAddress === "string" ? baseFacts.situsAddress : null);
  /**
   * P-270 CITY HALF: the city is decided by the licence, not by a `typeof`
   * test. `baseFacts.situsCity` is a DECLARED-absence object on a roll whose CAD
   * roll states no city (the live `48453:445501` shape), and reading only
   * strings silently dropped it — leaving the MCP label naming no city while the
   * ledger held one. Only `resolveSitusCity` decides; this line does not.
   */
  const situsCity = resolveSitusCity({
    rollSitusCity: baseFacts.situsCity,
    cityLimits: input.cityLimitsFact,
  }).city;
  const situsState = typeof baseFacts.situsState === "string" ? baseFacts.situsState : null;
  const situsZip = typeof baseFacts.situsZip === "string" ? baseFacts.situsZip : null;
  const situs = composeSitusLabel({
    parcelNodeId: input.parcelNodeId,
    composed: situsAddress,
    parts: [situsAddress, situsCity, situsState, situsZip],
    // P-270 ADDRESS HALF: the label must CARRY the city/state/ZIP the payload
    // holds rather than returning the bare street line. `composed` used to
    // short-circuit before `parts` were consulted, so a payload whose situsAddress
    // is a bare street got the bare street back on every parcel — the same shape
    // the map's live payload shows for 48453:445501 (read 2026-09-18: the payload
    // names Pflugerville and the line "21404 GRAND NATIONAL AVE" drops it). This
    // is a code read and a unit test, not a measured MCP answer: no OAuth token
    // for the gate in this lane. The probe's address predicate grades this side
    // the moment one is supplied.
    components: { city: situsCity, state: situsState, zip: situsZip },
  });
  const flood = railStateFromRead(input.flood ?? { attempted: false });
  // A live drainage read wins when one was attempted; otherwise the rail is
  // the bake's drainage facet, exactly as the node section reads it (F7).
  const drainage = input.drainage?.attempted
    ? railStateFromRead(input.drainage)
    : railStateFromSectionDisposition(drainageDisposition(root.drainage ?? null));
  return {
    parcelNodeId: input.parcelNodeId,
    label: situs.label,
    url: `${SMARTSITE_PARCEL_URL_PREFIX}${input.parcelNodeId}`,
    situs: situs.situs,
    zoning: input.parcelRecordZoningFact
      ? railStateFromZoningFact(input.parcelRecordZoningFact)
      : railStateFromSectionDisposition(zoningDisposition(root.zoning)),
    landUse: railStateFromSectionDisposition(
      landUseDisposition(baseFacts.landUse),
    ),
    flood,
    drainage,
    envelope: input.parcelRecordSetbacksFact
      ? railStateFromSetbacksFact(input.parcelRecordSetbacksFact)
      : railStateFromSectionDisposition(
          envelopeDisposition(root.envelope, input.envelopeBriefRefusal),
        ),
  };
}
