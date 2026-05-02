/**
 * EngagementDetail (design-tools) — regression coverage for the
 * post-submit confirmation banner introduced by Task #100 and locked
 * in here by Task #126.
 *
 * The Design Tools engagement page mirrors the Plan Review page's
 * banner: the dialog itself closes on success, so the
 * `SubmissionRecordedBanner` rendered above the engagement header is
 * the only visible receipt that something was recorded. A future
 * change to either `SubmitToJurisdictionDialog#onSubmitted` or the
 * page's `lastSubmission` state could quietly break the reassurance
 * designers rely on, so these tests pin three behaviors:
 *
 *   1. Submitting a package surfaces the banner with the recorded
 *      jurisdiction and a "just now" relative timestamp.
 *   2. Clicking Dismiss hides the banner but leaves the new
 *      submission row in the Submissions tab list (cache invalidation
 *      must still run even when the banner is torn down).
 *   3. The banner auto-clears after the configured 8s timeout
 *      without removing the new submission row.
 *
 * The setup mirrors `artifacts/plan-review/src/pages/__tests__/EngagementDetail.test.tsx`
 * (Task #112) — same hoisted-mock + pre-seeded query cache approach,
 * with the design-tools-specific extra hooks (`useGetSnapshot`,
 * `useUpdateEngagement`, `useListEngagements`, atom history/summary)
 * stubbed so the page can render without touching the network. The
 * `@workspace/site-context/client` SiteMap is mocked because its
 * leaflet/CSS side-effects don't survive happy-dom — the Site tab is
 * never activated in these tests, but the import is still pulled in
 * by the page module.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createMutationCapture,
  makeCapturingMutationHook,
  makeEngagementPageMockHooks,
} from "@workspace/portal-ui/test-utils";

// ── Hoisted fixture state ───────────────────────────────────────────────
//
// Data fixtures stay in `vi.hoisted` so the mock factory below sees
// them at hoist time. The capture for `useCreateEngagementSubmission`
// (`submit.mutate`, `submit.capturedOptions`, `submit.state.isPending`)
// lives at module top-level via the shared `createMutationCapture`
// helper (Task #382) — `vi.mock` is hoisted but its FACTORY runs
// lazily on `await import(...)` below, so the closure over `submit`
// is initialised by the time it runs.
const hoisted = vi.hoisted(() => {
  return {
    engagement: {
      id: "eng-1",
      name: "Modern Cabin",
      jurisdiction: "Boulder, CO",
      // Non-empty address keeps the intake modal from auto-opening
      // (the page pops it whenever `engagement.address` is missing).
      address: "456 Pine St",
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      snapshotCount: 0,
      latestSnapshot: null,
      snapshots: [] as unknown[],
      site: null as unknown,
      revitCentralGuid: null as string | null,
      revitDocumentPath: null as string | null,
    } as {
      id: string;
      name: string;
      jurisdiction: string | null;
      address: string | null;
      status: string;
      createdAt: string;
      updatedAt: string;
      snapshotCount: number;
      latestSnapshot: unknown;
      snapshots: unknown[];
      site: unknown;
      revitCentralGuid: string | null;
      revitDocumentPath: string | null;
    },
    submissions: [] as Array<{
      id: string;
      submittedAt: string;
      jurisdiction: string | null;
      note: string | null;
      status: "pending" | "approved" | "corrections_requested" | "rejected";
      reviewerComment: string | null;
      respondedAt: string | null;
    }>,
    // Briefing payload consumed by the Site tab's `ParcelZoningCard`.
    briefing: null as null | {
      id: string;
      engagementId: string;
      createdAt: string;
      updatedAt: string;
      sources: Array<Record<string, unknown>>;
      narrative: null;
    },
  };
});

const submit = createMutationCapture();
// Findings override mutation (Task #421 / V1-1 / V1-7) — captured so
// the "Address with next revision" tests can assert the page wires
// the row's text/severity/category through and stamps the
// reviewer-comment marker the reviewer-side timeline expects.
const overrideFinding = createMutationCapture<
  unknown,
  {
    findingId: string;
    data: {
      text: string;
      severity: string;
      category: string;
      reviewerComment: string;
    };
  }
>();

// useParams comes from wouter inside the page; hard-pin it to the
// engagement id so we don't need a Router wrapper.
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useParams: () => ({ id: hoisted.engagement.id }),
  };
});

// The 2 KB note ceiling — match the real generated constant so the
// dialog renders identically in the test environment.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
  recordSubmissionResponseBodyReviewerCommentMax: 2048,
}));

// Stub the SiteMap so leaflet's CSS + image asset side-effects don't
// have to load under happy-dom. The Site tab is never activated by
// these tests, but the page module imports the symbol unconditionally.
vi.mock("@workspace/site-context/client", () => ({
  SiteMap: () => null,
}));

// Mock the generated React Query hooks the page (and the dialog it
// renders) consume.
//
// `useGetEngagement` and `useListEngagementSubmissions` are wired
// through real `useQuery` so the dialog's `invalidateQueries` call
// after a successful submit triggers a re-render against the latest
// hoisted submissions array — which is how the new row makes it into
// the Submissions tab during the dismiss/auto-clear assertions.
//
// The remaining hooks (`useGetSnapshot`, `useUpdateEngagement`,
// `useListEngagements`, `useGetAtomHistory`, `useGetAtomSummary`) are
// gated by `enabled: false` or rendered behind closed modals on the
// initial paint, so a no-op stub is enough to keep the page from
// crashing while we exercise the banner.
vi.mock("@workspace/api-client-react", async () => {
  // Pull `useQuery` once at factory time so the per-render hook
  // bodies below stay synchronous (an `await import` inside the
  // hook itself would make it return a Promise instead of a
  // QueryResult and crash the renderer).
  const { useQuery } = await import("@tanstack/react-query");
  return {
    // Shared engagement-page hook bag (Task #398) — provides the
    // dozen identical `useGetEngagement` / `useListEngagements` /
    // `useGetSession` / `useGetSnapshot` / `useListEngagementSubmissions`
    // / `useUpdateEngagement` / `useGetAtomHistory` / `useGetAtomSummary`
    // / `useRecordSubmissionResponse` stubs plus the
    // `RecordSubmissionResponseBodyStatus` enum, `ApiError` alias, and
    // standard query-key helpers every engagement-page test wires up
    // identically. Accessors close over the hoisted fixture so every
    // refetch re-reads the latest values — same behavior the
    // hand-rolled boilerplate had.
    ...(await makeEngagementPageMockHooks({
      engagement: () => hoisted.engagement,
      submissions: () => hoisted.submissions,
    })),
    // File-specific override: capture the create-submission mutation
    // options so the dialog's `onSubmitted` chain can be driven
    // synchronously from each test.
    useCreateEngagementSubmission: makeCapturingMutationHook(submit),
    // Site-tab `ParcelZoningCard` reads the briefing via this hook.
    getGetEngagementBriefingQueryKey: (id: string) =>
      ["getEngagementBriefing", id] as const,
    useGetEngagementBriefing: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBriefing", id] as const),
        queryFn: async () =>
          hoisted.briefing ? { briefing: hoisted.briefing } : null,
        enabled: opts?.query?.enabled ?? true,
      }),
    // Findings tab (Task #421): capture the override mutation.
    useOverrideFinding: makeCapturingMutationHook(overrideFinding),
    // Filter chips (Task #436) consume the generated enums for the
    // URL allow-list and chip labels — re-export the literal shape
    // here so the page module's `Object.keys(FindingCategory)` /
    // `hasOwnProperty(FindingSeverity, raw)` checks survive the mock.
    FindingSeverity: {
      blocker: "blocker",
      concern: "concern",
      advisory: "advisory",
    } as const,
    FindingCategory: {
      setback: "setback",
      height: "height",
      coverage: "coverage",
      egress: "egress",
      use: "use",
      "overlay-conflict": "overlay-conflict",
      "divergence-related": "divergence-related",
      other: "other",
    } as const,
  };
});

const { EngagementDetail } = await import("../EngagementDetail");

// Captured by `renderPage` so `submitOnce` can push the new submission
// row directly into the React Query cache after a successful submit.
// The Submissions tab isn't mounted on first paint (we land on the
// default "Snapshots" tab), so the dialog's `invalidateQueries` call
// has no active observer to drive a refetch — seeding the cache here
// keeps the row instantly visible the moment the user switches tabs,
// without forcing the test to wait for an async refetch under fake
// timers.
let activeClient: QueryClient | null = null;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage(opts?: { seed?: (client: QueryClient) => void }) {
  const client = makeQueryClient();
  activeClient = client;
  // Per-test seeding hook (Task #421) — runs BEFORE the page mounts
  // so the findings-tab tests can populate the submissions list +
  // findings cache before the page's queries fire. Without this, the
  // badge query (`useListSubmissionFindings(latestSubmissionId)`)
  // would still see `submissionsForBadge === undefined` on first
  // paint and never enable, so no `data-testid` ever appears.
  opts?.seed?.(client);
  // Seed the React Query cache with the initial engagement,
  // submissions list, session, and the AppShell's engagements list so
  // the page renders fully on the first paint — no async `findBy*`
  // polling required, which keeps this test compatible with
  // `vi.useFakeTimers()` (testing-library's `waitFor` uses real-time
  // polling that hangs under faked timers).
  client.setQueryData(["getEngagement", hoisted.engagement.id], {
    ...hoisted.engagement,
  });
  client.setQueryData(
    ["listEngagementSubmissions", hoisted.engagement.id],
    hoisted.submissions.map((s) => ({ ...s })),
  );
  client.setQueryData(["listEngagements"], [{ ...hoisted.engagement }]);
  client.setQueryData(["getSession"], { permissions: [] as string[] });
  // Pre-seed the briefing cache so the Site-tab card paints
  // synchronously on mount.
  if (hoisted.briefing) {
    client.setQueryData(["getEngagementBriefing", hoisted.engagement.id], {
      briefing: hoisted.briefing,
    });
  }
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <EngagementDetail />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client };
}

beforeEach(() => {
  activeClient = null;
  hoisted.engagement = {
    id: "eng-1",
    name: "Modern Cabin",
    jurisdiction: "Boulder, CO",
    address: "456 Pine St",
    status: "active",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    snapshotCount: 0,
    latestSnapshot: null,
    snapshots: [],
    site: null,
    revitCentralGuid: null,
    revitDocumentPath: null,
  };
  hoisted.submissions = [];
  hoisted.briefing = null;
  submit.reset();
  overrideFinding.reset();
  // Reset URL state — the page reads the active tab from
  // `?tab=…` once on mount via `useState(() => readTabFromUrl())`,
  // so a leftover query string from a prior test would land us on
  // the wrong tab.
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

/**
 * Drive the full happy-path: click the page-level "Submit to
 * jurisdiction" trigger, click confirm to record a mutate call, push
 * a new submission row into the hoisted list, then fire the captured
 * `onSuccess` so the dialog runs its real invalidate / onSubmitted /
 * onClose chain. Returns the receipt and the row the banner / list
 * should reflect so individual tests can assert against them.
 */
