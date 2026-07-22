/**
 * Property Explorer GTM → Pipedrive sync (sovereignty boundary holds).
 * Identity + funnel signal only — never tenant-private research payloads.
 */

import {
  isPipedriveConfigured,
  syncPipedriveDeal,
  syncPipedrivePerson,
  type PipedriveSyncResult,
} from "./brokeragePipedrive";
import { peSyntheticEmail } from "./gtmPropertyExplorerFunnel";

export type PropertyExplorerCrmSync = {
  pipedrive?: PipedriveSyncResult;
  pipedriveConfigured: boolean;
};

export async function syncPropertyExplorerCrm(input: {
  eventType: string;
  installId: string;
  payload?: Record<string, unknown>;
}): Promise<PropertyExplorerCrmSync> {
  const parcelNodeId =
    typeof input.payload?.parcelNodeId === "string"
      ? input.payload.parcelNodeId
      : null;
  const persona =
    typeof input.payload?.persona === "string" ? input.payload.persona : null;

  const base: PropertyExplorerCrmSync = {
    pipedriveConfigured: isPipedriveConfigured(),
  };

  switch (input.eventType) {
    case "pe_signup_intent":
      return {
        ...base,
        pipedrive: await syncPipedrivePerson({
          email: peSyntheticEmail(input.installId),
          installId: input.installId,
          acquisitionSource: "property-explorer:signup_intent",
        }),
      };
    case "pe_save_property":
      return {
        ...base,
        pipedrive: await syncPipedriveDeal({
          installId: input.installId,
          title: `Property Explorer — saved parcel ${parcelNodeId ?? input.installId.slice(0, 8)}`,
        }),
      };
    case "pe_research_clicked":
    case "pe_paywall_hit":
      return {
        ...base,
        pipedrive: await syncPipedriveDeal({
          installId: input.installId,
          title: `Property Explorer — research intent${parcelNodeId ? ` (${parcelNodeId})` : ""}${persona ? ` [${persona}]` : ""}`,
        }),
      };
    case "pe_upgrade_started":
      return {
        ...base,
        pipedrive: await syncPipedriveDeal({
          installId: input.installId,
          title: `Property Explorer — upgrade started ${input.installId.slice(0, 8)}`,
          stage: process.env.PIPEDRIVE_PE_UPGRADE_STAGE_ID?.trim() || undefined,
        }),
      };
    default:
      return base;
  }
}
