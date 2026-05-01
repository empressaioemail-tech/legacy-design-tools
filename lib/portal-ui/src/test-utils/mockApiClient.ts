/**
 * Shared test-utils for mocking `@workspace/api-client-react` in
 * component tests across `lib/portal-ui` and the artifacts that
 * consume it (Task #382).
 *
 * Each helper is designed to be safe to call inside `vi.hoisted(...)`
 * and `vi.mock(..., factory)` callbacks (no top-level side effects),
 * so the existing `vi.hoisted` + `vi.mock` patterns stay intact —
 * tests only swap their hand-rolled boilerplate for a one-line
 * helper call.
 */
import { vi } from "vitest";

/**
 * Mimics the generated `ApiError` shape the components branch on:
 * `instanceof ApiError`, `.status: number`, `.data: unknown`, and
 * `.name === "ApiError"`. The real `ApiError` constructor takes a
 * Response, which is awkward to fabricate under happy-dom, so this
 * mock takes `(status, data?, message?)` directly.
 */
export class MockApiError extends Error {
  readonly name = "ApiError" as const;
  status: number;
  data: unknown;
  constructor(status: number, data: unknown = null, message?: string) {
    super(message ?? `HTTP ${status}`);
    Object.setPrototypeOf(this, MockApiError.prototype);
    this.status = status;
    this.data = data;
  }
}

/**
 * Subset of the React-Query `useMutation` options shape the dialogs
 * register with the generated `useXxx` hooks. We capture this object
 * so each test can fire `onSuccess` / `onError` by hand instead of
 * standing up a real network round-trip.
 */
export interface MutationOptions<
  TData = unknown,
  TVars = unknown,
  TError = unknown,
> {
  mutation?: {
    onSuccess?: (
      data: TData,
      variables: TVars,
      context: unknown,
    ) => Promise<void> | void;
    onError?: (
      err: TError,
      variables: TVars,
      context: unknown,
    ) => void;
  };
}

/**
 * Hoisted state for a captured mutation:
 *   - `mutate` / `mutateAsync` are spies the test asserts against.
 *   - `capturedOptions` is the slot the test reaches into to fire
 *     `onSuccess` / `onError`.
 *   - `state` flips `isPending` / `isError` to drive the in-flight
 *     branches.
 *   - `reset()` clears the spies + state between tests.
 */
export interface MutationCapture<
  TData = unknown,
  TVars = unknown,
  TError = unknown,
> {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  capturedOptions: MutationOptions<TData, TVars, TError> | null;
  state: { isPending: boolean; isError: boolean };
  reset(): void;
}

/**
 * Build a hoisted `MutationCapture` — the spy + `capturedOptions`
 * slot + flippable `state` every captured-mutation test uses. Pair
 * with `makeCapturingMutationHook(capture)` inside the `vi.mock`
 * factory.
 *
 * Use inside `vi.hoisted(() => createMutationCapture<MyVars>())`.
 */
export function createMutationCapture<
  TData = unknown,
  TVars = unknown,
  TError = unknown,
>(): MutationCapture<TData, TVars, TError> {
  const capture: MutationCapture<TData, TVars, TError> = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    capturedOptions: null,
    state: { isPending: false, isError: false },
    reset() {
      capture.mutate.mockReset();
      capture.mutateAsync.mockReset();
      capture.capturedOptions = null;
      capture.state.isPending = false;
      capture.state.isError = false;
    },
  };
  return capture;
}

/**
 * Build a `(options) => { mutate, mutateAsync, isPending, isError }`
 * factory that captures the mutation options into the supplied
 * capture. Wire this into the `vi.mock("@workspace/api-client-react", ...)`
 * body for the hook the component drives, e.g.:
 *
 *   useCreateEngagementSubmission: makeCapturingMutationHook(hoisted.submit),
 */
export function makeCapturingMutationHook<TData, TVars, TError>(
  capture: MutationCapture<TData, TVars, TError>,
): (options: MutationOptions<TData, TVars, TError>) => {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
} {
  return (options) => {
    capture.capturedOptions = options;
    return {
      mutate: capture.mutate,
      mutateAsync: capture.mutateAsync,
      isPending: capture.state.isPending,
      isError: capture.state.isError,
    };
  };
}

/**
 * Build a bag of `getXxxQueryKey: (...args) => [tag, ...args]` stubs
 * from a list of generated query-key helper names. The implied tag is
 * the helper name with the leading "get" prefix and trailing
 * "QueryKey" suffix stripped, then the first letter lowered:
 *
 *   getGetEngagementQueryKey            → ["getEngagement", ...args]
 *   getListEngagementsQueryKey          → ["listEngagements", ...args]
 *   getListBimModelDivergencesQueryKey  → ["listBimModelDivergences", ...args]
 *
 * Adding a new query-key to mock costs one entry, not a 5-line block.
 * For tests that need a custom shape (e.g. plan-review's
 * `["/engagements", id, "briefing"]` keys), keep declaring the stubs
 * inline instead.
 */
export function createQueryKeyStubs<const TNames extends readonly string[]>(
  names: TNames,
): { [K in TNames[number]]: (...args: unknown[]) => readonly unknown[] } {
  const out: Record<string, (...args: unknown[]) => readonly unknown[]> = {};
  for (const name of names) {
    let label: string = name;
    if (label.startsWith("get")) label = label.slice(3);
    if (label.endsWith("QueryKey"))
      label = label.slice(0, -"QueryKey".length);
    label = label.charAt(0).toLowerCase() + label.slice(1);
    out[name] = (...args: unknown[]) => [label, ...args];
  }
  return out as {
    [K in TNames[number]]: (...args: unknown[]) => readonly unknown[];
  };
}

/**
 * Idle no-data shape for a generated `useGetXxx` hook the test mounts
 * but doesn't drive — keeps the page from crashing while leaving the
 * surface under test free of incidental rendering.
 */
export const noopQueryHook = (): {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} => ({
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
});

/**
 * Idle no-op shape for a generated `useXxxMutation` hook the test
 * mounts but doesn't drive. Returns fresh `vi.fn()` spies each call
 * so a test that DOES want to assert against them can still reach
 * them through the hook's return value.
 */
export const noopMutationHook = (): {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  variables: unknown;
} => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
  variables: undefined,
});