async function submitOnce(opts?: {
  receipt?: { submissionId: string; engagementId: string; submittedAt: string };
  newRow?: (typeof hoisted.submissions)[number];
}) {
  const trigger = screen.getByTestId("submit-jurisdiction-trigger");
  fireEvent.click(trigger);

  // The dialog is now mounted; click confirm to record the mutate
  // call (the mutate spy is a no-op so the promise never resolves on
  // its own — we manually fire onSuccess below).
  fireEvent.click(screen.getByTestId("submit-jurisdiction-confirm"));
  expect(submit.mutate).toHaveBeenCalledTimes(1);
  expect(submit.capturedOptions?.mutation?.onSuccess).toBeDefined();

  const submittedAtIso = new Date().toISOString();
  const receipt = opts?.receipt ?? {
    submissionId: "sub-new",
    engagementId: hoisted.engagement.id,
    submittedAt: submittedAtIso,
  };
  const row =
    opts?.newRow ?? {
      id: receipt.submissionId,
      submittedAt: receipt.submittedAt,
      jurisdiction: hoisted.engagement.jurisdiction,
      note: null,
      status: "pending" as const,
      reviewerComment: null,
      respondedAt: null,
    };
  // Push the new row first so the invalidateQueries refetch sees it.
  hoisted.submissions = [row, ...hoisted.submissions];
  await act(async () => {
    await submit.capturedOptions!.mutation!.onSuccess!(
      receipt,
      { id: hoisted.engagement.id, data: {} },
      undefined,
    );
  });
  // The Submissions tab is not mounted on the default "Snapshots"
  // landing tab, so the dialog's `invalidateQueries` call has no
  // active observer to drive a refetch. Push the latest list into
  // the cache directly so the row is instantly available the moment
  // the user switches tabs — this avoids forcing the test to wait
  // for an async refetch (which would deadlock under the
  // `setTimeout` fake timers used by the auto-clear test).
  if (activeClient) {
    activeClient.setQueryData(
      ["listEngagementSubmissions", hoisted.engagement.id],
      hoisted.submissions.map((s) => ({ ...s })),
    );
  }
  return { receipt, row };
}

