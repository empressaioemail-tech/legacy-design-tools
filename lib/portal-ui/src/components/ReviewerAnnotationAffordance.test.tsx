/**
 * Component-level tests for the shared `ReviewerAnnotationAffordance`.
 *
 * Lives next to the component (Task #387, completing the portal-ui
 * sibling-test set started in Tasks #362 / #367 / #377) so the
 * audience gate, the zero / `n>0` badge swap, the singular / plural
 * `title` + `aria-label` copy, the lazy-fetch `enabled` gate (only
 * fires when `isReviewer && submissionId && targetEntityId` are all
 * truthy), the shared list-query-key shape (must equal what
 * `ReviewerAnnotationPanel` passes so the panel populates instantly
 * from the affordance's already-cached list), and the click handler's
 * target-tuple forwarding all live next to the component instead of
 * leaning on whichever artifact happens to import it first.
 *
 * `@workspace/api-client-react` is mocked so we can:
 *   - control what `useListReviewerAnnotations` returns (just the
 *     `data.annotations` length is read by the affordance),
 *   - capture the arguments the affordance passes into the hook —
 *     specifically the per-call `query.enabled` flag and the
 *     `query.queryKey` shape — so the lazy-fetch gate and the
 *     shared-key contract can be asserted without standing up a real
 *     react-query layer,
 *   - hand back a stable `getListReviewerAnnotationsQueryKey` whose
 *     shape mirrors what the panel's own test mocks, so the assertion
 *     "the affordance's queryKey equals the panel's queryKey for the
 *     same target tuple" really pins the contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Hoisted state shared with the mock ─────────────────────────────
//
// `list.data` is the only thing the affordance actually reads off
// the hook; `list.calls` is an arg-capture log so each test can
// assert what the component passed in (the `enabled` flag in
// particular, which is the lazy-fetch contract).
const hoisted = vi.hoisted(() => ({
  list: {
    data: undefined as
      | undefined
      | { annotations: Array<{ id: string }> },
    calls: [] as Array<{
      submissionId: string;
      params: { targetEntityType: string; targetEntityId: string };
      options:
        | undefined
        | {
            query?: {
              enabled?: boolean;
              queryKey?: unknown;
            };
          };
    }>,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useListReviewerAnnotations: (
    submissionId: string,
    params: { targetEntityType: string; targetEntityId: string },
    options?: {
      query?: { enabled?: boolean; queryKey?: unknown };
    },
  ) => {
    hoisted.list.calls.push({ submissionId, params, options });
    return { data: hoisted.list.data };
  },
  // Stable key shape — must match what `ReviewerAnnotationPanel`'s
  // own test mock uses so the "shared query-key contract" assertion
  // really proves the two surfaces line up.
  getListReviewerAnnotationsQueryKey: (
    submissionId: string,
    params: { targetEntityType: string; targetEntityId: string },
  ) => [`/api/submissions/${submissionId}/reviewer-annotations`, params],
}));

const { ReviewerAnnotationAffordance } = await import(
  "./ReviewerAnnotationAffordance"
);

type AffordanceProps = React.ComponentProps<
  typeof ReviewerAnnotationAffordance
>;

function renderAffordance(overrides: Partial<AffordanceProps> = {}) {
  const onOpen = overrides.onOpen ?? vi.fn();
  const props: AffordanceProps = {
    submissionId: overrides.submissionId ?? "sub-1",
    targetEntityType: overrides.targetEntityType ?? "submission",
    targetEntityId: overrides.targetEntityId ?? "sub-1",
    audience: overrides.audience ?? "internal",
    onOpen,
  };
  const utils = render(<ReviewerAnnotationAffordance {...props} />);
  return { ...utils, onOpen, props };
}

beforeEach(() => {
  hoisted.list.data = { annotations: [] };
  hoisted.list.calls = [];
});

describe("ReviewerAnnotationAffordance", () => {
  it("renders nothing when audience is 'user' (defensive applicant-side guard)", () => {
    // The route already 403s a non-reviewer caller, but the
    // affordance mirrors the gate so an applicant-side mount can't
    // even surface the trigger button. Otherwise an architect
    // briefly opening a shared component would see a flash of the
    // affordance before the route call short-circuited.
    const { container } = renderAffordance({ audience: "user" });
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByTestId("reviewer-annotation-affordance-submission-sub-1"),
    ).toBeNull();
  });

  it("renders nothing when audience is 'ai' (defensive non-reviewer guard)", () => {
    // Same gate as above, with the second non-reviewer audience —
    // pin both branches so a future tweak to the audience union
    // (e.g. adding a new value that defaults to "show") can't
    // sneak the trigger past either non-reviewer caller.
    const { container } = renderAffordance({ audience: "ai" });
    expect(container.firstChild).toBeNull();
  });

  it("does not enable the list query when audience is non-internal (lazy-fetch gate)", () => {
    // Even though the affordance returns null for non-reviewers,
    // React still calls the hook on the first render (hooks can't
    // be conditionally called). The `enabled` flag is the real
    // gate keeping the 403'd list call from going out — pin it
    // here so a refactor that drops the `isReviewer && …` guard
    // can't ship without the test catching the extra round-trip.
    renderAffordance({ audience: "user" });
    expect(hoisted.list.calls).toHaveLength(1);
    expect(hoisted.list.calls[0]?.options?.query?.enabled).toBe(false);
  });

  it("does not enable the list query when submissionId is empty (lazy-fetch gate)", () => {
    // The affordance refuses to fetch without a submission scope.
    // Reviewer annotations are always submission-scoped per Spec
    // 307, so an empty submissionId should keep the hook idle
    // rather than firing a `/api/submissions//reviewer-annotations`
    // call.
    renderAffordance({ submissionId: "" });
    expect(hoisted.list.calls.at(-1)?.options?.query?.enabled).toBe(false);
  });

  it("does not enable the list query when targetEntityId is empty (lazy-fetch gate)", () => {
    // Mirror gate for the target tuple: an empty `targetEntityId`
    // would scope the list to a "no row" target, which the route
    // would reject. The hook stays idle until a real target id
    // arrives.
    renderAffordance({ targetEntityId: "" });
    expect(hoisted.list.calls.at(-1)?.options?.query?.enabled).toBe(false);
  });

  it("enables the list query only when reviewer + submissionId + targetEntityId are all truthy", () => {
    // The positive case for the same gate. All three inputs are
    // non-empty and the audience is internal, so the affordance
    // must arm the hook — otherwise the badge count would never
    // populate and the panel-side cache pre-fill (which keys off
    // the affordance's already-fetched list) would never land.
    renderAffordance({
      audience: "internal",
      submissionId: "sub-99",
      targetEntityType: "briefing-divergence",
      targetEntityId: "div-7",
    });
    const last = hoisted.list.calls.at(-1);
    expect(last?.submissionId).toBe("sub-99");
    expect(last?.params).toEqual({
      targetEntityType: "briefing-divergence",
      targetEntityId: "div-7",
    });
    expect(last?.options?.query?.enabled).toBe(true);
  });

  it("passes the same queryKey shape the ReviewerAnnotationPanel uses (shared cache contract)", () => {
    // The whole point of the shared key is that opening the panel
    // populates instantly from the affordance's already-cached
    // list, and a panel-side mutation invalidates this badge in
    // lockstep. The key shape lives in
    // `getListReviewerAnnotationsQueryKey` (mocked above to mirror
    // what `ReviewerAnnotationPanel.test.tsx` mocks). Pin the full
    // shape here so a refactor that hand-rolls the key on either
    // side can't drift the two out of sync.
    renderAffordance({
      submissionId: "sub-42",
      targetEntityType: "sheet",
      targetEntityId: "sheet-A",
    });
    const last = hoisted.list.calls.at(-1);
    expect(last?.options?.query?.queryKey).toEqual([
      "/api/submissions/sub-42/reviewer-annotations",
      { targetEntityType: "sheet", targetEntityId: "sheet-A" },
    ]);
  });

  it("renders the '+' glyph (no numeric badge) when the annotation list is empty", () => {
    // Zero count is the most common first-mount state — the
    // affordance opens lazily, so a target row that's never had a
    // scratch note must show the "add" affordance (the `+` glyph)
    // instead of a misleading "0" pill. The numeric badge testid
    // (`-count`) must NOT be in the tree on the empty branch,
    // otherwise consumers asserting against it would mis-bucket
    // empty rows as having a count of "".
    hoisted.list.data = { annotations: [] };
    renderAffordance({
      submissionId: "sub-1",
      targetEntityType: "submission",
      targetEntityId: "sub-1",
    });

    const button = screen.getByTestId(
      "reviewer-annotation-affordance-submission-sub-1",
    );
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("+");
    expect(
      screen.queryByTestId(
        "reviewer-annotation-affordance-submission-sub-1-count",
      ),
    ).toBeNull();
    // Empty-branch copy: singular phrasing is reserved for the
    // n=1 case, so the empty title/aria-label must not pluralize.
    expect(button).toHaveAttribute("title", "Add reviewer annotation");
    expect(button).toHaveAttribute("aria-label", "Open reviewer annotations");
  });

  it("renders the singular numeric badge + 'annotation' copy when count is exactly 1", () => {
    // n=1 is the boundary between the empty `+` branch and the
    // pluralized `n>1` branch — pin the singular `annotation`
    // (no trailing `s`) on both the title and the aria-label so a
    // future copy tweak that hard-codes the plural can't ship.
    hoisted.list.data = { annotations: [{ id: "ann-1" }] };
    renderAffordance({
      submissionId: "sub-1",
      targetEntityType: "submission",
      targetEntityId: "sub-1",
    });

    const button = screen.getByTestId(
      "reviewer-annotation-affordance-submission-sub-1",
    );
    const count = screen.getByTestId(
      "reviewer-annotation-affordance-submission-sub-1-count",
    );
    expect(count).toHaveTextContent("1");
    // The `+` glyph must NOT render on the n>0 branch — the two
    // states are mutually exclusive.
    expect(button).not.toHaveTextContent("+");
    expect(button).toHaveAttribute("title", "1 reviewer annotation");
    expect(button).toHaveAttribute("aria-label", "Open 1 reviewer annotation");
  });

  it("renders the plural numeric badge + 'annotations' copy when count is >1", () => {
    // n>1 must pluralize on both the title and the aria-label.
    // Three annotations is enough to prove the count is the
    // length of `data.annotations`, not a hard-coded "many".
    hoisted.list.data = {
      annotations: [{ id: "a" }, { id: "b" }, { id: "c" }],
    };
    renderAffordance({
      submissionId: "sub-1",
      targetEntityType: "materializable-element",
      targetEntityId: "elt-9",
    });

    const testId =
      "reviewer-annotation-affordance-materializable-element-elt-9";
    const button = screen.getByTestId(testId);
    expect(screen.getByTestId(`${testId}-count`)).toHaveTextContent("3");
    expect(button).toHaveAttribute("title", "3 reviewer annotations");
    expect(button).toHaveAttribute(
      "aria-label",
      "Open 3 reviewer annotations",
    );
  });

  it("namespaces the testid by target tuple so multiple affordances on the same page stay uniquely selectable", () => {
    // A reviewer scrolling a list of materializable elements would
    // see one affordance per row. The testid is keyed off the
    // full `${targetEntityType}-${targetEntityId}` tuple — pin the
    // contract so a future refactor that drops the type segment
    // (and starts colliding when two different target types share
    // an id) gets caught here.
    hoisted.list.data = { annotations: [] };
    render(
      <>
        <ReviewerAnnotationAffordance
          submissionId="sub-1"
          targetEntityType="briefing-source"
          targetEntityId="row-1"
          audience="internal"
          onOpen={() => {}}
        />
        <ReviewerAnnotationAffordance
          submissionId="sub-1"
          targetEntityType="materializable-element"
          targetEntityId="row-1"
          audience="internal"
          onOpen={() => {}}
        />
      </>,
    );
    expect(
      screen.getByTestId(
        "reviewer-annotation-affordance-briefing-source-row-1",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(
        "reviewer-annotation-affordance-materializable-element-row-1",
      ),
    ).toBeInTheDocument();
  });

  it("forwards the full target tuple back to `onOpen` when clicked", () => {
    // The parent owns a single shared panel keyed by the
    // most-recent target — the affordance must hand back the
    // exact tuple it was mounted with so the parent can swap the
    // panel's target without re-deriving anything from the testid.
    const onOpen = vi.fn();
    hoisted.list.data = { annotations: [{ id: "ann-1" }] };
    renderAffordance({
      submissionId: "sub-77",
      targetEntityType: "parcel-briefing",
      targetEntityId: "parcel-A",
      onOpen,
    });

    fireEvent.click(
      screen.getByTestId(
        "reviewer-annotation-affordance-parcel-briefing-parcel-A",
      ),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({
      submissionId: "sub-77",
      targetEntityType: "parcel-briefing",
      targetEntityId: "parcel-A",
    });
  });
});
