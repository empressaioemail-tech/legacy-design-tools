/**
 * Best-effort atom_events for Property Brief — mirrors parcelBriefings.ts.
 */

import type { EventAnchoringService } from "@hauska/atom-contract";
import { getHistoryService } from "../atoms/registry";
import { logger } from "./logger";
import {
  buildPropertyWorkspaceDid,
  buildBriefRunDid,
} from "./brokerageBriefAtoms";

export const PROPERTY_WORKSPACE_CREATED_EVENT_TYPE =
  "property-workspace.created" as const;
export const BRIEF_RUN_GENERATED_EVENT_TYPE = "brief-run.generated" as const;

const BROKERAGE_BRIEF_ACTOR = {
  kind: "system" as const,
  id: "brokerage-brief-api",
};

export async function emitPropertyWorkspaceCreatedEvent(input: {
  listingKey: string;
  address: string;
  llUuid?: string | null;
  latitude?: number;
  longitude?: number;
  history?: EventAnchoringService;
  reqLog?: typeof logger;
}): Promise<void> {
  const history = input.history ?? getHistoryService();
  const reqLog = input.reqLog ?? logger;
  try {
    const event = await history.appendEvent({
      entityType: "property-workspace",
      entityId: input.listingKey,
      eventType: PROPERTY_WORKSPACE_CREATED_EVENT_TYPE,
      actor: BROKERAGE_BRIEF_ACTOR,
      payload: {
        workspaceDid: buildPropertyWorkspaceDid(input.listingKey),
        address: input.address,
        llUuid: input.llUuid ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      },
    });
    reqLog.info(
      {
        listingKey: input.listingKey,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "property-workspace.created event appended",
    );
  } catch (err) {
    reqLog.error(
      { err, listingKey: input.listingKey },
      "property-workspace.created event append failed — brief kept",
    );
  }
}

export async function emitBriefRunGeneratedEvent(input: {
  listingKey: string;
  runId: string;
  address: string;
  jurisdictionKey: string | null;
  corpusStatus: string;
  citationCount: number;
  history?: EventAnchoringService;
  reqLog?: typeof logger;
}): Promise<void> {
  const history = input.history ?? getHistoryService();
  const reqLog = input.reqLog ?? logger;
  try {
    const event = await history.appendEvent({
      entityType: "brief-run",
      entityId: input.runId,
      eventType: BRIEF_RUN_GENERATED_EVENT_TYPE,
      actor: BROKERAGE_BRIEF_ACTOR,
      payload: {
        briefRunDid: buildBriefRunDid(input.runId),
        workspaceDid: buildPropertyWorkspaceDid(input.listingKey),
        listingKey: input.listingKey,
        address: input.address,
        jurisdictionKey: input.jurisdictionKey,
        corpusStatus: input.corpusStatus,
        citationCount: input.citationCount,
      },
    });
    reqLog.info(
      {
        runId: input.runId,
        listingKey: input.listingKey,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "brief-run.generated event appended",
    );
  } catch (err) {
    reqLog.error(
      { err, runId: input.runId, listingKey: input.listingKey },
      "brief-run.generated event append failed — brief kept",
    );
  }
}