/**
 * Switch the engagement page's active tab to "Submissions" so a
 * just-submitted row is visible in the DOM. The page renders six
 * tabs and defaults to "Snapshots", so the past-submissions list is
 * not mounted on first paint — clicking the tab button is the same
 * thing a user would do to verify their submission landed.
 */
function gotoSubmissionsTab() {
  fireEvent.click(screen.getByRole("button", { name: "Submissions" }));
}

function gotoFindingsTab() {
  fireEvent.click(screen.getByTestId("engagement-tab-findings"));
}

/** Convenience builder for `Finding` fixtures used by the findings-tab tests. */
function findingFixture(
  overrides: Partial<{
    id: string;
    submissionId: string;
    severity: "blocker" | "concern" | "advisory";
    category: string;
    status: string;
    text: string;
    citations: unknown[];
    confidence: number;
    lowConfidence: boolean;
    reviewerStatusBy: { kind: "user"; id: string; displayName: string } | null;
    reviewerStatusChangedAt: string | null;
    reviewerComment: string | null;
    elementRef: string | null;
    sourceRef: unknown;
    aiGeneratedAt: string;
    revisionOf: string | null;
  }> = {},
) {
  return {
    id: "finding:sub-latest:01",
    submissionId: "sub-latest",
    severity: "blocker" as const,
    category: "egress",
    status: "ai-produced",
    text: "Door clearance fails at corridor.",
    citations: [],
    confidence: 0.9,
    lowConfidence: false,
    reviewerStatusBy: null,
    reviewerStatusChangedAt: null,
    reviewerComment: null,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: "2026-05-01T00:00:00Z",
    revisionOf: null,
    ...overrides,
  };
}

