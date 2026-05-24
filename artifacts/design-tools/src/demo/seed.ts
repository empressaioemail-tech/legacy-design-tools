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

export type DemoInboxKind =
  | "needs-you"
  | "fyi"
  | "reviewer"
  | "ai"
  | "mention";

export interface DemoInboxItem {
  id: string;
  kind: DemoInboxKind;
  title: string;
  preview: string;
  engagementId: string;
  engagementName: string;
  createdAt: string;
  /** Optional due label for action rows */
  dueLabel?: string;
  /** Primary CTA on action cards */
  ctaLabel?: string;
  /** Deep-link segment when opening engagement */
  segment?: string;
  view?: string;
  muted?: boolean;
}

export const DEMO_INBOX_ITEMS: DemoInboxItem[] = [
  {
    id: "inbox-1",
    kind: "needs-you",
    title: "Grand County reviewer requested corrections on Submission #3",
    preview: "4 findings to address; revision due Friday Jun 7",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(0.25),
    dueLabel: "Due Fri Jun 7 · 6 d",
    ctaLabel: "Open submission",
    view: "review",
    segment: "submissions",
  },
  {
    id: "inbox-2",
    kind: "needs-you",
    title: "Client comment on Musgrave setback",
    preview: "Can you confirm the garage meets the 5 ft side yard?",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(1),
    ctaLabel: "Open tasks",
    view: "review",
    segment: "response-tasks",
  },
  {
    id: "inbox-3",
    kind: "needs-you",
    title: "Reviewer requested BIM model refresh",
    preview:
      "Jim P. (Lemhi County) requests an updated GLB export — last seen v2 from 3 wk ago.",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(6),
    ctaLabel: "Re-export model",
    view: "model",
    segment: "snapshots",
    muted: true,
  },
  {
    id: "inbox-4",
    kind: "ai",
    title: "Product spec withdrawn: Old Window Sealant XYZ-200",
    preview: "Used in detail D-W-04. Suggest swap to GE Silpruf SCS2000.",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(1),
    ctaLabel: "Apply swap",
    view: "deliver",
    segment: "product-specs",
  },
  {
    id: "inbox-5",
    kind: "ai",
    title: "Plan review run completed",
    preview: "5 findings detected: 1 blocker, 3 concerns, 1 advisory.",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(48),
    ctaLabel: "Open findings",
    view: "review",
    segment: "findings",
  },
  {
    id: "inbox-6",
    kind: "mention",
    title: "James left a freehand markup on Sheet A3.1",
    preview: "@Maria — Love these proportions! Make these bigger?",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(4),
    ctaLabel: "Open sheet",
    view: "deliver",
    segment: "sheets",
  },
  {
    id: "inbox-7",
    kind: "mention",
    title: "Sarah commented on Letter #2 draft",
    preview: "@Maria — Can we soften the tone of the intro paragraph?",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(72),
    view: "review",
    segment: "deliverable-letters",
    muted: true,
  },
  {
    id: "inbox-8",
    kind: "reviewer",
    title: "Reviewer request: clarify egress path",
    preview: "Please attach sheet A102 highlighting the exit door swing.",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(4),
    view: "review",
    segment: "findings",
  },
  {
    id: "inbox-9",
    kind: "fyi",
    title: "Render complete: Hero exterior · golden hour",
    preview: "4K · 240 credits used",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(2),
    view: "studio",
    segment: "renders",
  },
  {
    id: "inbox-10",
    kind: "fyi",
    title: "Briefing regeneration finished",
    preview: "14 sections updated — new EJScreen data triggered changes",
    engagementId: "977b5469-4b26-4bd0-895e-71ec752b7409",
    engagementName: "Musgrave_Residence_B",
    createdAt: hours(24),
    view: "site",
    segment: "site",
  },
  {
    id: "inbox-11",
    kind: "fyi",
    title: "Submission #2 approved by Grand County",
    preview: "Comments closed — no further action required",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(48),
    muted: true,
  },
  {
    id: "inbox-12",
    kind: "fyi",
    title: "Publish prep blocked",
    preview: "2 checklist items remain before export unlocks.",
    engagementId: "8e2bac10-7e28-445b-b396-553e769e3052",
    engagementName: "Redd",
    createdAt: hours(28),
    view: "studio",
  },
];

