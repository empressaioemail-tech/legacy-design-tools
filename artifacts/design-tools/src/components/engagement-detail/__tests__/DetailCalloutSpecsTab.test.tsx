/**
 * DetailCalloutSpecsTab — Cortex L4 (Lane C.4 / C.4.4).
 *
 * Coverage isolated to the tab's component contract:
 *   - Loading / empty / populated states.
 *   - Each row offers the legal next push-state actions.
 *   - A push-state button calls the mutation with spec id + target.
 *   - The create dialog builds + submits a discriminated spec.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  listData: undefined as { detailCalloutSpecs: unknown[] } | undefined,
  listIsLoading: false,
  createMutate: vi.fn(),
  pushStateMutate: vi.fn(),
  apsRefMutate: vi.fn(),
}));

class MockApiError extends Error {
  status: number;
  constructor(status: number) {
    super(`MockApiError ${status}`);
    this.status = status;
  }
}

vi.mock("@workspace/api-client-react", () => ({
  ApiError: MockApiError,
  getListDetailCalloutSpecsQueryKey: (id: string) => [
    "listDetailCalloutSpecs",
    id,
  ],
  useListDetailCalloutSpecs: () => ({
    data: hoisted.listData,
    isLoading: hoisted.listIsLoading,
  }),
  useCreateDetailCalloutSpec: () => ({
    mutate: hoisted.createMutate,
    isPending: false,
  }),
  useUpdateDetailCalloutSpecPushState: () => ({
    mutate: hoisted.pushStateMutate,
    isPending: false,
  }),
  useAttachDetailCalloutSpecApsRef: () => ({
    mutate: hoisted.apsRefMutate,
    isPending: false,
  }),
}));

const { DetailCalloutSpecsTab } = await import("../DetailCalloutSpecsTab");

function makeSpec(overrides: Record<string, unknown> = {}) {
  return {
    entityType: "detail-callout-spec",
    entityId: "dcs-1",
    jurisdictionTenant: "default",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "",
    contentHash: "h",
    engagementId: "eng-1",
    spec: {
      detailType: "room-finish",
      roomName: "Lobby",
      roomNumber: "101",
      floorFinish: "",
      baseFinish: "",
      wallFinish: "",
      ceilingFinish: "",
      ceilingHeight: "",
    },
    pushState: "pending",
    apsTaskRef: null,
    findingId: null,
    responseTaskId: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    pushedAt: null,
    actorId: null,
    principalActorId: null,
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const ui: ReactNode = (
    <QueryClientProvider client={client}>
      <DetailCalloutSpecsTab engagementId="eng-1" />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  hoisted.listData = undefined;
  hoisted.listIsLoading = false;
  hoisted.createMutate.mockReset();
  hoisted.pushStateMutate.mockReset();
  hoisted.apsRefMutate.mockReset();
});

describe("DetailCalloutSpecsTab", () => {
  it("renders the loading state", () => {
    hoisted.listIsLoading = true;
    renderTab();
    expect(
      screen.getByTestId("detail-callout-specs-loading"),
    ).toBeInTheDocument();
  });

  it("renders the empty state", () => {
    hoisted.listData = { detailCalloutSpecs: [] };
    renderTab();
    expect(
      screen.getByTestId("detail-callout-specs-empty"),
    ).toBeInTheDocument();
  });

  it("offers only Push to Revit for a pending spec", () => {
    hoisted.listData = { detailCalloutSpecs: [makeSpec({ pushState: "pending" })] };
    renderTab();
    expect(
      screen.getByTestId("detail-callout-dcs-1-to-pushed"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("detail-callout-dcs-1-to-applied"),
    ).not.toBeInTheDocument();
  });

  it("offers apply / reject for a pushed spec", () => {
    hoisted.listData = { detailCalloutSpecs: [makeSpec({ pushState: "pushed" })] };
    renderTab();
    expect(
      screen.getByTestId("detail-callout-dcs-1-to-applied"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("detail-callout-dcs-1-to-rejected-by-user"),
    ).toBeInTheDocument();
  });

  it("transitions push-state via the mutation", () => {
    hoisted.listData = { detailCalloutSpecs: [makeSpec({ pushState: "pending" })] };
    renderTab();
    fireEvent.click(screen.getByTestId("detail-callout-dcs-1-to-pushed"));
    expect(hoisted.pushStateMutate).toHaveBeenCalledWith({
      specId: "dcs-1",
      data: { pushState: "pushed" },
    });
  });

  it("builds and submits a room-finish spec from the create dialog", () => {
    hoisted.listData = { detailCalloutSpecs: [] };
    renderTab();
    fireEvent.click(screen.getByTestId("detail-callout-specs-new"));
    fireEvent.change(screen.getByTestId("detail-callout-field-roomName"), {
      target: { value: "Lobby" },
    });
    fireEvent.click(screen.getByTestId("create-detail-callout-spec-submit"));
    expect(hoisted.createMutate).toHaveBeenCalledTimes(1);
    const arg = hoisted.createMutate.mock.calls[0][0] as {
      engagementId: string;
      data: { spec: { detailType: string; roomName: string } };
    };
    expect(arg.engagementId).toBe("eng-1");
    expect(arg.data.spec.detailType).toBe("room-finish");
    expect(arg.data.spec.roomName).toBe("Lobby");
  });
});