function seedSubmissionsWithFindings(
  findings: ReturnType<typeof findingFixture>[],
): (client: QueryClient) => void {
  return (client) => {
    const subs = [
      {
        id: "sub-old",
        submittedAt: "2026-04-01T00:00:00Z",
        jurisdiction: "Boulder, CO",
        note: null,
        status: "approved" as const,
        reviewerComment: null,
        respondedAt: null,
        responseRecordedAt: null,
      },
      {
        id: "sub-latest",
        submittedAt: "2026-05-01T00:00:00Z",
        jurisdiction: "Boulder, CO",
        note: null,
        status: "pending" as const,
        reviewerComment: null,
        respondedAt: null,
        responseRecordedAt: null,
      },
    ];
    hoisted.submissions = subs;
    client.setQueryData(
      ["listEngagementSubmissions", hoisted.engagement.id],
      subs.map((s) => ({ ...s })),
    );
    // Mirror the helper's getListSubmissionFindingsQueryKey shape.
    client.setQueryData(["/api/submissions/sub-latest/findings"], {
      findings,
    });
    client.setQueryData(["/api/submissions/sub-old/findings"], {
      findings: [],
    });
  };
}

describe("EngagementDetail submission banner (Task #126)", () => {
  it("surfaces a 'just now' confirmation banner with the recorded jurisdiction after a successful submit", async () => {
    renderPage();
    await submitOnce();

    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    // Jurisdiction snapshot is captured at submit-time, so the banner
    // copy must read the engagement's current jurisdiction string.
    expect(within(banner).getByText("Boulder, CO")).toBeInTheDocument();
    // The relative-time helper returns "just now" for any timestamp
    // within the last 5 seconds, which the new receipt always is.
    expect(within(banner).getByText("just now")).toBeInTheDocument();
    // The dialog itself should have closed on success.
    expect(
      screen.queryByTestId("submit-jurisdiction-dialog"),
    ).not.toBeInTheDocument();
  });

  it("hides the banner when Dismiss is clicked but keeps the new submission row in the list", async () => {
    renderPage();
    const { row } = await submitOnce();

    // Banner is visible to start.
    expect(
      screen.getByTestId("submit-jurisdiction-success-banner"),
    ).toBeInTheDocument();
    // Switch to the Submissions tab so the freshly-recorded row is
    // mounted in the DOM. The cache invalidation triggered by the
    // dialog's onSuccess hands the tab the latest hoisted list on
    // first render.
    gotoSubmissionsTab();
    expect(
      screen.getByTestId(`submission-row-${row.id}`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("submit-jurisdiction-success-dismiss"));

    // Banner is gone, but the row the cache invalidation surfaced
    // must remain — the two pieces of state are independent.
    expect(
      screen.queryByTestId("submit-jurisdiction-success-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`submission-row-${row.id}`),
    ).toBeInTheDocument();
  });

  it("mounts cleanly under [data-theme=\"light\"] (Task #420 sanity)", () => {
    document.documentElement.dataset.theme = "light";
    try {
      expect(() => renderPage()).not.toThrow();
      expect(
        screen.getByTestId("submit-jurisdiction-trigger"),
      ).toBeInTheDocument();
    } finally {
      document.documentElement.dataset.theme = "dark";
    }
  });

  it("renders the Findings tab between Submissions and Settings", () => {
    renderPage();
    const tabs = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-testid"))
      .filter(
        (v): v is string => typeof v === "string" && v.startsWith("engagement-tab-"),
      );
    const sub = tabs.indexOf("engagement-tab-submissions");
    const find = tabs.indexOf("engagement-tab-findings");
    const settings = tabs.indexOf("engagement-tab-settings");
    expect(sub).toBeGreaterThanOrEqual(0);
    expect(find).toBe(sub + 1);
    expect(settings).toBe(find + 1);
  });

  it("auto-clears the banner after the 8s timeout and leaves the submission row intact", async () => {
    // Fake only `setTimeout`/`clearTimeout` so we can fast-forward
    // the parent's auto-dismiss schedule without touching the timers
    // testing-library / react-query rely on internally (a full
    // `vi.useFakeTimers()` would hang their internal polling). The
    // page's `useEffect` calls `window.setTimeout` /
    // `window.clearTimeout` directly, so this targeted fake catches
    // the auto-dismiss schedule while leaving everything else on
    // real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderPage();
      const { row } = await submitOnce();
      expect(
        screen.getByTestId("submit-jurisdiction-success-banner"),
      ).toBeInTheDocument();

      // Just before the threshold the banner is still up.
      act(() => {
        vi.advanceTimersByTime(7_999);
      });
      expect(
        screen.queryByTestId("submit-jurisdiction-success-banner"),
      ).toBeInTheDocument();

      // Crossing 8s tears the banner down…
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(
        screen.queryByTestId("submit-jurisdiction-success-banner"),
      ).not.toBeInTheDocument();

      // …but the new submission row is still available when the
      // user navigates to the Submissions tab to verify it landed.
      gotoSubmissionsTab();
      expect(
        screen.getByTestId(`submission-row-${row.id}`),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Site-tab `ParcelZoningCard` — Bastrop populated + Boston fallback.
function gotoSiteTab() {
  fireEvent.click(screen.getByRole("button", { name: "Site" }));
}

describe("EngagementDetail Site tab parcel & zoning card", () => {
  it("renders the populated ParcelZoningCard for a Bastrop engagement", () => {
    hoisted.engagement = {
      ...hoisted.engagement,
      jurisdiction: "Bastrop County, TX",
      address: "123 Cedar Way, Bastrop, TX",
      site: {
        geocode: { latitude: 30.1105, longitude: -97.3153 },
      },
    };
    hoisted.briefing = {
      id: "brf-1",
      engagementId: hoisted.engagement.id,
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      narrative: null,
      sources: [
        {
          id: "src-parcel",
          layerKind: "bastrop-tx-parcels",
          sourceKind: "local-adapter",
          provider: "Bastrop County GIS",
          snapshotDate: "2026-04-20T00:00:00.000Z",
          note: null,
          uploadObjectPath: "",
          uploadOriginalFilename: "",
          uploadContentType: "",
          uploadByteSize: 0,
          dxfObjectPath: null,
          glbObjectPath: null,
          conversionStatus: null,
          conversionError: null,
          payload: {
            kind: "parcel",
            parcel: {
              attributes: { PARCEL_ID: "R12345", ACRES: 0.5 },
            },
          },
          createdAt: "2026-04-20T00:00:00.000Z",
          supersededAt: null,
          supersededById: null,
        },
        {
          id: "src-zoning",
          layerKind: "bastrop-tx-zoning",
          sourceKind: "local-adapter",
          provider: "Bastrop County Zoning",
          snapshotDate: "2026-04-18T00:00:00.000Z",
          note: null,
          uploadObjectPath: "",
          uploadOriginalFilename: "",
          uploadContentType: "",
          uploadByteSize: 0,
          dxfObjectPath: null,
          glbObjectPath: null,
          conversionStatus: null,
          conversionError: null,
          payload: {
            kind: "zoning",
            zoning: {
              attributes: {
                ZONING: "R-1",
                ZONE_DESC: "Single-Family Residential",
              },
            },
          },
          createdAt: "2026-04-18T00:00:00.000Z",
          supersededAt: null,
          supersededById: null,
        },
        {
          id: "src-flood",
          layerKind: "bastrop-tx-floodplain",
          sourceKind: "local-adapter",
          provider: "Bastrop County GIS",
          snapshotDate: "2026-04-19T00:00:00.000Z",
          note: null,
          uploadObjectPath: "",
          uploadOriginalFilename: "",
          uploadContentType: "",
          uploadByteSize: 0,
          dxfObjectPath: null,
          glbObjectPath: null,
          conversionStatus: null,
          conversionError: null,
          payload: {
            kind: "floodplain",
            inMappedFloodplain: true,
            features: [{ attributes: { FLD_ZONE: "AE" } }],
          },
          createdAt: "2026-04-19T00:00:00.000Z",
          supersededAt: null,
          supersededById: null,
        },
      ],
    };

    renderPage();
    gotoSiteTab();

    const card = screen.getByTestId("parcel-zoning-card");
    expect(card).toHaveAttribute("data-state", "populated");
    expect(within(card).getByText("R12345")).toBeInTheDocument();
    expect(
      within(card).getByText(/R-1.*Single-Family Residential/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/In mapped floodplain \(Zone AE\)/i),
    ).toBeInTheDocument();
    expect(
      within(card).getByTestId("parcel-zoning-card-provenance"),
    ).toBeInTheDocument();
  });

  it("falls back to the friendly unsupported-jurisdiction copy for a Boston engagement", () => {
    hoisted.engagement = {
      ...hoisted.engagement,
      jurisdiction: "Boston, MA",
      address: "1 City Hall Sq, Boston, MA",
      site: {
        geocode: { latitude: 42.3601, longitude: -71.0589 },
      },
    };
    // Briefing exists but no local adapter coverage for Boston.
    hoisted.briefing = {
      id: "brf-1",
      engagementId: hoisted.engagement.id,
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      narrative: null,
      sources: [],
    };

    renderPage();
    gotoSiteTab();

    const card = screen.getByTestId("parcel-zoning-card");
    expect(card).toHaveAttribute("data-state", "unsupported");
    expect(
      within(card).getByTestId("parcel-zoning-card-unsupported-message"),
    ).toBeInTheDocument();
    expect(
      within(card).getByTestId("parcel-zoning-card-site-context-link"),
    ).toBeInTheDocument();
  });
});

describe("EngagementDetail Findings tab (Task #421 / V1-1 / V1-7)", () => {
  it("badges the Findings tab with the unaddressed-finding count from the most recent submission", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({ id: "finding:sub-latest:01", severity: "blocker" }),
        findingFixture({ id: "finding:sub-latest:02", severity: "concern" }),
        findingFixture({
          id: "finding:sub-latest:03",
          severity: "advisory",
          status: "overridden",
        }),
      ]),
    });
    const badge = screen.getByTestId("engagement-tab-findings-badge");
    expect(badge.textContent).toBe("2");
  });

  it("does not render the badge when there are no unaddressed findings", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({
          id: "finding:sub-latest:01",
          severity: "blocker",
          status: "overridden",
        }),
      ]),
    });
    expect(
      screen.queryByTestId("engagement-tab-findings-badge"),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when the engagement has no submissions", () => {
    renderPage();
    gotoFindingsTab();
    expect(
      screen.getByTestId("findings-tab-empty-no-submissions"),
    ).toBeInTheDocument();
  });

  it("renders the severity-sorted list and auto-selects the highest-severity finding", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({ id: "finding:sub-latest:advisory", severity: "advisory" }),
        findingFixture({ id: "finding:sub-latest:blocker", severity: "blocker" }),
        findingFixture({ id: "finding:sub-latest:concern", severity: "concern" }),
      ]),
    });
    gotoFindingsTab();
    expect(screen.getByTestId("findings-tab")).toBeInTheDocument();
    const list = screen.getByTestId("architect-findings-list");
    const rows = within(list)
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual([
      "architect-findings-row-finding:sub-latest:blocker",
      "architect-findings-row-finding:sub-latest:concern",
      "architect-findings-row-finding:sub-latest:advisory",
    ]);
    expect(
      screen.getByTestId(
        "architect-finding-detail-finding:sub-latest:blocker",
      ),
    ).toBeInTheDocument();
  });

  it("filters the list by severity chip and updates the URL", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({ id: "finding:sub-latest:blocker", severity: "blocker" }),
        findingFixture({ id: "finding:sub-latest:concern", severity: "concern" }),
        findingFixture({ id: "finding:sub-latest:advisory", severity: "advisory" }),
      ]),
    });
    gotoFindingsTab();
    fireEvent.click(
      screen.getByTestId("findings-tab-filter-severity-concern"),
    );
    const list = screen.getByTestId("architect-findings-list");
    const rows = within(list)
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual([
      "architect-findings-row-finding:sub-latest:concern",
    ]);
    expect(window.location.search).toBe("?tab=findings&severity=concern");
    // Active chip carries the data-active marker.
    expect(
      screen
        .getByTestId("findings-tab-filter-severity-concern")
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("findings-tab-filter-severity-all")
        .getAttribute("data-active"),
    ).toBe("false");
  });

  it("filters the list by category chip and updates the URL", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({
          id: "finding:sub-latest:01",
          severity: "blocker",
          category: "egress",
        }),
        findingFixture({
          id: "finding:sub-latest:02",
          severity: "blocker",
          category: "setback",
        }),
      ]),
    });
    gotoFindingsTab();
    fireEvent.click(
      screen.getByTestId("findings-tab-filter-category-setback"),
    );
    const list = screen.getByTestId("architect-findings-list");
    const rows = within(list)
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["architect-findings-row-finding:sub-latest:02"]);
    expect(window.location.search).toBe("?tab=findings&category=setback");
  });

  it("hides addressed findings when the Addressed toggle is flipped off and updates the URL", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({
          id: "finding:sub-latest:open",
          severity: "blocker",
        }),
        findingFixture({
          id: "finding:sub-latest:done",
          severity: "concern",
          status: "overridden",
        }),
      ]),
    });
    gotoFindingsTab();
    // Both rows visible by default.
    expect(
      within(screen.getByTestId("architect-findings-list"))
        .getAllByRole("listitem")
        .map((r) => r.getAttribute("data-testid")),
    ).toEqual([
      "architect-findings-row-finding:sub-latest:open",
      "architect-findings-row-finding:sub-latest:done",
    ]);
    fireEvent.click(screen.getByTestId("findings-tab-filter-show-addressed"));
    expect(
      within(screen.getByTestId("architect-findings-list"))
        .getAllByRole("listitem")
        .map((r) => r.getAttribute("data-testid")),
    ).toEqual(["architect-findings-row-finding:sub-latest:open"]);
    expect(window.location.search).toBe(
      "?tab=findings&showAddressed=false",
    );
  });

  it("hydrates filter state from the URL on first paint", () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=findings&severity=concern&category=egress&showAddressed=false",
    );
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({
          id: "finding:sub-latest:match",
          severity: "concern",
          category: "egress",
        }),
        findingFixture({
          id: "finding:sub-latest:miss",
          severity: "blocker",
          category: "egress",
        }),
        findingFixture({
          id: "finding:sub-latest:done",
          severity: "concern",
          category: "egress",
          status: "overridden",
        }),
      ]),
    });
    // No need to click the tab — it was deep-linked via ?tab=findings.
    expect(screen.getByTestId("findings-tab")).toBeInTheDocument();
    const rows = within(screen.getByTestId("architect-findings-list"))
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["architect-findings-row-finding:sub-latest:match"]);
    expect(
      screen
        .getByTestId("findings-tab-filter-severity-concern")
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("findings-tab-filter-category-egress")
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("findings-tab-filter-show-addressed")
        .getAttribute("data-active"),
    ).toBe("true");
  });

  it("renders the filtered-empty state when no finding matches the active filters", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({
          id: "finding:sub-latest:01",
          severity: "blocker",
          category: "egress",
        }),
      ]),
    });
    gotoFindingsTab();
    fireEvent.click(
      screen.getByTestId("findings-tab-filter-category-setback"),
    );
    expect(
      screen.getByTestId("findings-tab-list-filtered-empty"),
    ).toBeInTheDocument();
  });

  it("clicking 'Address with next revision' calls override with the marker comment and the row's content", () => {
    renderPage({
      seed: seedSubmissionsWithFindings([
        findingFixture({
          id: "finding:sub-latest:01",
          severity: "blocker",
          category: "egress",
          text: "Door clearance fails at corridor.",
        }),
      ]),
    });
    gotoFindingsTab();
    fireEvent.click(
      screen.getByTestId("architect-finding-detail-address-button"),
    );
    expect(overrideFinding.mutate).toHaveBeenCalledTimes(1);
    const [vars] = overrideFinding.mutate.mock.calls[0];
    expect(vars).toEqual({
      findingId: "finding:sub-latest:01",
      data: {
        text: "Door clearance fails at corridor.",
        severity: "blocker",
        category: "egress",
        reviewerComment: "Addressed in next revision",
      },
    });
  });
});
