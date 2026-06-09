import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMutationCapture,
  makeCapturingMutationHook,
} from "@workspace/portal-ui/test-utils";

const hoisted = vi.hoisted(() => ({
  attachedDocuments: [] as Array<{
    entityId: string;
    title: string;
    documentType: string;
  }>,
  snapshotSheets: [] as Array<{
    id: string;
    sheetNumber: string;
    sheetName: string;
  }>,
  findingsStatus: null as null | { state: string },
  engagementStore: {
    uploadAttachedDocument: vi.fn().mockResolvedValue(undefined),
    uploadingDocumentByEngagement: {} as Record<string, boolean>,
    documentUploadErrorByEngagement: {} as Record<string, string | null>,
  },
}));

const createSubmission = createMutationCapture<
  unknown,
  { id: string; data: unknown }
>();
const generateFindings = createMutationCapture<
  unknown,
  { submissionId: string; data: unknown }
>();

vi.mock("../../../store/engagements", () => ({
  useEngagementsStore: (
    selector: (s: typeof hoisted.engagementStore) => unknown,
  ) => selector(hoisted.engagementStore),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const { useQuery } = await import("@tanstack/react-query");
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useCreateEngagementSubmission: makeCapturingMutationHook(createSubmission),
    useGenerateSubmissionFindings: makeCapturingMutationHook(generateFindings),
    useGetSubmissionFindingsGenerationStatus: (
      submissionId: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          ([`/api/submissions/${submissionId}/findings/status`] as const),
        queryFn: async () => hoisted.findingsStatus,
        enabled: opts?.query?.enabled ?? !!submissionId,
        retry: false,
      }),
    getGetSubmissionFindingsGenerationStatusQueryKey: (submissionId: string) =>
      [`/api/submissions/${submissionId}/findings/status`] as const,
    useListAttachedDocuments: (
      _engagementId: string,
      _params?: unknown,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listAttachedDocuments", _engagementId] as const),
        queryFn: async () => ({
          attachedDocuments: hoisted.attachedDocuments,
        }),
        enabled: opts?.query?.enabled ?? true,
        retry: false,
      }),
    getListAttachedDocumentsQueryKey: (engagementId: string) =>
      ["listAttachedDocuments", engagementId] as const,
    useGetSnapshotSheets: (
      snapshotId: string,
      opts?: {
        query?: { enabled?: boolean; queryKey?: readonly unknown[] };
      },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["getSnapshotSheets", snapshotId] as const),
        queryFn: async () => hoisted.snapshotSheets,
        enabled: opts?.query?.enabled ?? !!snapshotId,
        retry: false,
      }),
    getGetSnapshotSheetsQueryKey: (snapshotId: string) =>
      ["getSnapshotSheets", snapshotId] as const,
    getListEngagementSubmissionsQueryKey: (engagementId: string) =>
      ["listEngagementSubmissions", engagementId] as const,
    getListSubmissionFindingsQueryKey: (submissionId: string) =>
      ["listSubmissionFindings", submissionId] as const,
  };
});

const { RunPlanReviewTab } = await import("../RunPlanReviewTab");

function renderTab(
  props?: Partial<Parameters<typeof RunPlanReviewTab>[0]>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const engagementId = props?.engagementId ?? "eng-1";
  const snapshotId = props?.latestSnapshotId ?? null;
  client.setQueryData(
    ["listAttachedDocuments", engagementId],
    { attachedDocuments: hoisted.attachedDocuments.map((d) => ({ ...d })) },
  );
  if (snapshotId) {
    client.setQueryData(
      ["getSnapshotSheets", snapshotId],
      hoisted.snapshotSheets.map((s) => ({ ...s })),
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <RunPlanReviewTab
        engagementId="eng-1"
        engagementJurisdiction="Boulder, CO"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hoisted.attachedDocuments = [];
  hoisted.snapshotSheets = [];
  hoisted.findingsStatus = null;
  createSubmission.reset();
  generateFindings.reset();
});

afterEach(() => {
  cleanup();
});

describe("RunPlanReviewTab", () => {
  it("renders plan pick list for attached PDFs and snapshot sheets", () => {
    hoisted.attachedDocuments = [
      {
        entityId: "doc-plan-1",
        title: "404 Remodel permit set.pdf",
        documentType: "specification",
      },
    ];
    hoisted.snapshotSheets = [
      { id: "sheet-a1", sheetNumber: "A1.0", sheetName: "Floor Plan" },
    ];
    renderTab({ latestSnapshotId: "snap-1" });
    expect(screen.getByTestId("run-plan-review-tab")).toBeInTheDocument();
    expect(screen.getByTestId("run-plan-review-plan-doc-plan-1")).toBeInTheDocument();
    expect(screen.getByTestId("run-plan-review-plan-sheet-a1")).toBeInTheDocument();
  });

  it("shows web-grounding note when coverage is not warmed", () => {
    hoisted.attachedDocuments = [
      {
        entityId: "doc-miami",
        title: "Miami Beach plan.pdf",
        documentType: "specification",
      },
    ];
    renderTab({
      engagementJurisdiction: "Miami Beach, FL",
      engagementCoverageStatus: "warming",
    });
    expect(
      screen.getByTestId("run-plan-review-web-grounding-note"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("run-plan-review-start")).not.toBeDisabled();
  });

  it("creates submission and generates findings with selected planSetPieceIds", async () => {
    hoisted.attachedDocuments = [
      {
        entityId: "doc-plan-1",
        title: "404 Remodel permit set.pdf",
        documentType: "specification",
      },
    ];
    renderTab();
    fireEvent.click(screen.getByTestId("run-plan-review-start"));
    expect(createSubmission.mutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      createSubmission.capturedOptions!.mutation!.onSuccess!(
        { submissionId: "sub-new", submittedAt: "2026-06-08T00:00:00Z" },
        {
          id: "eng-1",
          data: {
            note: "Pre-submittal self-review (architect-initiated)",
            discipline: "building",
          },
        },
        undefined,
      );
    });
    expect(generateFindings.mutate).toHaveBeenCalledTimes(1);
    expect(generateFindings.mutate.mock.calls[0][0]).toEqual({
      submissionId: "sub-new",
      data: { planSetPieceIds: ["doc-plan-1"] },
    });
  });
});
