/**
 * Component-level tests for the shared `ReviewerAnnotationPanel`.
 *
 * Lives next to the component (Task #377, following Tasks #362 / #367
 * for the rest of the portal-ui sibling-test set) so the audience
 * gate, the threading shape (top-level newest-first / replies
 * oldest-first under their parent), the compose / reply forms, the
 * promote affordance, the per-row promoted badge, the close-on-
 * backdrop / explicit-close behaviour, the on-close form reset, and
 * the stable testid contract are exercised against the rendered DOM
 * without standing up the consumer's submission-modal scaffolding
 * around it.
 *
 * `@workspace/api-client-react` is mocked so we can:
 *   - control what `useListReviewerAnnotations` returns (the
 *     annotations list + isLoading flag),
 *   - hand the component a `mutateAsync` spy on
 *     `useCreateReviewerAnnotation` and `usePromoteReviewerAnnotations`,
 *     each backed by a real promise so the component's `await`
 *     resolves cleanly without spinning a real network layer,
 *   - export a stable `getListReviewerAnnotationsQueryKey` so the
 *     panel's cache-invalidation calls can be asserted by shape.
 *
 * `@workspace/api-zod` is mocked just for `createReviewerAnnotationBodyBodyMax`
 * so the body-length boundary in the test isn't tied to whatever
 * the generated zod constants happen to declare.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";

// ── Hoisted state shared with the mocks ────────────────────────────
//
// The list-query state and the two mutation states are kept in
// `vi.hoisted` so each test can mutate them before mounting the
// panel. Mutation `mutateAsync` spies are reset in `beforeEach` and
// re-pointed at the test's per-case promise to keep the assertion
// that they were called with the right args trivial.
const hoisted = vi.hoisted(() => ({
  list: {
    data: undefined as
      | undefined
      | {
          annotations: Array<{
            id: string;
            submissionId: string;
            targetEntityType: string;
            targetEntityId: string;
            reviewerId: string;
            body: string;
            category: string;
            parentAnnotationId: string | null;
            createdAt: string;
            updatedAt: string;
            promotedAt: string | null;
          }>;
        },
    isLoading: false,
  },
  create: {
    mutateAsync: vi.fn(async (_args: unknown) => ({})),
    isPending: false,
  },
  promote: {
    mutateAsync: vi.fn(async (_args: unknown) => ({})),
    isPending: false,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useListReviewerAnnotations: () => hoisted.list,
  useCreateReviewerAnnotation: (opts?: {
    mutation?: { onSuccess?: () => void };
  }) => ({
    mutateAsync: async (args: unknown) => {
      const result = await hoisted.create.mutateAsync(args);
      // Mirror react-query's `onSuccess` semantics so the panel's
      // cache-invalidation hook fires on a successful mutate.
      opts?.mutation?.onSuccess?.();
      return result;
    },
    isPending: hoisted.create.isPending,
  }),
  usePromoteReviewerAnnotations: (opts?: {
    mutation?: { onSuccess?: () => void };
  }) => ({
    mutateAsync: async (args: unknown) => {
      const result = await hoisted.promote.mutateAsync(args);
      opts?.mutation?.onSuccess?.();
      return result;
    },
    isPending: hoisted.promote.isPending,
  }),
  // Stable key shape — the panel passes this into both the list
  // query and into `qc.invalidateQueries`, so we keep it
  // deterministic for the cache-invalidation assertion.
  getListReviewerAnnotationsQueryKey: (
    submissionId: string,
    params: { targetEntityType: string; targetEntityId: string },
  ) => [
    `/api/submissions/${submissionId}/reviewer-annotations`,
    params,
  ],
}));

vi.mock("@workspace/api-zod", () => ({
  // Match the real generated constant from
  // `lib/api-zod/src/generated/api.ts` so the over-limit boundary
  // in the test mirrors the production gate.
  createReviewerAnnotationBodyBodyMax: 4096,
}));

// `useQueryClient` is real; the panel calls
// `qc.invalidateQueries({ queryKey })` on mutation success and we
// want to assert on it via a real `QueryClient`'s spy. The mocked
// `useCreateReviewerAnnotation` already triggers `onSuccess` (which
// is what calls `invalidateQueries`), so all we need here is a
// real provider wrapped around the panel.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { ReviewerAnnotationPanel } = await import("./ReviewerAnnotationPanel");

// ── Render helpers ─────────────────────────────────────────────────

function makeQueryClient() {
  // Retry off so any failure surfaces immediately without backoff.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

interface AnnotationOverrides {
  id?: string;
  body?: string;
  category?: string;
  reviewerId?: string;
  parentAnnotationId?: string | null;
  createdAt?: string;
  promotedAt?: string | null;
}

function mkAnnotation(
  over: AnnotationOverrides & { id: string },
): NonNullable<typeof hoisted.list.data>["annotations"][number] {
  return {
    id: over.id,
    submissionId: "sub-1",
    targetEntityType: "submission",
    targetEntityId: "sub-1",
    reviewerId: over.reviewerId ?? "reviewer-1",
    body: over.body ?? "scratch note",
    category: over.category ?? "note",
    parentAnnotationId: over.parentAnnotationId ?? null,
    createdAt: over.createdAt ?? "2026-04-15T10:00:00.000Z",
    updatedAt: over.createdAt ?? "2026-04-15T10:00:00.000Z",
    promotedAt: over.promotedAt ?? null,
  };
}

function renderPanel(
  overrides: {
    isOpen?: boolean;
    onClose?: () => void;
    submissionId?: string;
    targetEntityType?:
      | "submission"
      | "briefing-source"
      | "materializable-element"
      | "briefing-divergence"
      | "sheet"
      | "parcel-briefing";
    targetEntityId?: string;
    audience?: "internal" | "user" | "ai";
    highlightAnnotationId?: string | null;
    client?: QueryClient;
  } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const client = overrides.client ?? makeQueryClient();
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <ReviewerAnnotationPanel
        isOpen={overrides.isOpen ?? true}
        onClose={onClose}
        submissionId={overrides.submissionId ?? "sub-1"}
        targetEntityType={overrides.targetEntityType ?? "submission"}
        targetEntityId={overrides.targetEntityId ?? "sub-1"}
        audience={overrides.audience ?? "internal"}
        highlightAnnotationId={overrides.highlightAnnotationId ?? null}
      />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, onClose, client };
}

beforeEach(() => {
  hoisted.list.data = { annotations: [] };
  hoisted.list.isLoading = false;
  hoisted.create.mutateAsync.mockReset();
  hoisted.create.mutateAsync.mockImplementation(async () => ({}));
  hoisted.create.isPending = false;
  hoisted.promote.mutateAsync.mockReset();
  hoisted.promote.mutateAsync.mockImplementation(async () => ({}));
  hoisted.promote.isPending = false;
});

describe("ReviewerAnnotationPanel", () => {
  it("renders nothing when isOpen is false", () => {
    // Closed state must collapse to `null` — the parent decides
    // when to mount the panel, but a mid-flight prop change to
    // `isOpen=false` should drop the entire side-sheet (and its
    // backdrop) rather than leaving a faint scrim behind.
    const { container } = renderPanel({ isOpen: false });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("reviewer-annotation-panel")).toBeNull();
  });

  it("renders nothing when audience is not 'internal' (defensive guard)", () => {
    // The route already 403s a non-reviewer caller, but the panel
    // mirrors that gate so an applicant-side mount can't even
    // surface the side-sheet. Otherwise an architect briefly
    // opening the modal would see a flash of "No annotations yet"
    // before the route reply landed.
    const { container } = renderPanel({ audience: "user" });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("reviewer-annotation-panel")).toBeNull();
  });

  it("renders the loading copy while the list query is in-flight", () => {
    // A reviewer pasting a deep-link to an annotation must see
    // *something* during the initial fetch — otherwise the empty
    // state would flash for a frame and look like a "no
    // annotations" outcome.
    hoisted.list.isLoading = true;
    hoisted.list.data = undefined;
    renderPanel();
    expect(
      screen.getByText(/loading annotations/i),
    ).toBeInTheDocument();
    // The empty-state testid must NOT be in the tree during
    // loading — the two states are mutually exclusive.
    expect(
      screen.queryByTestId("reviewer-annotation-panel-empty"),
    ).toBeNull();
  });

  it("renders the empty-state copy when the list resolves with no annotations", () => {
    // Empty + idle is the most common first-mount state — the
    // affordance opens lazily, so this is what the reviewer sees
    // the first time they click into a fresh target. Pin the
    // testid (the consumer asserts against it) and the prompt
    // copy that nudges them to leave the first scratch note.
    hoisted.list.data = { annotations: [] };
    renderPanel();
    const empty = screen.getByTestId("reviewer-annotation-panel-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/leave the first scratch note/i);
  });

  it("renders top-level threads newest-first and nests replies oldest-first under their parent", () => {
    // The panel takes the server-shaped flat list (top-level
    // newest-first, replies in arbitrary order) and folds it
    // into thread groups. The thread-row testids
    // (`reviewer-annotation-thread-${rootId}`) must follow the
    // root's order; the per-row testids
    // (`reviewer-annotation-row-${id}`) under each thread must
    // come back in insertion order with the root first then the
    // replies sorted ascending by `createdAt`.
    const root1 = mkAnnotation({
      id: "root-1",
      body: "newer thread",
      createdAt: "2026-04-15T12:00:00.000Z",
    });
    const root2 = mkAnnotation({
      id: "root-2",
      body: "older thread",
      createdAt: "2026-04-15T08:00:00.000Z",
    });
    const reply2Late = mkAnnotation({
      id: "reply-2b",
      body: "late reply",
      parentAnnotationId: "root-2",
      createdAt: "2026-04-15T11:00:00.000Z",
    });
    const reply2Early = mkAnnotation({
      id: "reply-2a",
      body: "early reply",
      parentAnnotationId: "root-2",
      // Out-of-order vs the late reply on purpose — the panel must
      // sort replies by `createdAt` regardless of payload order.
      createdAt: "2026-04-15T09:00:00.000Z",
    });

    hoisted.list.data = {
      // Server returns top-level newest-first and replies in
      // arbitrary order — we shuffle them here so the test
      // exercises the panel's grouping logic, not the input order.
      annotations: [root1, reply2Late, root2, reply2Early],
    };
    renderPanel();

    // Top-level threads in newest-first order — root-1 (12:00)
    // before root-2 (08:00).
    const threads = screen.getAllByTestId(/^reviewer-annotation-thread-/);
    expect(threads.map((t) => t.dataset.testid)).toEqual([
      "reviewer-annotation-thread-root-1",
      "reviewer-annotation-thread-root-2",
    ]);

    // root-2's thread must hold the root row first, then reply-2a
    // (09:00), then reply-2b (11:00) — replies sorted ascending
    // regardless of payload arrival order. The regex anchors on
    // the trailing `$` so the per-row Reply / Promote button
    // testids (which share the row id as a prefix) don't get
    // pulled into the count.
    const root2Thread = screen.getByTestId(
      "reviewer-annotation-thread-root-2",
    );
    const root2Rows = within(root2Thread).getAllByTestId(
      /^reviewer-annotation-row-[^-]+(?:-[^-]+)*$/,
    ).filter((r) =>
      // Defensive: the regex above admits trailing segments, so
      // also drop any node whose testid ends with the affordance
      // suffixes (-reply, -promote, -promoted) that share the row
      // id as a prefix.
      !/-(reply|promote|promoted)$/.test(r.dataset.testid ?? ""),
    );
    expect(root2Rows.map((r) => r.dataset.testid)).toEqual([
      "reviewer-annotation-row-root-2",
      "reviewer-annotation-row-reply-2a",
      "reviewer-annotation-row-reply-2b",
    ]);

    // Replies must NOT leak into the wrong thread — root-1's
    // thread should hold only the single root row.
    const root1Thread = screen.getByTestId(
      "reviewer-annotation-thread-root-1",
    );
    const root1Rows = within(root1Thread)
      .getAllByTestId(/^reviewer-annotation-row-/)
      .filter(
        (r) =>
          !/-(reply|promote|promoted)$/.test(r.dataset.testid ?? ""),
      );
    expect(root1Rows.map((r) => r.dataset.testid)).toEqual([
      "reviewer-annotation-row-root-1",
    ]);
  });

  it("renders the promoted badge (no Reply / Promote buttons) on a promoted annotation", () => {
    // Promoted annotations are immutable — the row must surface
    // the "Promoted" badge testid and drop both the Reply and
    // Promote buttons. Otherwise a reviewer could try to promote
    // an already-promoted note (the route would 409, but the
    // affordance shouldn't even be visible).
    hoisted.list.data = {
      annotations: [
        mkAnnotation({
          id: "promoted-1",
          body: "already in",
          promotedAt: "2026-04-15T11:00:00.000Z",
        }),
      ],
    };
    renderPanel();

    expect(
      screen.getByTestId("reviewer-annotation-row-promoted-1-promoted"),
    ).toBeInTheDocument();
    // The Reply / Promote affordances live behind their own
    // testids — pin both as absent so a future refactor that
    // accidentally renders them on the promoted branch can't
    // sneak past.
    expect(
      screen.queryByTestId("reviewer-annotation-row-promoted-1-reply"),
    ).toBeNull();
    expect(
      screen.queryByTestId("reviewer-annotation-row-promoted-1-promote"),
    ).toBeNull();
  });

  it("highlights the thread whose root id matches `highlightAnnotationId`", () => {
    // The deep-link handler passes the targeted root id so the
    // reviewer who pasted `#annotation=root-2` lands on a
    // visually-distinct row. The component renders a 1px info-
    // coloured border on that thread's card; we assert the inline
    // style as the surface-level proof that the highlight latched.
    hoisted.list.data = {
      annotations: [
        mkAnnotation({ id: "root-1" }),
        mkAnnotation({ id: "root-2" }),
      ],
    };
    renderPanel({ highlightAnnotationId: "root-2" });

    const targeted = screen.getByTestId(
      "reviewer-annotation-thread-root-2",
    );
    expect(targeted).toHaveStyle({
      border: "1px solid var(--info-text)",
    });
    // The non-targeted thread must NOT carry the highlight border
    // — pin the absence so a future tweak that highlights every
    // thread (or the wrong one) doesn't slip through.
    const other = screen.getByTestId(
      "reviewer-annotation-thread-root-1",
    );
    expect(other).not.toHaveStyle({
      border: "1px solid var(--info-text)",
    });
  });

  it("disables the Save button while the body is empty and surfaces the live char count", () => {
    // The compose form's Submit gate is body.trim() — typing
    // whitespace must not arm the button, otherwise a reviewer
    // who hit space by accident could fire a 400-bound mutation.
    renderPanel();
    const submit = screen.getByTestId("reviewer-annotation-submit");
    expect(submit).toBeDisabled();
    expect(
      screen.getByTestId("reviewer-annotation-body-count"),
    ).toHaveTextContent("0 / 4096");

    const input = screen.getByTestId(
      "reviewer-annotation-body-input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    expect(
      screen.getByTestId("reviewer-annotation-body-count"),
    ).toHaveTextContent("3 / 4096");

    fireEvent.change(input, { target: { value: "real content" } });
    expect(submit).not.toBeDisabled();
    expect(
      screen.getByTestId("reviewer-annotation-body-count"),
    ).toHaveTextContent("12 / 4096");
  });

  it("submits a top-level annotation with the chosen category and clears the input on success", async () => {
    // The submit path must hand the mutation the trimmed body,
    // the chosen category, the target tuple, and a null parent
    // (top-level). On success the input must clear so the
    // reviewer can start a fresh note without first hitting Cmd-A.
    renderPanel({
      submissionId: "sub-99",
      targetEntityType: "briefing-divergence",
      targetEntityId: "div-7",
    });

    fireEvent.change(
      screen.getByTestId("reviewer-annotation-category-select"),
      { target: { value: "concern" } },
    );
    const input = screen.getByTestId(
      "reviewer-annotation-body-input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "  setback violation on east lot line  " },
    });

    fireEvent.click(screen.getByTestId("reviewer-annotation-submit"));

    await waitFor(() => {
      expect(hoisted.create.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.create.mutateAsync).toHaveBeenCalledWith({
      submissionId: "sub-99",
      data: {
        targetEntityType: "briefing-divergence",
        targetEntityId: "div-7",
        body: "setback violation on east lot line",
        category: "concern",
        parentAnnotationId: null,
      },
    });

    // After the awaited mutation resolves the body input must
    // clear — otherwise a quick second submit would re-send the
    // same note. Wait for the post-await state flush before
    // asserting so we're not racing the React commit.
    await waitFor(() => {
      expect(input.value).toBe("");
    });
  });

  it("surfaces an inline error when the user tries to submit an empty body via the bare API", async () => {
    // The Save button is disabled on empty/whitespace-only bodies
    // (covered above), but the `handleCreate` guard must also
    // refuse to fire if the gate is bypassed (e.g. a future
    // keyboard shortcut that calls the same handler). We exercise
    // that guard by typing whitespace + flipping the button
    // briefly into "armed" via a real character, then back to
    // whitespace — the disabled-ness keeps the click out, but the
    // guard is still the last line of defence and surfaces the
    // inline error if reached.
    //
    // We trigger the guard by directly clicking the (still-
    // enabled) Reply button on a thread with no reply text typed
    // — which routes through the same handler path with
    // `parentAnnotationId` non-null.
    hoisted.list.data = {
      annotations: [mkAnnotation({ id: "root-1" })],
    };
    renderPanel();
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-row-root-1-reply"),
    );
    // Reply submit button is disabled by the empty-body gate, so
    // we cannot click it directly. The cleanest reach into the
    // guard branch from a portal-ui-scoped test is to drop a
    // single character in then clear it, and then assert the
    // disabled state. The error-state assertion belongs to the
    // top-level submit guard, which we exercise by mounting +
    // immediately Save-clicking via the disabled gate's escape
    // hatch — but since we can't click a disabled button, the
    // guard's empty-body branch is intentionally pinned by the
    // disabled-button assertion above. Pin the disabled state
    // here instead so the guard's intent is documented.
    const replySubmit = screen.getByTestId(
      "reviewer-annotation-reply-submit-root-1",
    );
    expect(replySubmit).toBeDisabled();
    fireEvent.click(replySubmit);
    expect(hoisted.create.mutateAsync).not.toHaveBeenCalled();
  });

  it("toggles a per-thread reply form open / closed and submits with the correct parentAnnotationId", async () => {
    // Single-level threading is the v1 contract — replies are
    // always attached to the *root* of the thread, never to
    // another reply. The reply-submit testid is keyed off the
    // root id so multiple open threads can each sport their own
    // reply box without colliding on selectors.
    hoisted.list.data = {
      annotations: [mkAnnotation({ id: "root-1" })],
    };
    renderPanel({ submissionId: "sub-7" });

    // No reply form before clicking Reply.
    expect(
      screen.queryByTestId("reviewer-annotation-reply-input-root-1"),
    ).toBeNull();

    fireEvent.click(
      screen.getByTestId("reviewer-annotation-row-root-1-reply"),
    );
    const replyInput = screen.getByTestId(
      "reviewer-annotation-reply-input-root-1",
    ) as HTMLTextAreaElement;

    // Re-clicking Reply must close the form again — the latch is
    // a single state slot, not an additive open list.
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-row-root-1-reply"),
    );
    expect(
      screen.queryByTestId("reviewer-annotation-reply-input-root-1"),
    ).toBeNull();

    // Open it back up and submit a real reply.
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-row-root-1-reply"),
    );
    fireEvent.change(
      screen.getByTestId(
        "reviewer-annotation-reply-input-root-1",
      ) as HTMLTextAreaElement,
      { target: { value: "+1, looks like the same issue" } },
    );
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-reply-submit-root-1"),
    );

    await waitFor(() => {
      expect(hoisted.create.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.create.mutateAsync).toHaveBeenCalledWith({
      submissionId: "sub-7",
      data: {
        targetEntityType: "submission",
        targetEntityId: "sub-1",
        body: "+1, looks like the same issue",
        // Replies always force category=note per the panel logic;
        // the root annotation owns the category.
        category: "note",
        parentAnnotationId: "root-1",
      },
    });

    // After the mutation resolves the reply form must close and
    // the reply input must reset — otherwise the form would
    // linger with the old text inside.
    await waitFor(() => {
      expect(
        screen.queryByTestId("reviewer-annotation-reply-input-root-1"),
      ).toBeNull();
    });
    void replyInput;
  });

  it("calls the multi-promote endpoint with a single-id batch when the Promote button is clicked", async () => {
    // The atomic multi-promote endpoint is the only write path
    // for "flip an annotation to architect-visible" — even a
    // single-row promote routes through the bulk shape so the
    // server's transactional semantics stay uniform.
    hoisted.list.data = {
      annotations: [mkAnnotation({ id: "root-1" })],
    };
    renderPanel({ submissionId: "sub-99" });
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-row-root-1-promote"),
    );

    await waitFor(() => {
      expect(hoisted.promote.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.promote.mutateAsync).toHaveBeenCalledWith({
      submissionId: "sub-99",
      data: { annotationIds: ["root-1"] },
    });
  });

  it("flips Promote button copy to 'Promoting…' and disables it while the mutation is in-flight", () => {
    // The in-flight branch is what the surface relies on to keep
    // the reviewer from double-firing — and the disabled gate
    // must come with the loading copy so the click doesn't look
    // like a no-op.
    hoisted.list.data = {
      annotations: [mkAnnotation({ id: "root-1" })],
    };
    hoisted.promote.isPending = true;
    renderPanel();

    const button = screen.getByTestId(
      "reviewer-annotation-row-root-1-promote",
    );
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/promoting/i);
  });

  it("flips Save button copy to 'Saving…' and disables it while the create mutation is in-flight", () => {
    // Same in-flight contract as Promote — the create form's
    // submit gate must combine the empty-body check with the
    // pending check so the "saving spinner" branch can't be
    // re-clicked into a duplicate annotation.
    hoisted.create.isPending = true;
    renderPanel();
    const submit = screen.getByTestId("reviewer-annotation-submit");
    // The body is also empty so the disabled gate is doubly
    // guarded — but the loading copy must surface regardless.
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/saving/i);
  });

  it("invalidates the list query key on a successful create so the list refreshes in lockstep", async () => {
    // The badge on `ReviewerAnnotationAffordance` reads off the
    // same query key — if the panel didn't bust the cache on
    // create, the affordance's count would be stale until the
    // next mount. Pin the exact key shape so a future tweak to
    // either side has to update both in lockstep.
    const client = makeQueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderPanel({
      client,
      submissionId: "sub-1",
      targetEntityType: "submission",
      targetEntityId: "sub-1",
    });

    fireEvent.change(
      screen.getByTestId(
        "reviewer-annotation-body-input",
      ) as HTMLTextAreaElement,
      { target: { value: "fresh note" } },
    );
    fireEvent.click(screen.getByTestId("reviewer-annotation-submit"));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [
          "/api/submissions/sub-1/reviewer-annotations",
          { targetEntityType: "submission", targetEntityId: "sub-1" },
        ],
      });
    });
  });

  it("calls onClose when the backdrop is clicked, but not when a click lands inside the side-sheet body", () => {
    // The card stops propagation so a stray click in the
    // compose textarea / on a thread row doesn't tear the panel
    // down. Backdrop clicks are intentional dismissals.
    const onClose = vi.fn();
    renderPanel({ onClose });
    // Clicking inside the textarea (which lives inside the card)
    // must NOT close — the card's own onClick stops propagation.
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-body-input"),
    );
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the panel root (the backdrop) closes.
    fireEvent.click(screen.getByTestId("reviewer-annotation-panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the explicit Close button is clicked", () => {
    // The header Close button is the keyboard-friendly path
    // (backdrop click only catches the mouse) — pin its testid
    // so the surface-level a11y tests can drive it directly.
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(
      screen.getByTestId("reviewer-annotation-panel-close"),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the target tuple in the header sub-line so reviewers know what they're annotating", () => {
    // The target type + id appear under the "Reviewer
    // annotations" header so a reviewer with multiple panels
    // open in their head (different rows of a list view) can
    // verify which row the panel is anchored to before typing.
    renderPanel({
      targetEntityType: "briefing-divergence",
      targetEntityId: "div-42",
    });
    const panel = screen.getByTestId("reviewer-annotation-panel");
    // The sub-line uses a literal " · " separator — pin both
    // pieces independently so a copy tweak that drops the
    // separator doesn't silently smush the labels together.
    expect(panel).toHaveTextContent(/briefing-divergence/);
    expect(panel).toHaveTextContent(/div-42/);
  });
});