export interface DemoInboxPlanItem {
  time: string;
  duration: string;
  label: string;
  tone: "danger" | "warning" | "muted";
}

export const DEMO_INBOX_TODAY_PLAN: DemoInboxPlanItem[] = [
  { time: "9:30 AM", duration: "45 min", label: "Grand County corrections", tone: "danger" },
  { time: "10:30 AM", duration: "15 min", label: "BIM re-export", tone: "warning" },
  { time: "10:45 AM", duration: "10 min", label: "Briefing sources refresh", tone: "muted" },
];

export interface DemoEngagementFilter {
  id: string;
  name: string;
  count: number;
  selected: boolean;
}

export function demoInboxEngagementFilters(): DemoEngagementFilter[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const item of DEMO_INBOX_ITEMS) {
    const cur = counts.get(item.engagementId);
    if (cur) cur.count += 1;
    else counts.set(item.engagementId, { name: item.engagementName, count: 1 });
  }
  return [...counts.entries()].map(([id, { name, count }], i) => ({
    id,
    name,
    count,
    selected: i === 0,
  }));
}

export function inboxHref(item: DemoInboxItem): string {
  const params = new URLSearchParams();
  if (item.view) params.set("view", item.view);
  if (item.segment) params.set("segment", item.segment);
  const qs = params.toString();
  return `/engagements/${item.engagementId}${qs ? `?${qs}` : ""}`;
}

/** Initial publisher checklist toggles when demo seed is on. */
export function demoPublishChecklistState(): Record<string, boolean> {
  return {
    metadata: true,
    "site-context": true,
    "findings-addressed": false,
    "letters-sent": false,
    "client-review": false,
    "publisher-handoff": false,
  };
}

export interface DemoPublishStage {
  id: string;
  label: string;
  summary: string;
  status: "complete" | "active" | "pending" | "blocked";
}

export const DEMO_PUBLISH_STAGES: DemoPublishStage[] = [
  {
    id: "visualize",
    label: "Visualize",
    summary: "3 of 4 hero renders ready · 1 in progress (60%)",
    status: "active",
  },
  {
    id: "assemble",
    label: "Assemble",
    summary: "Client materials draft · Canva template selected",
    status: "pending",
  },
  {
    id: "review",
    label: "Review & send",
    summary: "Letter #2 not sent · 4 open findings block export",
    status: "blocked",
  },
  {
    id: "archive",
    label: "Archive",
    summary: "Locked until bundle export completes",
    status: "pending",
  },
];

export const DEMO_DELIVER_WORKBENCH_BLOCKS = [
  {
    id: "client-materials",
    title: "Client materials",
    description:
      "Canva proposal deck — renders, plans, and metadata mapped to brand template.",
    segment: "client-materials" as const,
    status: "in-progress",
  },
  {
    id: "letters",
    title: "Comment-response letters",
    description: "2 drafts awaiting jurisdiction tone pass.",
    segment: "deliverable-letters" as const,
    status: "needs-you",
  },
  {
    id: "callouts",
    title: "Detail callouts",
    description: "Wall section D-W-04 linked to withdrawn sealant finding.",
    segment: "detail-callouts" as const,
    status: "ai-flag",
  },
  {
    id: "specs",
    title: "Product specs",
    description: "14 references · 1 swap recommended by plan review.",
    segment: "product-specs" as const,
    status: "ready",
  },
  {
    id: "studio",
    title: "Render studio",
    description: "3 of 4 hero frames complete · marketing set.",
    segment: "renders" as const,
    status: "ready",
  },
] as const;
