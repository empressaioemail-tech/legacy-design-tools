/**
 * P-91 stub depth for get_smart_site: label, node id, canonical url,
 * five-state value per rail. Drainage is unread when never fetched.
 * atom-miss maps to unknown. absent-verified only from pipeline
 * present-outside or a :sd:outside bind.
 */

import { SMARTSITE_PARCEL_URL_PREFIX } from "./parcelDrawStub";
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
 * Fifth-state mapper. unread is only legal when the read was not attempted.
 * atom-miss is unknown, never absent-verified.
 */
export function railStateFromRead(read: RailReadInput): SmartSiteRailState {
  if (!read.attempted) return "unread";
  if (read.state == null) return "unknown";
  if (read.state === "refused") {
    return read.code === "atom-miss" ? "unknown" : "refused";
  }
  if (read.kind === "pipeline" && read.state === "present" && read.presentOutside) {
    return "absent-verified";
  }
  if (read.kind === "sd" && (read.state === "absent" || isSdOutsideEntityId(read.entityId))) {
    return "absent-verified";
  }
  if (read.state === "absent") return "unknown";
  if (read.state === "present") return "present";
  return "unknown";
}

function bakeFieldState(value: unknown): SmartSiteRailState {
  if (value == null) return "unknown";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? "present" : "unknown";
  }
  const rec = asRecord(value);
  if (!rec) return "unknown";
  for (const key of ["district", "code", "landUseCode", "zoningCode", "v"]) {
    const candidate = rec[key];
    if (typeof candidate === "string" && candidate.trim()) return "present";
  }
  return Object.keys(rec).length > 0 ? "present" : "unknown";
}

function envelopeHasProductData(envelope: unknown): boolean {
  const record = asRecord(envelope);
  if (!record) return false;
  if (asRecord(record.geojson)) return true;
  return record.status === "ok" || record.status === "no-buildable-area";
}

function envelopeRailState(input: {
  envelope: unknown;
  envelopeBriefRefusal?: { state?: string } | null;
}): SmartSiteRailState {
  if (envelopeHasProductData(input.envelope)) return "present";
  if (input.envelopeBriefRefusal?.state === "refused") return "refused";
  return "unknown";
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
  const drainage = railStateFromRead(input.drainage ?? { attempted: false });
  return {
    parcelNodeId: input.parcelNodeId,
    label: situs.label,
    url: `${SMARTSITE_PARCEL_URL_PREFIX}${input.parcelNodeId}`,
    situs: situs.situs,
    zoning: bakeFieldState(root.zoning),
    landUse: bakeFieldState(baseFacts.landUse),
    flood,
    drainage,
    envelope: envelopeRailState({
      envelope: root.envelope,
      envelopeBriefRefusal: input.envelopeBriefRefusal,
    }),
  };
}
