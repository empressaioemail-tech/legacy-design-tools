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
  engagements: [] as Array<{
    id: string;
    name: string;
    jurisdiction?: string | null;
  }>,
  submissions: [] as Array<{
    id: string;
    submittedAt: string;
    status: string;
    jurisdiction?: string | null;
  }>,
  jurisdictions: [] as Array<{
    key: string;
    displayName: string;
    atomCount: number;
  }>,
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
  useListCodeJurisdictions: () => ({
    data: hookState.jurisdictions,
    isLoading: false,
  }),
  useListSubmissionFindings: () => ({
    data: { findings: hookState.findings },
    isLoading: false,
  }),
  generateSubmissionFindings: vi.fn(async () => ({
    generationId: "gen-1",
    state: "pending",
  })),
  acceptFinding: vi.fn(async () => ({ finding: makeFinding() })),
  rejectFinding: vi.fn(async () => ({ finding: makeFinding() })),
  overrideFinding: vi.fn(async () => ({ finding: makeFinding() })),
  ApiError: class ApiError extends Error {},
  getListEngagementSubmissionsQueryKey: (id: string) => [
    `/api/engagements/${id}/submissions`,
  ],
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
  hookState.jurisdictions = [];
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
    // CDX-4 — ReviewPage wires the adjudication handlers, so every card
    // renders its accept / edit / reject action row.
    expect(screen.getAllByTestId("finding-accept")).toHaveLength(2);
    expect(
      screen.getByText("Setback shortfall on the front yard."),
    ).toBeTruthy();
  });
});

describe("ReviewPage — jurisdiction switcher (CDX-5)", () => {
  it("shows no jurisdiction bar until an engagement is picked", () => {
    hookState.engagements = [{ id: "e1", name: "Musgrave Residence" }];
    renderPage();
    expect(screen.queryByTestId("jurisdiction-bar")).toBeNull();
  });

  it("surfaces the engagement's jurisdiction and its indexed corpus", () => {
    hookState.engagements = [
      { id: "e1", name: "Musgrave Residence", jurisdiction: "Grand County" },
    ];
    hookState.jurisdictions = [
      { key: "grand-county", displayName: "Grand County", atomCount: 1240 },
    ];
    renderPage();

    fireEvent.change(screen.getByTestId("engagement-select"), {
      target: { value: "e1" },
    });

    expect(screen.getByTestId("jurisdiction-name").textContent).toBe(
      "Grand County",
    );
    expect(screen.getByTestId("jurisdiction-corpus").textContent).toContain(
      "indexed code atoms",
    );
  });

  it("updates the jurisdiction when the engagement switches", () => {
    hookState.engagements = [
      { id: "e1", name: "Musgrave Residence", jurisdiction: "Grand County" },
      { id: "e2", name: "Bastrop Infill", jurisdiction: "Bastrop UDC" },
    ];
    renderPage();

    fireEvent.change(screen.getByTestId("engagement-select"), {
      target: { value: "e1" },
    });
    expect(screen.getByTestId("jurisdiction-name").textContent).toBe(
      "Grand County",
    );

    fireEvent.change(screen.getByTestId("engagement-select"), {
      target: { value: "e2" },
    });
    expect(screen.getByTestId("jurisdiction-name").textContent).toBe(
      "Bastrop UDC",
    );
  });

  it("warns when a submission was filed under a stale jurisdiction", () => {
    hookState.engagements = [
      { id: "e1", name: "Bastrop Infill", jurisdiction: "Bastrop UDC" },
    ];
    hookState.submissions = [
      {
        id: "sub-1",
        submittedAt: "2026-05-20T00:00:00.000Z",
        status: "pending",
        jurisdiction: "Grand County",
      },
    ];
    renderPage();

    fireEvent.change(screen.getByTestId("engagement-select"), {
      target: { value: "e1" },
    });
    fireEvent.change(screen.getByTestId("submission-select"), {
      target: { value: "sub-1" },
    });

    expect(
      screen.getByTestId("jurisdiction-snapshot-warning").textContent,
    ).toContain("Grand County");
  });
});
