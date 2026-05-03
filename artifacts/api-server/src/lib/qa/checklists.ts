export interface QaChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export interface QaChecklist {
  readonly id: string;
  readonly app: "plan-review" | "design-tools" | "api-server";
  readonly title: string;
  readonly description: string;
  readonly items: ReadonlyArray<QaChecklistItem>;
}

export const QA_CHECKLISTS: ReadonlyArray<QaChecklist> = [
  {
    id: "plan-review-smoke",
    app: "plan-review",
    title: "Plan Review — smoke",
    description: "Reviewer console + submission detail walkthrough.",
    items: [
      {
        id: "load-inbox",
        label: "Reviewer Inbox loads with at least one engagement row.",
        hint: "Open /plan-review/ — KPI strip + table render without errors.",
      },
      {
        id: "open-submission",
        label: "Open a submission and the detail panel renders.",
      },
      {
        id: "add-finding",
        label: "Add a finding from the canned-finding library picker.",
      },
      {
        id: "comment-letter-pdf",
        label: "Generate a comment-letter PDF and download it.",
        hint: "Use the Communicate tab → Send draft preview button.",
      },
      {
        id: "decide-verdict",
        label: "Record a Decide verdict and confirm the submission status updates.",
      },
    ],
  },
  {
    id: "design-tools-smoke",
    app: "design-tools",
    title: "Design Tools — smoke",
    description: "Architect-side parcel + chat surfaces.",
    items: [
      {
        id: "load-engagement",
        label: "Open an existing engagement and the parcel header renders.",
      },
      {
        id: "create-engagement",
        label: "Create a new engagement via the intake modal end-to-end.",
      },
      {
        id: "chat-roundtrip",
        label: "Send a chat message and receive a response in the engagement chat panel.",
      },
      {
        id: "submit-jurisdiction",
        label: "Run the Submit-to-Jurisdiction dialog and see the post-submit banner.",
      },
      {
        id: "briefing-pdf",
        label: "Open Site Context → export the stakeholder briefing PDF.",
      },
    ],
  },
  {
    id: "api-server-smoke",
    app: "api-server",
    title: "API Server — smoke",
    description: "Direct curl/Postman checks against the API surface.",
    items: [
      {
        id: "healthz",
        label: "GET /api/healthz returns { status: \"ok\" } with HTTP 200.",
      },
      {
        id: "list-engagements",
        label: "GET /api/engagements returns at least one row.",
      },
      {
        id: "session-anonymous",
        label: "GET /api/session returns the anonymous applicant audience by default.",
      },
      {
        id: "snapshot-secret",
        label: "POST /api/engagements/match without the snapshot secret returns 401.",
      },
    ],
  },
];

export function getChecklistById(id: string): QaChecklist | undefined {
  return QA_CHECKLISTS.find((c) => c.id === id);
}
