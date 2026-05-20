/**
 * DeliverableLettersTab — Cortex L3 (Lane C.4 / C.4.3).
 *
 * Coverage isolated to the tab's component contract:
 *   - Loading / empty / populated states.
 *   - Completeness banner reflects the required-section set.
 *   - "Send letter" is gated until cover/intro/signature are present.
 *   - "New letter" opens the create dialog and submits the title.
 *   - A section save calls the upsert mutation with the section index.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  listData: undefined as { deliverableLetters: unknown[] } | undefined,
  listIsLoading: false,
  createMutate: vi.fn(),
  upsertMutate: vi.fn(),
  mergeMutate: vi.fn(),
  sendMutate: vi.fn(),
  rendersData: undefined as { renders: unknown[] } | undefined,
  renderMutate: vi.fn(),
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
  getListDeliverableLettersQueryKey: (id: string) => [
    "listDeliverableLetters",
    id,
  ],
  useListDeliverableLetters: () => ({
    data: hoisted.listData,
    isLoading: hoisted.listIsLoading,
  }),
  useCreateDeliverableLetter: () => ({
    mutate: hoisted.createMutate,
    isPending: false,
  }),
  useUpsertDeliverableLetterSection: () => ({
    mutate: hoisted.upsertMutate,
    isPending: false,
  }),
  useMergeDeliverableLetterProvenance: () => ({
    mutate: hoisted.mergeMutate,
    isPending: false,
  }),
  useSendDeliverableLetter: () => ({
    mutate: hoisted.sendMutate,
    isPending: false,
  }),
  getListDeliverableLetterRendersQueryKey: (id: string) => [
    "listDeliverableLetterRenders",
    id,
  ],
  useListDeliverableLetterRenders: () => ({ data: hoisted.rendersData }),
  useRenderDeliverableLetter: () => ({
    mutate: hoisted.renderMutate,
    isPending: false,
  }),
}));

const { DeliverableLettersTab } = await import("../DeliverableLettersTab");

function emptyProv() {
  return {
    responseTaskIds: [],
    sheetContentExtractionIds: [],
    findingIds: [],
    adjudicationStateIds: [],
  };
}

function makeLetter(overrides: Record<string, unknown> = {}) {
  return {
    entityType: "deliverable-letter",
    entityId: "dl-1",
    jurisdictionTenant: "default",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "",
    contentHash: "h",
    engagementId: "eng-1",
    title: "Comment response",
    status: "draft",
    recipientActorId: null,
    sections: [],
    createdAt: "2026-05-19T00:00:00.000Z",
    sentAt: null,
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
      <DeliverableLettersTab engagementId="eng-1" />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  hoisted.listData = undefined;
  hoisted.listIsLoading = false;
  hoisted.createMutate.mockReset();
  hoisted.upsertMutate.mockReset();
  hoisted.mergeMutate.mockReset();
  hoisted.sendMutate.mockReset();
  hoisted.rendersData = undefined;
  hoisted.renderMutate.mockReset();
});

describe("DeliverableLettersTab", () => {
  it("renders the loading state", () => {
    hoisted.listIsLoading = true;
    renderTab();
    expect(
      screen.getByTestId("deliverable-letters-loading"),
    ).toBeInTheDocument();
  });

  it("renders the empty state", () => {
    hoisted.listData = { deliverableLetters: [] };
    renderTab();
    expect(screen.getByTestId("deliverable-letters-empty")).toBeInTheDocument();
  });

  it("shows an incomplete-letter completeness banner and disables Send", () => {
    hoisted.listData = { deliverableLetters: [makeLetter()] };
    renderTab();
    expect(
      screen.getByTestId("deliverable-letter-completeness"),
    ).toHaveTextContent(/Incomplete/);
    const send = screen.getByTestId(
      "deliverable-letter-send",
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("enables Send when cover/intro/signature are all present", () => {
    hoisted.listData = {
      deliverableLetters: [
        makeLetter({
          sections: [
            { kind: "cover", heading: "c", content: "", provenance: emptyProv() },
            { kind: "intro", heading: "i", content: "", provenance: emptyProv() },
            {
              kind: "signature",
              heading: "s",
              content: "",
              provenance: emptyProv(),
            },
          ],
        }),
      ],
    };
    renderTab();
    expect(
      screen.getByTestId("deliverable-letter-completeness"),
    ).toHaveTextContent(/Complete/);
    const send = screen.getByTestId(
      "deliverable-letter-send",
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(hoisted.sendMutate).toHaveBeenCalledWith({ letterId: "dl-1" });
  });

  it("opens the create dialog and submits the title", () => {
    hoisted.listData = { deliverableLetters: [] };
    renderTab();
    fireEvent.click(screen.getByTestId("deliverable-letters-new"));
    fireEvent.change(
      screen.getByTestId("create-deliverable-letter-title"),
      { target: { value: "  Round 2  " } },
    );
    fireEvent.click(screen.getByTestId("create-deliverable-letter-submit"));
    expect(hoisted.createMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.createMutate.mock.calls[0][0]).toMatchObject({
      engagementId: "eng-1",
      data: { title: "Round 2" },
    });
  });

  it("saves a section through the upsert mutation", () => {
    hoisted.listData = {
      deliverableLetters: [
        makeLetter({
          sections: [
            {
              kind: "cover",
              heading: "Cover",
              content: "body",
              provenance: emptyProv(),
            },
          ],
        }),
      ],
    };
    renderTab();
    fireEvent.click(screen.getByTestId("deliverable-letter-section-0-save"));
    expect(hoisted.upsertMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertMutate.mock.calls[0][0]).toMatchObject({
      letterId: "dl-1",
      data: { sectionIndex: 0, kind: "cover" },
    });
  });

  it("adds a section via the add-section affordance", () => {
    hoisted.listData = { deliverableLetters: [makeLetter()] };
    renderTab();
    fireEvent.click(screen.getByTestId("deliverable-letter-add-section"));
    expect(hoisted.upsertMutate).toHaveBeenCalledWith({
      letterId: "dl-1",
      data: {
        sectionIndex: 0,
        kind: "per-comment-response",
        heading: "",
        content: "",
      },
    });
  });

  it("disables the render buttons while the letter is incomplete (L6)", () => {
    hoisted.listData = { deliverableLetters: [makeLetter()] };
    renderTab();
    const docx = screen.getByTestId(
      "deliverable-letter-render-docx",
    ) as HTMLButtonElement;
    expect(docx.disabled).toBe(true);
  });

  it("renders to PDF via the mutation once complete (L6)", () => {
    hoisted.listData = {
      deliverableLetters: [
        makeLetter({
          sections: [
            { kind: "cover", heading: "c", content: "", provenance: emptyProv() },
            { kind: "intro", heading: "i", content: "", provenance: emptyProv() },
            {
              kind: "signature",
              heading: "s",
              content: "",
              provenance: emptyProv(),
            },
          ],
        }),
      ],
    };
    renderTab();
    const pdf = screen.getByTestId(
      "deliverable-letter-render-pdf",
    ) as HTMLButtonElement;
    expect(pdf.disabled).toBe(false);
    fireEvent.click(pdf);
    expect(hoisted.renderMutate).toHaveBeenCalledWith({
      letterId: "dl-1",
      data: { format: "pdf" },
    });
  });

  it("lists existing renders with a download link (L6)", () => {
    hoisted.listData = { deliverableLetters: [makeLetter()] };
    hoisted.rendersData = {
      renders: [
        {
          entityId: "rnd-1",
          format: "pdf",
          renderedAt: "2026-05-19T00:00:00.000Z",
        },
      ],
    };
    renderTab();
    expect(
      screen.getByTestId("deliverable-letter-render-row-rnd-1"),
    ).toBeInTheDocument();
    const download = screen.getByTestId(
      "deliverable-letter-render-rnd-1-download",
    ) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe(
      "/api/deliverable-letter-renders/rnd-1/file",
    );
  });
});
