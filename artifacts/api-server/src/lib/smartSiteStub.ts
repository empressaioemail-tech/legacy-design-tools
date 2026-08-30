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
import { composeSitusLabel } from "./situsCompose";

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

export function composeSmartSiteStub(input: {
  parcelNodeId: string;
  facets: unknown;
  flood?: RailReadInput;
  drainage?: RailReadInput;
  envelopeBriefRefusal?: { state?: string } | null;
}): SmartSiteStub {
  const root = asRecord(input.facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  const situs = composeSitusLabel({
    parcelNodeId: input.parcelNodeId,
    composed:
      (typeof root.situsAddress === "string" ? root.situsAddress : null) ??
      (typeof baseFacts.situsAddress === "string" ? baseFacts.situsAddress : null),
    parts: [
      typeof baseFacts.situsAddress === "string" ? baseFacts.situsAddress : null,
      typeof baseFacts.situsCity === "string" ? baseFacts.situsCity : null,
      typeof baseFacts.situsState === "string" ? baseFacts.situsState : null,
      typeof baseFacts.situsZip === "string" ? baseFacts.situsZip : null,
    ],
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
    zoning: railStateFromSectionDisposition(zoningDisposition(root.zoning)),
    landUse: railStateFromSectionDisposition(
      landUseDisposition(baseFacts.landUse),
    ),
    flood,
    drainage,
    envelope: railStateFromSectionDisposition(
      envelopeDisposition(root.envelope, input.envelopeBriefRefusal),
    ),
  };
}
