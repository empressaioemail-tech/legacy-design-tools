/**
 * BriefingSourceHistoryPanel (lib/portal-ui) — Task #316.
 *
 * Pins the lifted shared per-layer history disclosure. Coverage:
 *
 *   - the empty + populated branches render the matching testids so
 *     both architect and reviewer surfaces can be styled around them;
 *   - the `readOnly` flag suppresses the "Restore this version"
 *     mutate affordance on every prior-version card, while keeping
 *     the prior versions themselves visible (reviewers audit the
 *     same divergence pills + prior-version comparison disclosure
 *     that the architect sees).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EngagementBriefingSource } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  historySources: [] as unknown[],
  isLoading: false,
  isError: false,
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useListEngagementBriefingSources: () => ({
      data: { sources: hoisted.historySources },
      isLoading: hoisted.isLoading,
      isError: hoisted.isError,
    }),
    useRestoreEngagementBriefingSource: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      variables: undefined,
    }),
    getGetEngagementBriefingQueryKey: (id: string) => [
      "getEngagementBriefing",
      id,
    ],
    getListEngagementBriefingSourcesQueryKey: (
      id: string,
      params: unknown,
    ) => ["listEngagementBriefingSources", id, params],
  };
});

const { BriefingSourceHistoryPanel } = await import(
  "../BriefingSourceHistoryPanel"
);

function mkSource(
  over: Partial<EngagementBriefingSource> &
    Pick<EngagementBriefingSource, "id" | "sourceKind">,
): EngagementBriefingSource {
  return {
    id: over.id,
    layerKind: over.layerKind ?? "fema-flood",
    sourceKind: over.sourceKind,
    provider: over.provider ?? null,
    snapshotDate: over.snapshotDate ?? "2026-01-01T00:00:00.000Z",
    note: over.note ?? null,
    uploadObjectPath: over.uploadObjectPath ?? "",
    uploadOriginalFilename: over.uploadOriginalFilename ?? "",
    uploadContentType: over.uploadContentType ?? "",
    uploadByteSize: over.uploadByteSize ?? 0,
    dxfObjectPath: over.dxfObjectPath ?? null,
    glbObjectPath: over.glbObjectPath ?? null,
    conversionStatus: over.conversionStatus ?? null,
    conversionError: over.conversionError ?? null,
    payload: over.payload ?? {},
    createdAt: over.createdAt ?? "2026-01-02T00:00:00.000Z",
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  } as EngagementBriefingSource;
}

function renderPanel(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
  hoisted.historySources = [];
  hoisted.isLoading = false;
  hoisted.isError = false;
});

afterEach(() => {
  cleanup();
});

describe("BriefingSourceHistoryPanel (portal-ui)", () => {
  it("renders the empty-history copy when only the current source exists", () => {
    hoisted.historySources = [
      mkSource({ id: "src-current", sourceKind: "federal-adapter" }),
    ];
    renderPanel(
      <BriefingSourceHistoryPanel
        engagementId="eng-1"
        layerKind="fema-flood"
        currentSourceId="src-current"
        panelId="briefing-source-history-src-current"
      />,
    );
    expect(
      screen.getByText(/No prior versions of this layer/i),
    ).toBeInTheDocument();
  });

  it("renders prior versions, filtering the current source out client-side", () => {
    hoisted.historySources = [
      mkSource({
        id: "src-current",
        sourceKind: "federal-adapter",
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      mkSource({
        id: "src-prior-1",
        sourceKind: "federal-adapter",
        createdAt: "2026-01-15T00:00:00.000Z",
        supersededAt: "2026-02-01T00:00:00.000Z",
        supersededById: "src-current",
      }),
    ];
    renderPanel(
      <BriefingSourceHistoryPanel
        engagementId="eng-1"
        layerKind="fema-flood"
        currentSourceId="src-current"
        panelId="briefing-source-history-src-current"
      />,
    );
    expect(
      screen.getByTestId("briefing-source-history-row-src-prior-1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("briefing-source-history-row-src-current"),
    ).not.toBeInTheDocument();
  });

  describe("readOnly mode", () => {
    it("hides the 'Restore this version' affordance on each prior-version card", () => {
      hoisted.historySources = [
        mkSource({
          id: "src-current",
          sourceKind: "federal-adapter",
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
        mkSource({
          id: "src-prior-1",
          sourceKind: "federal-adapter",
          createdAt: "2026-01-15T00:00:00.000Z",
          supersededAt: "2026-02-01T00:00:00.000Z",
          supersededById: "src-current",
        }),
      ];
      renderPanel(
        <BriefingSourceHistoryPanel
          engagementId="eng-1"
          layerKind="fema-flood"
          currentSourceId="src-current"
          panelId="briefing-source-history-src-current"
          readOnly
        />,
      );
      // The prior card itself still mounts so reviewers see the
      // version + divergence chrome.
      expect(
        screen.getByTestId("briefing-source-history-row-src-prior-1"),
      ).toBeInTheDocument();
      // …but the mutate button is suppressed.
      expect(
        screen.queryByTestId("briefing-source-restore-src-prior-1"),
      ).not.toBeInTheDocument();
    });

    it("still renders the 'Restore this version' affordance when readOnly is omitted (architect default)", () => {
      hoisted.historySources = [
        mkSource({
          id: "src-current",
          sourceKind: "federal-adapter",
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
        mkSource({
          id: "src-prior-1",
          sourceKind: "federal-adapter",
          createdAt: "2026-01-15T00:00:00.000Z",
          supersededAt: "2026-02-01T00:00:00.000Z",
          supersededById: "src-current",
        }),
      ];
      renderPanel(
        <BriefingSourceHistoryPanel
          engagementId="eng-1"
          layerKind="fema-flood"
          currentSourceId="src-current"
          panelId="briefing-source-history-src-current"
        />,
      );
      expect(
        screen.getByTestId("briefing-source-restore-src-prior-1"),
      ).toBeInTheDocument();
    });
  });
});
