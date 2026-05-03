/**
 * Second-pass shared test-utils helper for the engagement-page mock
 * factory (Task #398). Builds on the per-hook helpers in
 * `mockApiClient.ts` (`noopQueryHook`, `noopMutationHook`,
 * `createQueryKeyStubs`, `MockApiError`) by returning the *bag* of
 * `@workspace/api-client-react` query/mutation hook stubs every
 * engagement-page test wires up identically — keyed off a shared
 * fixture record so each test only needs to declare its own captures
 * and overrides.
 *
 * Pair with the existing `vi.hoisted(() => ({ engagement, … }))`
 * pattern: the test owns the fixture state and passes accessors
 * (`() => hoisted.engagement`, `() => hoisted.submissions`) so the
 * helper's `useQuery` queryFns re-read the latest values on every
 * refetch — same behavior the hand-rolled boilerplate had.
 *
 * Usage from inside a `vi.mock("@workspace/api-client-react", …)`
 * factory:
 *
 *   vi.mock("@workspace/api-client-react", async () => {
 *     return {
 *       ...(await makeEngagementPageMockHooks({
 *         engagement: () => hoisted.engagement,
 *         submissions: () => hoisted.submissions,
 *       })),
 *       // file-specific overrides spread last so they win:
 *       useCreateEngagementSubmission: makeCapturingMutationHook(submit),
 *     };
 *   });
 */
import {
  MockApiError,
  createQueryKeyStubs,
  noopMutationHook,
  noopQueryHook,
} from "./mockApiClient";

/**
 * Optional accessors the helper consults at fetch time. All accessors
 * are read inside `useQuery`'s queryFn so a `beforeEach` that
 * reassigns `hoisted.engagement = …` is picked up on the next
 * refetch — same shape the hand-rolled boilerplate used.
 */
export interface EngagementPageMockHooksOptions {
  /**
   * Returns the engagement record the page reads through
   * `useGetEngagement(id)` and the AppShell reads through
   * `useListEngagements()`. Optional because some adopting tests
   * (e.g. `BriefingSourceRow.test.tsx`) mount a sub-component that
   * never reaches those hooks — defaulting to `{}` keeps the wired
   * `useQuery` stub from crashing while the consuming code is
   * inert. Tests that *do* render the page-level header should
   * pass an accessor returning a real engagement fixture.
   */
  engagement?: () => Record<string, unknown>;
  /**
   * Returns the submissions list the Submissions tab reads through
   * `useListEngagementSubmissions(id)`. Defaults to an empty list,
   * which matches the "no submissions yet" shape three of the four
   * adopting tests start from.
   */
  submissions?: () => Array<Record<string, unknown>>;
  /**
   * Returns the session record the AppShell reads through
   * `useGetSession()`. Defaults to `{ permissions: [] }`, which is
   * the shape every adopting test starts from — override only when
   * a test exercises a permission gate.
   */
  session?: () => { permissions: string[] };
  /**
   * Returns the renders list the design-tools "Renders" tab reads
   * through `useListEngagementRenders(id)`. Defaults to `[]` so the
   * tab's empty-state branch keeps adopting tests from having to
   * declare it. Adopting tests that exercise the gallery override
   * this to return real fixtures.
   */
  renders?: () => Array<Record<string, unknown>>;
  /**
   * Returns the architect-inbox notifications payload AppShell reads
   * through `useListMyNotifications()` (Task #432) to paint the
   * side-nav unread badge. Defaults to `{ unreadCount: 0,
   * notifications: [] }` so adopting tests that don't exercise the
   * inbox don't need to declare it. Tests that drive the badge
   * override this accessor.
   */
  notifications?: () => { unreadCount: number; notifications: unknown[] };
  /**
   * PLR-v2 Track 1 — returns the current viewer's user-profile
   * record the FE reads through `useGetUser(session.requestor.id)`
   * to resolve the reviewer's `disciplines` for the Inbox default
   * filter and the FindingsTab default-discipline picker. Defaults
   * to `{}` so tests that don't exercise discipline scoping don't
   * have to declare it. Discipline-aware tests pass a `buildUser({
   * scenario: 'reviewer-single' })` (or similar) — the helper's
   * `useGetUser` stub returns the same value for every id passed,
   * which is sufficient because the FE only ever calls it with the
   * caller's own session id.
   */
  me?: () => Record<string, unknown>;
  /**
   * PLR-v2 Track 1 — returns the findings list for a given
   * submission, consumed by `useListSubmissionFindings`. Defaults
   * to `() => []` (matches the legacy hard-coded
   * `{ findings: [] }` shape so adopting tests that don't render
   * the findings tab don't have to declare it). Pass an accessor
   * to drive the AI-badge persistence flow + reviewer-authored
   * branches — typically composed from `buildFinding`.
   */
  findings?: (submissionId: string) => Array<Record<string, unknown>>;
}

