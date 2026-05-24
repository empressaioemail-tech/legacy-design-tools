import type { ResponseTaskAtom } from "@workspace/api-client-react";

/** Dev-only demo seed (`VITE_DEMO_SEED=1`). */
export function isDemoSeedEnabled(): boolean {
  const v = import.meta.env.VITE_DEMO_SEED;
  return v === "1" || v === "true";
}

const now = Date.now();
const hours = (n: number) => new Date(now - n * 60 * 60 * 1000).toISOString();

const demoAtom = (
  partial: Pick<ResponseTaskAtom, "entityId" | "title" | "description" | "state" | "createdAt" | "actorId"> &
    Partial<ResponseTaskAtom>,
): ResponseTaskAtom => ({
  entityType: "response-task",
  jurisdictionTenant: "demo",
  fetchedAt: partial.createdAt,
  sourceAdapter: "demo-seed",
  sourceUrl: "",
  contentHash: "",
  dueAt: null,
  completedAt: null,
  sourceClientCommentId: null,
  findingId: null,
  engagementId: null,
  principalActorId: null,
  accessPolicy: "public-free",
  ...partial,
});

export function demoResponseTasksForEngagement(
  engagementId: string,
): ResponseTaskAtom[] {
  return DEMO_RESPONSE_TASKS_TEMPLATE.map((t) => ({
    ...t,
    engagementId,
    entityId: `${engagementId}-${t.entityId}`,
  }));
}

const DEMO_RESPONSE_TASKS_TEMPLATE: ResponseTaskAtom[] = [
  demoAtom({
    entityId: "demo-rt-1",
    title: "Respond to west setback comment",
    description:
      "Client asked whether the garage bump-out clears the 5 ft side setback. Draft cites UGRC parcel + latest snapshot walls.",
    state: "open",
    actorId: "cortex-in-app-agent",
    createdAt: hours(2),
  }),
  demoAtom({
    entityId: "demo-rt-2",
    title: "Clarify FEMA zone X wording in letter",
    description: "Reviewer wants plainer language in the comment-response letter.",
    state: "in-progress",
    actorId: "operator",
    createdAt: hours(5),
  }),
  demoAtom({
    entityId: "demo-rt-3",
    title: "Upload revised site plan PDF",
    description: "",
    state: "open",
    actorId: "operator",
    createdAt: hours(26),
  }),
  demoAtom({
    entityId: "demo-rt-4",
    title: "Mark height finding addressed",
    description: "Coordinate with structural on parapet reduction.",
    state: "done",
    actorId: "operator",
    createdAt: hours(30),
    completedAt: hours(8),
  }),
  demoAtom({
    entityId: "demo-rt-5",
    title: "Archive superseded comment thread",
    description: "Superseded by v12 snapshot — no further action.",
    state: "cancelled",
    actorId: "operator",
    createdAt: hours(80),
  }),
];

export interface DemoInboxItem {
  id: string;
  kind: "needs-you" | "fyi" | "reviewer";
  title: string;
  preview: string;
  engagementId: string;
  engagementName: string;
  createdAt: string;
}

export const DEMO_INBOX_ITEMS: DemoInboxItem[] = [
  {
    id: "inbox-1",
    kind: "needs-you",
    title: "Client comment on Musgrave setback",
    preview: "Can you confirm the garage meets the 5 ft side yard?",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(1),
  },
  {
    id: "inbox-2",
    kind: "reviewer",
    title: "Reviewer request: clarify egress path",
    preview: "Please attach sheet A102 highlighting the exit door swing.",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(4),
  },
  {
    id: "inbox-3",
    kind: "needs-you",
    title: "Redd — new snapshot synced",
    preview: "15 sheets · 7 levels. Plan review findings are ready to triage.",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(6),
  },
  {
    id: "inbox-4",
    kind: "fyi",
    title: "Site context briefing completed",
    preview: "UGRC DEM + parcels layers generated without adapter errors.",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(12),
  },
  {
    id: "inbox-5",
    kind: "fyi",
    title: "Render hero exterior reached 60%",
    preview: "Marketing render set — 3 of 4 hero frames complete.",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(20),
  },
  {
    id: "inbox-6",
    kind: "needs-you",
    title: "Publish prep blocked",
    preview: "2 checklist items remain before export unlocks.",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(28),
  },
];
