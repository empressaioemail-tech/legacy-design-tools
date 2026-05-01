/**
 * BriefingSourceRow (lib/portal-ui) — Task #316.
 *
 * Pins the lifted shared component the architect (design-tools) and
 * reviewer (plan-review) surfaces both render. Coverage focuses on
 * what's unique about the lib/portal-ui copy:
 *
 *   - the `readOnly` flag suppresses every architect-only mutate
 *     affordance the row exposes (Retry conversion, Refresh this
 *     layer);
 *   - the same row, without `readOnly`, still renders those
 *     affordances and forwards their callbacks (so design-tools
 *     keeps working off this shared component);
 *   - the producer-agnostic chrome (source-kind badge, "Last
 *     refreshed by Generate Layers" attribution) renders the same
 *     in both modes — reviewers see the same provenance.
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
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EngagementBriefingSource } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  retryMutate: vi.fn(),
  retryIsPending: false,
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useRetryBriefingSourceConversion: () => ({
      mutate: hoisted.retryMutate,
      isPending: hoisted.retryIsPending,
    }),
    useListEngagementBriefingSources: () => ({
      data: { sources: [] },
      isLoading: false,
      isError: false,
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

const { BriefingSourceRow } = await import("../BriefingSourceRow");
const { BRIEFING_GENERATE_LAYERS_ACTOR_LABEL } = await import(
  "../../lib/briefingSourceHelpers"
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
    createdAt: over.createdAt ?? new Date().toISOString(),
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  } as EngagementBriefingSource;
}

function renderRow(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
  hoisted.retryMutate.mockReset();
  hoisted.retryIsPending = false;
});

afterEach(() => {
  cleanup();
});

describe("BriefingSourceRow (portal-ui)", () => {
  it("renders the source-kind badge and 'Last refreshed by Generate Layers' attribution for adapter rows", () => {
    const source = mkSource({
      id: "src-fed-1",
      sourceKind: "federal-adapter",
      provider: "fema:fema-flood (FEMA NFHL)",
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });
    renderRow(<BriefingSourceRow engagementId="eng-1" source={source} />);
    expect(
      screen.getByTestId(`briefing-source-kind-badge-${source.id}`).textContent,
    ).toBe("Federal adapter");
    const stamp = screen.getByTestId(
      `briefing-source-last-refreshed-${source.id}`,
    );
    expect(stamp.textContent).toMatch(/Last refreshed/);
    expect(stamp.textContent).toContain(BRIEFING_GENERATE_LAYERS_ACTOR_LABEL);
  });

  it("does NOT render the Generate Layers attribution line for manual-upload rows", () => {
    const manual = mkSource({
      id: "src-manual-1",
      sourceKind: "manual-upload",
      uploadOriginalFilename: "boulder-parcels.dxf",
      uploadByteSize: 12_345,
    });
    renderRow(<BriefingSourceRow engagementId="eng-1" source={manual} />);
    expect(
      screen.queryByTestId(`briefing-source-last-refreshed-${manual.id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`briefing-source-kind-badge-${manual.id}`).textContent,
    ).toBe("Manual upload");
  });

  it("renders the per-row 'Refresh this layer' affordance and forwards the parsed adapterKey on click", () => {
    const source = mkSource({
      id: "src-fed-fema",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "fema:nfhl-flood-zone (FEMA NFHL)",
    });
    const onRefreshLayer = vi.fn();
    renderRow(
      <BriefingSourceRow
        engagementId="eng-1"
        source={source}
        onRefreshLayer={onRefreshLayer}
      />,
    );
    const btn = screen.getByTestId(
      `briefing-source-refresh-layer-${source.id}`,
    );
    expect(btn.textContent).toBe("Refresh this layer");
    fireEvent.click(btn);
    expect(onRefreshLayer).toHaveBeenCalledWith("fema:nfhl-flood-zone");
  });

  it("renders the Retry button on a failed conversion and fires the retry mutation when clicked", () => {
    const source = mkSource({
      id: "src-conv-fail",
      sourceKind: "manual-upload",
      conversionStatus: "failed",
      conversionError: "DXF unsupported",
    });
    renderRow(<BriefingSourceRow engagementId="eng-1" source={source} />);
    const btn = screen.getByTestId(
      `briefing-source-retry-conversion-${source.id}`,
    );
    fireEvent.click(btn);
    expect(hoisted.retryMutate).toHaveBeenCalledWith({
      id: "eng-1",
      sourceId: "src-conv-fail",
    });
  });

  describe("readOnly mode", () => {
    it("hides the Retry conversion button on a failed conversion", () => {
      const source = mkSource({
        id: "src-conv-fail-ro",
        sourceKind: "manual-upload",
        conversionStatus: "failed",
        conversionError: "DXF unsupported",
      });
      renderRow(
        <BriefingSourceRow engagementId="eng-1" source={source} readOnly />,
      );
      // The error chrome still renders so the reviewer can see the
      // conversion failed — only the mutate button is suppressed.
      expect(
        screen.getByTestId(`briefing-source-conversion-failed-${source.id}`),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(
          `briefing-source-retry-conversion-${source.id}`,
        ),
      ).not.toBeInTheDocument();
    });

    it("hides the 'Refresh this layer' affordance even when onRefreshLayer is supplied", () => {
      const source = mkSource({
        id: "src-fed-ro",
        layerKind: "fema-nfhl-flood-zone",
        sourceKind: "federal-adapter",
        provider: "fema:nfhl-flood-zone (FEMA NFHL)",
      });
      const onRefreshLayer = vi.fn();
      renderRow(
        <BriefingSourceRow
          engagementId="eng-1"
          source={source}
          onRefreshLayer={onRefreshLayer}
          readOnly
        />,
      );
      expect(
        screen.queryByTestId(`briefing-source-refresh-layer-${source.id}`),
      ).not.toBeInTheDocument();
    });

    it("still renders the source-kind badge and provenance chrome reviewers depend on", () => {
      const source = mkSource({
        id: "src-fed-ro-2",
        sourceKind: "federal-adapter",
        provider: "fema:fema-flood (FEMA NFHL)",
        createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      renderRow(
        <BriefingSourceRow engagementId="eng-1" source={source} readOnly />,
      );
      expect(
        screen.getByTestId(`briefing-source-kind-badge-${source.id}`)
          .textContent,
      ).toBe("Federal adapter");
      expect(
        screen.getByTestId(`briefing-source-last-refreshed-${source.id}`),
      ).toBeInTheDocument();
    });
  });
});