/**
 * Build the bag of `@workspace/api-client-react` query/mutation hook
 * stubs and query-key helpers every engagement-page test wires up
 * the same way. The returned object is meant to be spread into the
 * `vi.mock` factory's return value; file-specific overrides should
 * be spread *after* the helper so they take precedence (object
 * spread is last-write-wins).
 *
 * The function is async because it dynamically imports `useQuery`
 * from `@tanstack/react-query` so the helper can be called from
 * inside a `vi.mock` factory without static-import hoisting traps —
 * matches the `await import(...)` pattern the existing tests
 * already use.
 */
export async function makeEngagementPageMockHooks(
  opts: EngagementPageMockHooksOptions,
): Promise<Record<string, unknown>> {
  const { useQuery } = await import("@tanstack/react-query");
  const getEngagement = opts.engagement ?? (() => ({}));
  const getSubmissions = opts.submissions ?? (() => []);
  const getSession =
    opts.session ?? (() => ({ permissions: [] as string[] }));
  const getRenders = opts.renders ?? (() => []);
  const getNotifications =
    opts.notifications ??
    (() => ({ unreadCount: 0, notifications: [] as unknown[] }));
  const getMe = opts.me ?? (() => ({}));
  const getFindings = opts.findings ?? ((_submissionId: string) => []);

  return {
    // Re-export `MockApiError` as `ApiError` so component code that
    // does `instanceof ApiError` keeps branching on the same shape
    // the hand-rolled boilerplate exposed.
    ApiError: MockApiError,
    // Standard query-key helpers — derived from the helper-name
    // convention so a typo in the list fails loudly at import
    // time rather than silently returning `undefined`.
    ...createQueryKeyStubs([
      "getGetEngagementQueryKey",
      "getGetSnapshotQueryKey",
      "getListEngagementsQueryKey",
      "getListEngagementSubmissionsQueryKey",
      "getGetSessionQueryKey",
      "getListEngagementRendersQueryKey",
      "getGetRenderQueryKey",
      "getListMyNotificationsQueryKey",
      "getGetUserQueryKey",
      "getListReviewerQueueQueryKey",
    ] as const),

    // Custom-shape query-key helpers that prepend extra positional
    // args — `createQueryKeyStubs` cannot synthesize these because
    // its algorithm only emits `[label, ...args]`, but every
    // engagement-page test wires the same two shapes verbatim.
    getGetAtomHistoryQueryKey: (
      scope: string,
      id: string,
      params?: unknown,
    ) => ["getAtomHistory", scope, id, params ?? {}] as const,
    getGetAtomSummaryQueryKey: (scope: string, id: string) =>
      ["getAtomSummary", scope, id] as const,

    useGetSession: () =>
      useQuery({
        queryKey: ["getSession"] as const,
        queryFn: async () => getSession(),
      }),
    useListEngagements: (opts?: {
      query?: { queryKey?: readonly unknown[] };
    }) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["listEngagements"] as const),
        queryFn: async () => [{ ...getEngagement() }],
      }),
    useGetEngagement: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getEngagement", id] as const),
        queryFn: async () => ({ ...getEngagement() }),
      }),
    useGetSnapshot: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getSnapshot", id] as const),
        queryFn: async () => null,
        enabled: opts?.query?.enabled ?? false,
      }),
    useUpdateEngagement: noopMutationHook,
    useGetAtomHistory: noopQueryHook,
    useGetAtomSummary: noopQueryHook,
    useListEngagementSubmissions: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementSubmissions", id] as const),
        queryFn: async () => getSubmissions().map((s) => ({ ...s })),
      }),
    useCreateEngagementSubmission: noopMutationHook,
    // V1-2 — ReviewerRequestsStrip mounts in EngagementDetail above
    // the TabBar, so every engagement-page test now needs the
    // reviewer-requests hook + its query-key helper. Default to an
    // empty `requests: []` payload — the strip's zero-state branch
    // (`if (requests.length === 0) return null`) keeps it invisible
    // unless a specific test overrides this hook.
    getListEngagementReviewerRequestsQueryKey: (
      id: string,
      params?: Record<string, unknown>,
    ) =>
      [
        `/api/engagements/${id}/reviewer-requests`,
        ...(params ? [params] : []),
      ] as const,
    useListEngagementReviewerRequests: (
      id: string,
      _params?: Record<string, unknown>,
      opts?: { query?: { enabled?: boolean } },
    ) =>
      useQuery({
        queryKey: ["listEngagementReviewerRequests", id],
        queryFn: async () => ({ requests: [] }),
        enabled: opts?.query?.enabled ?? true,
      }),
    // Architect-side findings surface (Task #421). Defaults: empty
    // list + no-op mutation; tests that exercise the tab override.
    // PLR-v2 Track 1 — when the `findings` accessor is provided,
    // `useListSubmissionFindings` reads from it (so the
    // AI-badge-persistence component test can declare its
    // submission-scoped finding fixture once and have refetches see
    // the latest value); otherwise the legacy empty default holds.
    getListSubmissionFindingsQueryKey: (submissionId: string) =>
      [`/api/submissions/${submissionId}/findings`] as const,
    useListSubmissionFindings: (
      submissionId: string,
      opts?: {
        query?: { enabled?: boolean; queryKey?: readonly unknown[] };
      },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          ([
            `/api/submissions/${submissionId}/findings`,
          ] as const),
        queryFn: async () => ({
          findings: getFindings(submissionId).map((f) => ({ ...f })),
        }),
        enabled: opts?.query?.enabled ?? !!submissionId,
      }),
    useOverrideFinding: noopMutationHook,
    // PLR-v2 Track 1 — reviewer-only mutation that overwrites the
    // submission's classification atom. Defaults to no-op; the
    // architect-Inbox + reviewer-classification component tests
    // override with `makeCapturingMutationHook` to assert the
    // request body.
    useReclassifySubmission: noopMutationHook,
    // PLR-v2 Track 1 — viewer-profile fetch (`GET /users/{id}`)
    // the FE reads via `useGetUser(session.requestor.id)` to
    // resolve `disciplines` for the discipline-scoping flow.
    // Returns the `me` accessor's value for every id (the FE only
    // ever calls this with the session's own id, so a single-shape
    // stub is sufficient — discipline-aware tests pass a
    // `buildUser` to differentiate the four canonical scenarios).
    useGetUser: (
      _id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey: opts?.query?.queryKey ?? (["getUser", _id] as const),
        queryFn: async () => ({ ...getMe() }),
        enabled: opts?.query?.enabled ?? !!_id,
      }),
    // The design-tools Renders tab mounts `RenderGallery`, which
    // calls `useListEngagementRenders(id)` on first paint and
    // `useGetRender(item.id)` per card. Both default to an empty /
    // no-op shape so adopting tests that don't exercise the tab
    // don't have to declare them.
    useListEngagementRenders: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listEngagementRenders", id] as const),
        queryFn: async () => ({
          items: getRenders().map((r) => ({ ...r })),
        }),
        enabled: opts?.query?.enabled ?? true,
      }),
    useGetRender: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getRender", id] as const),
        queryFn: async () => null,
        enabled: opts?.query?.enabled ?? false,
      }),
    useCancelRender: noopMutationHook,
    useKickoffRender: noopMutationHook,
    // AppShell (Task #432) polls the architect-inbox unread count to
    // paint a badge in the side-nav; without an inert stub here the
    // entire page mount throws on first render. Defaults to a zero-
    // count payload so adopting tests that don't exercise the badge
    // don't have to declare it.
    useListMyNotifications: (
      _params?: unknown,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listMyNotifications"] as const),
        queryFn: async () => ({ ...getNotifications() }),
      }),
    // PLR-v2 Track 1 — cross-engagement reviewer Inbox feed. The
    // hook bag returns an empty default; component tests that drive
    // the Inbox triage strip override with the `sampleClassified
    // Submissions` dataset (or a bespoke `buildClassification` /
    // `buildSeverityRollup` / `buildApplicantHistory` composition).
    useListReviewerQueue: (
      _params?: unknown,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["listReviewerQueue"] as const),
        queryFn: async () => ({
          items: [] as Array<Record<string, unknown>>,
          counts: {
            inReview: 0,
            awaitingAi: 0,
            approved: 0,
            rejected: 0,
            backlog: 0,
          },
          kpis: {
            avgReviewTime: { value: null, trend: null, trendLabel: null },
            aiAccuracy: { value: null, trend: null, trendLabel: null },
            complianceRate: {
              value: null,
              trend: null,
              trendLabel: null,
            },
          },
        }),
      }),
  };
}

