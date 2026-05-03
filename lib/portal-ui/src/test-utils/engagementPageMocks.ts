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
        queryFn: async () => ({ findings: [] }),
        enabled: opts?.query?.enabled ?? !!submissionId,
      }),
    useOverrideFinding: noopMutationHook,
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
  };
}
