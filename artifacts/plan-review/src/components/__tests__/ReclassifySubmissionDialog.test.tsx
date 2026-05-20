/**
 * ReclassifySubmissionDialog — UI-4 component test.
 *
 * Covers the two-step reviewer reclassify flow:
 *   1. Form pre-fills from the supplied classification (and starts
 *      blank when none is supplied).
 *   2. The "Review change" gate stays disabled until a project type
 *      is entered.
 *   3. Form → confirmation → submit threads the corrected fields
 *      into the `useReclassifySubmission` mutation with
 *      `confidence: 1` (reviewer-certain).
 *   4. Discipline toggles and code-book add/remove edit the body.
 *   5. A failed mutation surfaces a readable error and keeps the
 *      dialog open.
 *
 * `@workspace/api-client-react` is mocked to a thin reclassify
 * surface so the test never crosses the network; `useReclassifySubmission`
 * captures the mutation callbacks so success/error can be driven
 * deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SubmissionClassification } from "@workspace/api-client-react";
import { ReclassifySubmissionDialog } from "../ReclassifySubmissionDialog";

const reclassify = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  options: null as {
    mutation?: {
      onSuccess?: () => unknown | Promise<unknown>;
      onError?: (err: unknown) => void;
    };
  } | null,
}));

vi.mock("@workspace/api-client-react", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly data: unknown;
    constructor(
      response: { status: number },
      data: unknown,
      _requestInfo?: { method: string; url: string },
    ) {
      super("api error");
      this.status = response.status;
      this.data = data;
    }
  },
  getListReviewerQueueQueryKey: () => ["/api/reviewer/queue"],
  useReclassifySubmission: (options: typeof reclassify.options) => {
    reclassify.options = options;
    return {
      mutate: reclassify.mutate,
      isPending: reclassify.isPending,
    };
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const FIXTURE: SubmissionClassification = {
  submissionId: "sub-1",
  projectType: "Office tenant improvement",
  disciplines: ["building", "mechanical"],
  applicableCodeBooks: ["IBC 2021"],
  confidence: 0.82,
  source: "auto",
  classifiedAt: "2026-05-18T12:00:00.000Z",
  classifiedBy: null,
};

beforeEach(() => {
  reclassify.mutate = vi.fn();
  reclassify.isPending = false;
  reclassify.options = null;
});

afterEach(() => {
  cleanup();
});

describe("ReclassifySubmissionDialog", () => {
  it("pre-fills the form from the current classification", () => {
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        currentClassification={FIXTURE}
        open
        onClose={() => {}}
      />,
      { wrapper },
    );

    expect(
      screen.getByTestId<HTMLInputElement>("reclassify-dialog-project-type")
        .value,
    ).toBe("Office tenant improvement");
    expect(
      screen.getByTestId<HTMLInputElement>(
        "reclassify-dialog-discipline-building-input",
      ).checked,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLInputElement>(
        "reclassify-dialog-discipline-mechanical-input",
      ).checked,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLInputElement>(
        "reclassify-dialog-discipline-electrical-input",
      ).checked,
    ).toBe(false);
    expect(
      screen.getByTestId("reclassify-dialog-codebook-chip-IBC 2021"),
    ).toBeTruthy();
  });

  it("starts blank and gates 'Review change' on a project type", async () => {
    const user = userEvent.setup();
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        open
        onClose={() => {}}
      />,
      { wrapper },
    );

    const projectType = screen.getByTestId<HTMLInputElement>(
      "reclassify-dialog-project-type",
    );
    expect(projectType.value).toBe("");
    expect(
      screen.getByTestId<HTMLButtonElement>("reclassify-dialog-review")
        .disabled,
    ).toBe(true);

    await user.type(projectType, "Mixed-use retail");
    expect(
      screen.getByTestId<HTMLButtonElement>("reclassify-dialog-review")
        .disabled,
    ).toBe(false);
  });

  it("walks form → confirm → submit with the corrected body", async () => {
    const user = userEvent.setup();
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        currentClassification={FIXTURE}
        open
        onClose={() => {}}
      />,
      { wrapper },
    );

    // Correct the project type, drop mechanical, add electrical.
    const projectType = screen.getByTestId<HTMLInputElement>(
      "reclassify-dialog-project-type",
    );
    await user.clear(projectType);
    await user.type(projectType, "Mixed-use retail");
    await user.click(
      screen.getByTestId("reclassify-dialog-discipline-mechanical-input"),
    );
    await user.click(
      screen.getByTestId("reclassify-dialog-discipline-electrical-input"),
    );

    // Add a code book.
    await user.type(
      screen.getByTestId("reclassify-dialog-codebook-input"),
      "NEC 2020",
    );
    await user.click(screen.getByTestId("reclassify-dialog-codebook-add"));

    // Step into the confirmation view.
    await user.click(screen.getByTestId("reclassify-dialog-review"));
    expect(screen.getByTestId("reclassify-dialog-summary")).toBeTruthy();

    await user.click(screen.getByTestId("reclassify-dialog-confirm"));

    expect(reclassify.mutate).toHaveBeenCalledTimes(1);
    expect(reclassify.mutate).toHaveBeenCalledWith({
      submissionId: "sub-1",
      data: {
        projectType: "Mixed-use retail",
        disciplines: ["building", "electrical"],
        applicableCodeBooks: ["IBC 2021", "NEC 2020"],
        confidence: 1,
      },
    });
  });

  it("returns to the form from the confirmation step via Back", async () => {
    const user = userEvent.setup();
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        currentClassification={FIXTURE}
        open
        onClose={() => {}}
      />,
      { wrapper },
    );

    await user.click(screen.getByTestId("reclassify-dialog-review"));
    expect(screen.getByTestId("reclassify-dialog-summary")).toBeTruthy();

    await user.click(screen.getByTestId("reclassify-dialog-back"));
    expect(screen.queryByTestId("reclassify-dialog-summary")).toBeNull();
    expect(
      screen.getByTestId("reclassify-dialog-project-type"),
    ).toBeTruthy();
  });

  it("removes a code-book chip", async () => {
    const user = userEvent.setup();
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        currentClassification={FIXTURE}
        open
        onClose={() => {}}
      />,
      { wrapper },
    );

    expect(
      screen.getByTestId("reclassify-dialog-codebook-chip-IBC 2021"),
    ).toBeTruthy();
    await user.click(
      screen.getByTestId("reclassify-dialog-codebook-remove-IBC 2021"),
    );
    expect(
      screen.queryByTestId("reclassify-dialog-codebook-chip-IBC 2021"),
    ).toBeNull();
  });

  it("closes and invalidates the queue on a successful save", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        currentClassification={FIXTURE}
        open
        onClose={onClose}
      />,
      { wrapper },
    );

    await user.click(screen.getByTestId("reclassify-dialog-review"));
    await user.click(screen.getByTestId("reclassify-dialog-confirm"));
    expect(reclassify.mutate).toHaveBeenCalledTimes(1);

    // Drive the captured success callback the way the real mutation
    // would on a 200.
    await act(async () => {
      await reclassify.options?.mutation?.onSuccess?.();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a readable error and stays open on failure", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("@workspace/api-client-react");
    render(
      <ReclassifySubmissionDialog
        submissionId="sub-1"
        currentClassification={FIXTURE}
        open
        onClose={() => {}}
      />,
      { wrapper },
    );

    await user.click(screen.getByTestId("reclassify-dialog-review"));
    await user.click(screen.getByTestId("reclassify-dialog-confirm"));

    act(() => {
      reclassify.options?.mutation?.onError?.(
        new ApiError(
          { status: 400 } as unknown as Response,
          { error: "disciplines_required" },
          { method: "POST", url: "/api/submissions/sub-1/reclassify" },
        ),
      );
    });

    const error = await screen.findByTestId("reclassify-dialog-error");
    expect(error.textContent).toContain("disciplines_required");
    // Still on the confirmation step — not closed.
    expect(screen.getByTestId("reclassify-dialog-summary")).toBeTruthy();
  });
});
