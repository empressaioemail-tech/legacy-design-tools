/**
 * ProductSpecReferencesTab — Cortex L5 (Lane C.4 / C.4.5).
 *
 * Coverage isolated to the tab's component contract:
 *   - Loading / empty / populated states.
 *   - Withdrawn / expired references are flagged for review.
 *   - The refresh button calls the ICC-ES poll mutation.
 *   - The create dialog gates on a well-formed ESR number.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  listData: undefined as { productSpecReferences: unknown[] } | undefined,
  listIsLoading: false,
  createMutate: vi.fn(),
  refreshMutate: vi.fn(),
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
  getListProductSpecReferencesQueryKey: (id: string) => [
    "listProductSpecReferences",
    id,
  ],
  useListProductSpecReferences: () => ({
    data: hoisted.listData,
    isLoading: hoisted.listIsLoading,
  }),
  useCreateProductSpecReference: () => ({
    mutate: hoisted.createMutate,
    isPending: false,
  }),
  useRefreshProductSpecReference: () => ({
    mutate: hoisted.refreshMutate,
    isPending: false,
  }),
}));

const { ProductSpecReferencesTab } = await import(
  "../ProductSpecReferencesTab"
);

function makeRef(overrides: Record<string, unknown> = {}) {
  return {
    entityType: "product-spec-reference",
    entityId: "psr-1",
    jurisdictionTenant: "default",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "https://icc-es.org/x",
    contentHash: "h",
    product: { name: "SDWS Screw", manufacturer: "Simpson Strong-Tie" },
    esrNumber: "ESR-1234",
    status: "active",
    lastVerifiedAt: "2026-05-19T00:00:00.000Z",
    statusHistory: [],
    engagementId: "eng-1",
    findingId: null,
    responseTaskId: null,
    createdAt: "2026-05-19T00:00:00.000Z",
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
      <ProductSpecReferencesTab engagementId="eng-1" />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  hoisted.listData = undefined;
  hoisted.listIsLoading = false;
  hoisted.createMutate.mockReset();
  hoisted.refreshMutate.mockReset();
});

describe("ProductSpecReferencesTab", () => {
  it("renders the loading state", () => {
    hoisted.listIsLoading = true;
    renderTab();
    expect(
      screen.getByTestId("product-spec-references-loading"),
    ).toBeInTheDocument();
  });

  it("renders the empty state", () => {
    hoisted.listData = { productSpecReferences: [] };
    renderTab();
    expect(
      screen.getByTestId("product-spec-references-empty"),
    ).toBeInTheDocument();
  });

  it("renders a row with its ESR number and status badge", () => {
    hoisted.listData = { productSpecReferences: [makeRef()] };
    renderTab();
    expect(screen.getByTestId("product-spec-esr-psr-1")).toHaveTextContent(
      "ESR-1234",
    );
    expect(screen.getByTestId("product-spec-status-active")).toBeInTheDocument();
  });

  it("flags a withdrawn reference for review", () => {
    hoisted.listData = {
      productSpecReferences: [makeRef({ status: "withdrawn" })],
    };
    renderTab();
    expect(
      screen.getByTestId("product-spec-psr-1-review-flag"),
    ).toBeInTheDocument();
  });

  it("does not flag an active reference", () => {
    hoisted.listData = { productSpecReferences: [makeRef()] };
    renderTab();
    expect(
      screen.queryByTestId("product-spec-psr-1-review-flag"),
    ).not.toBeInTheDocument();
  });

  it("triggers the ICC-ES refresh mutation", () => {
    hoisted.listData = { productSpecReferences: [makeRef()] };
    renderTab();
    fireEvent.click(screen.getByTestId("product-spec-psr-1-refresh"));
    expect(hoisted.refreshMutate).toHaveBeenCalledWith({
      referenceId: "psr-1",
    });
  });

  it("gates the create submit on a well-formed ESR number", () => {
    hoisted.listData = { productSpecReferences: [] };
    renderTab();
    fireEvent.click(screen.getByTestId("product-spec-references-new"));
    fireEvent.change(screen.getByTestId("product-spec-name-input"), {
      target: { value: "Screw" },
    });
    fireEvent.change(screen.getByTestId("product-spec-manufacturer-input"), {
      target: { value: "Simpson" },
    });
    const submit = screen.getByTestId(
      "create-product-spec-reference-submit",
    ) as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("product-spec-esr-input"), {
      target: { value: "not-an-esr" },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("product-spec-esr-input"), {
      target: { value: "ESR-2929" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(hoisted.createMutate.mock.calls[0][0]).toMatchObject({
      engagementId: "eng-1",
      data: { esrNumber: "ESR-2929" },
    });
  });
});
