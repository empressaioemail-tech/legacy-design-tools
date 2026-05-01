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

  return {
    // Re-export `MockApiError` as `ApiError` so component code that
    // does `instanceof ApiError` keeps branching on the same shape
    // the hand-rolled boilerplate exposed.
    ApiError: MockApiError,
    // Submission-status enum the Submissions tab + reviewer UIs
    // import as a value (e.g. `RecordSubmissionResponseBodyStatus.approved`).
    RecordSubmissionResponseBodyStatus: {
      approved: "approved",
      corrections_requested: "corrections_requested",
      rejected: "rejected",
    } as const,

    // Standard query-key helpers — derived from the helper-name
    // convention so a typo in the list fails loudly at import
    // time rather than silently returning `undefined`.
    ...createQueryKeyStubs([
      "getGetEngagementQueryKey",
      "getGetSnapshotQueryKey",
      "getListEngagementsQueryKey",
      "getListEngagementSubmissionsQueryKey",
      "getGetSessionQueryKey",
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
    useRecordSubmissionResponse: noopMutationHook,
  };
}