// =============================================================
// PLR-v2 Track 1 — canonical fixture builders.
//
// These builders return wire-shaped objects matching the OpenAPI
// schemas added in Pass A. They are deliberately loosely typed
// (`Record<string, unknown>`) to match the existing test-utils
// pattern — strict typing makes overrides ergonomically painful in
// component tests, and the builder's JSDoc carries the canonical
// shape per scenario for readability.
//
// Composition pattern: a component test for the Inbox triage strip
// imports `sampleClassifiedSubmissions` (a stable 6-row dataset) for
// the happy path, OR composes its own row from
// `buildClassification`/`buildSeverityRollup`/`buildApplicantHistory`
// when it needs to assert one specific scenario combination.
//
// All builders accept an `overrides` object whose entries shallow-
// merge over the canonical scenario shape. Use overrides for one-
// off field tweaks; pick a different `scenario` when you need a
// structurally different fixture.
// =============================================================

/**
 * PLR-v2 Track 1 — `SubmissionClassification` builder.
 *
 * Scenarios mirror the four classification archetypes the Inbox
 * triage strip needs to render:
 *
 *   - `single-family-residence` — small residential project; the
 *     classic three-discipline package (`building`, `residential`,
 *     `accessibility`).
 *   - `commercial-fit-out` — full six-discipline tenant-improvement
 *     package; the wide-chip-row stress test for the chip group.
 *   - `mep-only` — three MEP disciplines, no architectural
 *     building scope; tests that the chip group renders without a
 *     `building` chip.
 *   - `subdivision-plat` — single-discipline (`building`-only)
 *     plat; the narrow-chip-row scenario.
 */
