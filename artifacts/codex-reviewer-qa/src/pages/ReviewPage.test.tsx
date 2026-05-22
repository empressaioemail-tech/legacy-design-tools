import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeFinding } from "../__fixtures__/findings";

/**
 * ReviewPage integration test. `@workspace/api-client-react` is mocked
 * so the page can be exercised without a backend — the mocked hooks
 * read from `hookState`, which each test seeds. `useMutation` /
 * `useQueryClient` stay real (provided by a QueryClientProvider).
 */
const hookState = vi.hoisted(() => ({
  engagements: [] as Array<{ id: string; name: string }>,
  submissions: [] as Array<{ id: string; submittedAt: string; status: string }>,
  status: null as { state: string; error: string | null } | null,
  findings: [] as ReturnType<typeof makeFinding>[],
}));

vi.mock("@workspace/api-client-react", () => ({
  useListEngagements: () => ({
    data: hookState.engagements,
    isLoading: false,
  }),
  useListEngagementSubmissions: () => ({
    data: hookState.submissions,
    isLoading: false,
  }),
  useGetSubmissionFindingsGenerationStatus: () => ({ data: hookState.status }),
  useListSubmissionFindings: () => ({
    data: { findings: hookState.findings },
    isLoading: false,
  }),
  generateSubmissionFindings: vi.fn(async () => ({
    generationId: "gen-1",
    state: "pending",
  })),
  getListSubmissionFindingsQueryKey: (id: string) => [
    `/api/submissions/${id}/findings`,
  ],
  getGetSubmissionFindingsGenerationStatusQueryKey: (id: string) => [
    `/api/submissions/${id}/findings/status`,
  ],
}));

const { default: ReviewPage } = await import("./ReviewPage");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReviewPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hookState.engagements = [];
  hookState.submissions = [];
  hookState.status = null;
  hookState.findings = [];
});

describe("ReviewPage", () => {
  it("renders the review surface with an engagement selector and run button", () => {
    hookState.engagements = [{ id: "e1", name: "Musgrave Residence" }];
    renderPage();
    expect(screen.getByText("Codex Reviewer QA")).toBeTruthy();
    expect(screen.getByTestId("run-review-button")).toBeTruthy();
    expect(screen.getByText("Musgrave Residence")).toBeTruthy();
  });

  it("keeps the run button disabled until a submission is selected", () => {
    hookState.engagements = [{ id: "e1", name: "Musgrave Residence" }];
    renderPage();
    expect(
      screen.getByTestId<HTMLButtonElement>("run-review-button").disabled,
    ).toBe(true);
  });

  it("renders findings as cards once an engagement and submission are picked", () => {
    hookState.engagements = [{ id: "e1", name: "Musgrave Residence" }];
    hookState.submissions = [
      { id: "sub-1", submittedAt: "2026-05-20T00:00:00.000Z", status: "pending" },
    ];
    hookState.status = { state: "completed", error: null };
    hookState.findings = [
      makeFinding({ id: "f1", text: "Setback shortfall on the front yard." }),
      makeFinding({ id: "f2", severity: "advisory", text: "Advisory note." }),
    ];
    renderPage();

    fireEvent.change(screen.getByTestId("engagement-select"), {
      target: { value: "e1" },
    });
    fireEvent.change(screen.getByTestId("submission-select"), {
      target: { value: "sub-1" },
    });

    expect(screen.getAllByTestId("finding-card")).toHaveLength(2);
    expect(
      screen.getByText("Setback shortfall on the front yard."),
    ).toBeTruthy();
  });
});