export function buildClassification(args: {
  scenario:
    | "single-family-residence"
    | "commercial-fit-out"
    | "mep-only"
    | "subdivision-plat";
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const base: Record<string, Record<string, unknown>> = {
    "single-family-residence": {
      submissionId: "submission-sfr-1",
      projectType: "single-family-residence",
      disciplines: ["building", "residential", "accessibility"],
      applicableCodeBooks: ["IRC 2021", "NEC 2020"],
      confidence: 0.92,
      source: "auto",
      classifiedAt: "2026-04-15T14:32:00.000Z",
      classifiedBy: null,
    },
    "commercial-fit-out": {
      submissionId: "submission-cti-1",
      projectType: "commercial-tenant-improvement",
      disciplines: [
        "building",
        "electrical",
        "mechanical",
        "plumbing",
        "fire-life-safety",
        "accessibility",
      ],
      applicableCodeBooks: [
        "IBC 2021",
        "IMC 2021",
        "IPC 2021",
        "NEC 2020",
        "IFC 2021",
      ],
      confidence: 0.88,
      source: "auto",
      classifiedAt: "2026-04-22T09:14:00.000Z",
      classifiedBy: null,
    },
    "mep-only": {
      submissionId: "submission-mep-1",
      projectType: "mep-replacement",
      disciplines: ["electrical", "mechanical", "plumbing"],
      applicableCodeBooks: ["NEC 2020", "IMC 2021", "IPC 2021"],
      confidence: 0.95,
      source: "auto",
      classifiedAt: "2026-04-29T16:48:00.000Z",
      classifiedBy: null,
    },
    "subdivision-plat": {
      submissionId: "submission-plat-1",
      projectType: "subdivision-plat",
      disciplines: ["building"],
      applicableCodeBooks: ["IBC 2021"],
      confidence: 0.79,
      source: "auto",
      classifiedAt: "2026-05-01T11:05:00.000Z",
      classifiedBy: null,
    },
  };
  return { ...base[args.scenario], ...(args.overrides ?? {}) };
}

/**
 * PLR-v2 Track 1 — `ReviewerSeverityRollup` builder.
 *
 * Scenarios cover the four severity-distribution shapes the triage
 * strip's rollup chip differentiates:
 *
 *   - `empty` — zero findings (fresh submission); chip renders the
 *     "no findings yet" placeholder.
 *   - `mostly-advisory` — long tail of advisory + one concern;
 *     chip de-emphasizes the count.
 *   - `balanced` — mix of all three severities; default exemplar.
 *   - `blocker-heavy` — blockers dominate; chip emphasizes the
 *     count (color/style change).
 */
export function buildSeverityRollup(args: {
  scenario: "empty" | "mostly-advisory" | "balanced" | "blocker-heavy";
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const base: Record<string, Record<string, unknown>> = {
    empty: { blockers: 0, concerns: 0, advisory: 0, total: 0 },
    "mostly-advisory": { blockers: 0, concerns: 1, advisory: 8, total: 9 },
    balanced: { blockers: 2, concerns: 5, advisory: 4, total: 11 },
    "blocker-heavy": { blockers: 7, concerns: 3, advisory: 1, total: 11 },
  };
  return { ...base[args.scenario], ...(args.overrides ?? {}) };
}

/**
 * PLR-v2 Track 1 — `ApplicantHistory` builder.
 *
 * Scenarios cover the four applicant-history shapes the hovercard
 * needs to render:
 *
 *   - `first-time` — zero priors; pill renders "first submission".
 *   - `mixed` — three priors with a returned-with-reason row;
 *     hovercard expands to show the row's reason.
 *   - `all-returned` — every prior was returned; pill shifts color.
 *   - `heavy-history` — twelve priors capped at five-most-recent
 *     in `priorSubmissions`; tests the cap is respected.
 */
export function buildApplicantHistory(args: {
  scenario: "first-time" | "mixed" | "all-returned" | "heavy-history";
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const base: Record<string, Record<string, unknown>> = {
    "first-time": {
      totalPrior: 0,
      approved: 0,
      returned: 0,
      lastReturnReason: null,
      priorSubmissions: [],
    },
    mixed: {
      totalPrior: 3,
      approved: 2,
      returned: 1,
      lastReturnReason: "Missing structural calcs on sheet S-201",
      priorSubmissions: [
        {
          submissionId: "prior-sub-3",
          engagementName: "Anderson Residence — Phase 2",
          submittedAt: "2026-03-12T10:00:00.000Z",
          verdict: "approved",
        },
        {
          submissionId: "prior-sub-2",
          engagementName: "Anderson Residence — Phase 1",
          submittedAt: "2026-02-18T14:30:00.000Z",
          verdict: "returned",
          returnReason: "Missing structural calcs on sheet S-201",
        },
        {
          submissionId: "prior-sub-1",
          engagementName: "Wexler Garage Conversion",
          submittedAt: "2026-01-05T09:15:00.000Z",
          verdict: "approved",
        },
      ],
    },
    "all-returned": {
      totalPrior: 4,
      approved: 0,
      returned: 4,
      lastReturnReason: "Egress width below code minimum",
      priorSubmissions: [
        {
          submissionId: "all-ret-4",
          engagementName: "Loft Conversion — 4th Submission",
          submittedAt: "2026-04-12T08:00:00.000Z",
          verdict: "returned",
          returnReason: "Egress width below code minimum",
        },
        {
          submissionId: "all-ret-3",
          engagementName: "Loft Conversion — 3rd Submission",
          submittedAt: "2026-03-08T08:00:00.000Z",
          verdict: "returned",
          returnReason: "Egress width below code minimum",
        },
        {
          submissionId: "all-ret-2",
          engagementName: "Loft Conversion — 2nd Submission",
          submittedAt: "2026-02-04T08:00:00.000Z",
          verdict: "returned",
          returnReason: "Stair rise/run out of compliance",
        },
        {
          submissionId: "all-ret-1",
          engagementName: "Loft Conversion — 1st Submission",
          submittedAt: "2026-01-15T08:00:00.000Z",
          verdict: "returned",
          returnReason: "Incomplete plan set",
        },
      ],
    },
    "heavy-history": {
      totalPrior: 12,
      approved: 8,
      returned: 4,
      lastReturnReason: "Mechanical schedule incomplete",
      priorSubmissions: [
        {
          submissionId: "heavy-12",
          engagementName: "Riverside Mall — Suite 201",
          submittedAt: "2026-04-30T11:00:00.000Z",
          verdict: "approved",
        },
        {
          submissionId: "heavy-11",
          engagementName: "Riverside Mall — Suite 105",
          submittedAt: "2026-04-12T11:00:00.000Z",
          verdict: "approved",
        },
        {
          submissionId: "heavy-10",
          engagementName: "Riverside Mall — Food Court",
          submittedAt: "2026-03-28T11:00:00.000Z",
          verdict: "returned",
          returnReason: "Mechanical schedule incomplete",
        },
        {
          submissionId: "heavy-09",
          engagementName: "Riverside Mall — Suite 303",
          submittedAt: "2026-03-15T11:00:00.000Z",
          verdict: "approved",
        },
        {
          submissionId: "heavy-08",
          engagementName: "Riverside Mall — Anchor East",
          submittedAt: "2026-03-01T11:00:00.000Z",
          verdict: "approved",
        },
      ],
    },
  };
  return { ...base[args.scenario], ...(args.overrides ?? {}) };
}

/**
 * PLR-v2 Track 1 — `Finding` builder, focused on the four AI-badge
 * states the persistence flow needs to render:
 *
 *   - `ai-unaccepted` — engine-produced row a reviewer hasn't
 *     touched yet; badge reads "AI generated".
 *   - `ai-accepted` — engine-produced row a reviewer accepted;
 *     badge reads "AI generated · reviewer confirmed (Name, date)"
 *     — the persistence flow that's the whole point of Track 1's
 *     AI-badge work.
 *   - `reviewer-authored` — manual-add row (no AI provenance);
 *     badge does not render.
 *   - `reviewer-overridden-over-ai` — override revision row that
 *     points at an `aiGenerated: true` ancestor via `revisionOf`;
 *     badge renders "Reviewer override of AI" (or similar).
 *
 * `submissionId` is a callable arg because the FE tests assert
 * findings render under a specific submission's tab; the builder
 * stamps it onto the row so the caller doesn't have to remember
 * to override it.
 */
export function buildFinding(args: {
  submissionId: string;
  scenario:
    | "ai-unaccepted"
    | "ai-accepted"
    | "reviewer-authored"
    | "reviewer-overridden-over-ai";
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const common = {
    submissionId: args.submissionId,
    severity: "concerns",
    category: "egress",
    text: "Stair S-1 rise/run combination is outside the IBC 2021 §1011.5.2 envelope.",
    citations: [],
    confidence: 0.87,
    lowConfidence: false,
    reviewerComment: null,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: "2026-05-01T12:00:00.000Z",
    revisionOf: null,
  } as const;
  const base: Record<string, Record<string, unknown>> = {
    "ai-unaccepted": {
      ...common,
      id: `finding:${args.submissionId}:01HXAIUN`,
      status: "ai-produced",
      reviewerStatusBy: null,
      reviewerStatusChangedAt: null,
      aiGenerated: true,
      acceptedByReviewerId: null,
      acceptedAt: null,
      acceptedBy: null,
    },
    "ai-accepted": {
      ...common,
      id: `finding:${args.submissionId}:01HXAIAC`,
      status: "accepted",
      reviewerStatusBy: {
        kind: "user",
        id: "user-reviewer-jordan",
        displayName: "Jordan Reviewer",
      },
      reviewerStatusChangedAt: "2026-05-02T08:30:00.000Z",
      aiGenerated: true,
      acceptedByReviewerId: "user-reviewer-jordan",
      acceptedAt: "2026-05-02T08:30:00.000Z",
      acceptedBy: {
        kind: "user",
        id: "user-reviewer-jordan",
        displayName: "Jordan Reviewer",
      },
    },
    "reviewer-authored": {
      ...common,
      id: `finding:${args.submissionId}:01HXRVAUTH`,
      status: "ai-produced",
      reviewerStatusBy: {
        kind: "user",
        id: "user-reviewer-jordan",
        displayName: "Jordan Reviewer",
      },
      reviewerStatusChangedAt: "2026-05-02T09:15:00.000Z",
      aiGenerated: false,
      acceptedByReviewerId: null,
      acceptedAt: null,
      acceptedBy: null,
    },
    "reviewer-overridden-over-ai": {
      ...common,
      id: `finding:${args.submissionId}:01HXOVRR`,
      status: "ai-produced",
      reviewerStatusBy: {
        kind: "user",
        id: "user-reviewer-jordan",
        displayName: "Jordan Reviewer",
      },
      reviewerStatusChangedAt: "2026-05-02T10:45:00.000Z",
      aiGenerated: false,
      acceptedByReviewerId: null,
      acceptedAt: null,
      acceptedBy: null,
      revisionOf: `finding:${args.submissionId}:01HXOVRR-ANCESTOR`,
    },
  };
  return { ...base[args.scenario], ...(args.overrides ?? {}) };
}

/**
 * PLR-v2 Track 1 — `User` builder, covering the four
 * discipline-assignment scenarios that drive Inbox filter +
 * FindingsTab default-discipline behavior:
 *
 *   - `reviewer-single` — one discipline (`fire-life-safety`);
 *     Inbox filters to that discipline by default.
 *   - `reviewer-multiple` — two disciplines (`building`,
 *     `residential`); Inbox filters to the union.
 *   - `reviewer-zero` — no disciplines yet; Inbox shows the
 *     one-time "assign yourself a discipline" banner.
 *   - `admin` — admin user with `users:manage`; can edit other
 *     users' disciplines.
 */
export function buildUser(args: {
  scenario:
    | "reviewer-single"
    | "reviewer-multiple"
    | "reviewer-zero"
    | "admin";
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const common = {
    email: null,
    avatarUrl: null,
    architectPdfHeader: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  } as const;
  const base: Record<string, Record<string, unknown>> = {
    "reviewer-single": {
      ...common,
      id: "user-reviewer-fls",
      displayName: "Riley Fire-Life-Safety",
      disciplines: ["fire-life-safety"],
    },
    "reviewer-multiple": {
      ...common,
      id: "user-reviewer-multi",
      displayName: "Morgan Building+Residential",
      disciplines: ["building", "residential"],
    },
    "reviewer-zero": {
      ...common,
      id: "user-reviewer-zero",
      displayName: "Casey New-Reviewer",
      disciplines: [],
    },
    admin: {
      ...common,
      id: "user-admin-1",
      displayName: "Admin Adminson",
      disciplines: [],
    },
  };
  return { ...base[args.scenario], ...(args.overrides ?? {}) };
}

/**
 * PLR-v2 Track 1 — stable 6-row sample dataset combining
 * `buildClassification` × `buildSeverityRollup` ×
 * `buildApplicantHistory` for the Inbox triage-strip rendering
 * path. Component tests that just need a plausible Inbox without
 * spelling out every combination import this; tests that need to
 * assert one specific combination compose their own row from the
 * builders directly.
 *
 * Each row is a `ReviewerQueueItem`-shaped record:
 *
 *   - submissionId, engagementId, engagementName, jurisdiction,
 *     address, applicantFirm, submittedAt, status, note,
 *     reviewerComment (existing required fields)
 *   - classification (Pass-A optional; populated here)
 *   - severityRollup (Pass-A optional; populated here)
 *   - applicantHistory (Pass-A optional; populated here)
 */
export const sampleClassifiedSubmissions: ReadonlyArray<
  Record<string, unknown>
> = [
  {
    submissionId: "submission-sfr-1",
    engagementId: "engagement-sfr-1",
    engagementName: "Anderson Residence — Phase 2",
    jurisdiction: "Moab, UT",
    address: "421 Sego St",
    applicantFirm: "Anderson Design",
    submittedAt: "2026-04-15T14:32:00.000Z",
    status: "pending",
    note: null,
    reviewerComment: null,
    classification: buildClassification({ scenario: "single-family-residence" }),
    severityRollup: buildSeverityRollup({ scenario: "mostly-advisory" }),
    applicantHistory: buildApplicantHistory({ scenario: "mixed" }),
  },
  {
    submissionId: "submission-cti-1",
    engagementId: "engagement-cti-1",
    engagementName: "Riverside Mall — Suite 412",
    jurisdiction: "Moab, UT",
    address: "1100 N Main St",
    applicantFirm: "Riverside Holdings",
    submittedAt: "2026-04-22T09:14:00.000Z",
    status: "pending",
    note: null,
    reviewerComment: null,
    classification: buildClassification({ scenario: "commercial-fit-out" }),
    severityRollup: buildSeverityRollup({ scenario: "balanced" }),
    applicantHistory: buildApplicantHistory({ scenario: "heavy-history" }),
  },
  {
    submissionId: "submission-mep-1",
    engagementId: "engagement-mep-1",
    engagementName: "Lakeside Office — HVAC Replacement",
    jurisdiction: "Moab, UT",
    address: "200 Lake View Dr",
    applicantFirm: "MEP Specialists",
    submittedAt: "2026-04-29T16:48:00.000Z",
    status: "corrections_requested",
    note: null,
    reviewerComment: "Awaiting revised mechanical schedule.",
    classification: buildClassification({ scenario: "mep-only" }),
    severityRollup: buildSeverityRollup({ scenario: "blocker-heavy" }),
    applicantHistory: buildApplicantHistory({ scenario: "first-time" }),
  },
  {
    submissionId: "submission-plat-1",
    engagementId: "engagement-plat-1",
    engagementName: "Cedar Ridge Subdivision",
    jurisdiction: "Moab, UT",
    address: "Cedar Ridge Rd",
    applicantFirm: "Cedar Ridge Developers",
    submittedAt: "2026-05-01T11:05:00.000Z",
    status: "pending",
    note: null,
    reviewerComment: null,
    classification: buildClassification({ scenario: "subdivision-plat" }),
    severityRollup: buildSeverityRollup({ scenario: "empty" }),
    applicantHistory: buildApplicantHistory({ scenario: "all-returned" }),
  },
  {
    submissionId: "submission-cti-2",
    engagementId: "engagement-cti-2",
    engagementName: "Downtown Coffee — TI",
    jurisdiction: "Moab, UT",
    address: "55 Main St",
    applicantFirm: "Java Holdings",
    submittedAt: "2026-04-25T13:22:00.000Z",
    status: "pending",
    note: null,
    reviewerComment: null,
    classification: buildClassification({
      scenario: "commercial-fit-out",
      overrides: {
        submissionId: "submission-cti-2",
        confidence: 0.71,
      },
    }),
    severityRollup: buildSeverityRollup({ scenario: "balanced" }),
    applicantHistory: buildApplicantHistory({ scenario: "first-time" }),
  },
  {
    submissionId: "submission-sfr-2",
    engagementId: "engagement-sfr-2",
    engagementName: "Wexler Garage Conversion",
    jurisdiction: "Moab, UT",
    address: "88 Aspen Ln",
    applicantFirm: "Wexler Architects",
    submittedAt: "2026-04-18T10:11:00.000Z",
    status: "pending",
    note: null,
    reviewerComment: null,
    classification: buildClassification({
      scenario: "single-family-residence",
      overrides: {
        submissionId: "submission-sfr-2",
        source: "reviewer",
        confidence: 1.0,
        classifiedBy: {
          kind: "user",
          id: "user-reviewer-jordan",
          displayName: "Jordan Reviewer",
        },
      },
    }),
    severityRollup: buildSeverityRollup({ scenario: "mostly-advisory" }),
    applicantHistory: buildApplicantHistory({ scenario: "mixed" }),
  },
];
