/**
 * ResponseTasksTab — Cortex L1 (Lane C.4 / C.4.1).
 *
 * Coverage isolated to the tab's component contract (the route
 * round-trip is covered by the api-server integration tests in CI):
 *
 *   - Loading / empty / populated list states render correctly.
 *   - Each row offers exactly the legal next-state actions for the
 *     task's current state (mirrors the api-server transition table).
 *   - "New response task" opens the create dialog; submitting it
 *     calls `createResponseTask` with the trimmed body.
 *   - A state-transition button calls `updateResponseTaskState` with
 *     the right task id + target state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const hoisted = vi.hoisted(() => ({
  listData: undefined as { responseTasks: unknown[] } | undefined,
  listIsLoading: false,
  createMutate: vi.fn(),
  stateMutate: vi.fn(),
  linkMutate: vi.fn(),
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
  getListResponseTasksQueryKey: (id: string) => ["listResponseTasks", id],
  useListResponseTasks: () => ({
    data: hoisted.listData,
    isLoading: hoisted.listIsLoading,
  }),
  useCreateResponseTask: () => ({
    mutate: hoisted.createMutate,
    isPending: false,
  }),
  useUpdateResponseTaskState: () => ({
    mutate: hoisted.stateMutate,
    isPending: false,
  }),
  useLinkResponseTaskFinding: () => ({
    mutate: hoisted.linkMutate,
    isPending: false,
  }),
}));

const { ResponseTasksTab } = await import("../ResponseTasksTab");

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    entityType: "response-task",
    entityId: "rt-1",
    jurisdictionTenant: "default",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "",
    contentHash: "abc",
    title: "Resolve egress comment",
    description: "Width on A-101 stair.",
    state: "open",
    createdAt: "2026-05-19T00:00:00.000Z",
    dueAt: null,
    completedAt: null,
    sourceClientCommentId: null,
    findingId: null,
    engagementId: "eng-1",
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
      <ResponseTasksTab engagementId="eng-1" />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  hoisted.listData = undefined;
  hoisted.listIsLoading = false;
  hoisted.createMutate.mockReset();
  hoisted.stateMutate.mockReset();
  hoisted.linkMutate.mockReset();
});

describe("ResponseTasksTab", () => {
  it("renders the loading state while the list query is pending", () => {
    hoisted.listIsLoading = true;
    renderTab();
    expect(screen.getByTestId("response-tasks-loading")).toBeInTheDocument();
  });

  it("renders the empty state when there are no tasks", () => {
    hoisted.listData = { responseTasks: [] };
    renderTab();
    expect(screen.getByTestId("response-tasks-empty")).toBeInTheDocument();
  });

  it("renders a row per task with its state badge", () => {
    hoisted.listData = {
      responseTasks: [makeTask(), makeTask({ entityId: "rt-2", state: "done" })],
    };
    renderTab();
    expect(screen.getByTestId("response-task-row-rt-1")).toBeInTheDocument();
    expect(
      screen.getByTestId("response-task-state-badge-open"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("response-task-state-badge-done"),
    ).toBeInTheDocument();
  });

  it("offers only the legal next-state actions for an open task", () => {
    hoisted.listData = { responseTasks: [makeTask({ state: "open" })] };
    renderTab();
    expect(
      screen.getByTestId("response-task-rt-1-to-in-progress"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("response-task-rt-1-to-done")).toBeInTheDocument();
    expect(
      screen.getByTestId("response-task-rt-1-to-cancelled"),
    ).toBeInTheDocument();
    // `open` is not a legal target from `open` — no self-transition.
    expect(
      screen.queryByTestId("response-task-rt-1-to-open"),
    ).not.toBeInTheDocument();
  });

  it("offers only Reopen for a done task", () => {
    hoisted.listData = { responseTasks: [makeTask({ state: "done" })] };
    renderTab();
    expect(
      screen.getByTestId("response-task-rt-1-to-in-progress"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("response-task-rt-1-to-done"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("response-task-rt-1-to-cancelled"),
    ).not.toBeInTheDocument();
  });

  it("transitions a task via the state mutation", () => {
    hoisted.listData = { responseTasks: [makeTask({ state: "open" })] };
    renderTab();
    fireEvent.click(screen.getByTestId("response-task-rt-1-to-in-progress"));
    expect(hoisted.stateMutate).toHaveBeenCalledWith({
      responseTaskId: "rt-1",
      data: { state: "in-progress" },
    });
  });

  it("opens the create dialog and submits a trimmed body", () => {
    hoisted.listData = { responseTasks: [] };
    renderTab();
    fireEvent.click(screen.getByTestId("response-tasks-new"));
    const dialog = screen.getByTestId("create-response-task-dialog");
    expect(dialog).toBeInTheDocument();

    fireEvent.change(
      screen.getByTestId("create-response-task-title-input"),
      { target: { value: "  New task  " } },
    );
    fireEvent.change(
      screen.getByTestId("create-response-task-description-input"),
      { target: { value: "details" } },
    );
    fireEvent.click(screen.getByTestId("create-response-task-submit"));

    expect(hoisted.createMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.createMutate.mock.calls[0][0]).toMatchObject({
      engagementId: "eng-1",
      data: { title: "New task", description: "details" },
    });
  });

  it("keeps the create submit disabled until a title is entered", () => {
    hoisted.listData = { responseTasks: [] };
    renderTab();
    fireEvent.click(screen.getByTestId("response-tasks-new"));
    const submit = screen.getByTestId(
      "create-response-task-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(
      screen.getByTestId("create-response-task-title-input"),
      { target: { value: "T" } },
    );
    expect(submit.disabled).toBe(false);
  });

  it("links a finding through the inline editor", () => {
    hoisted.listData = { responseTasks: [makeTask()] };
    renderTab();
    fireEvent.click(screen.getByTestId("response-task-rt-1-link-toggle"));
    fireEvent.change(
      screen.getByTestId("response-task-rt-1-link-input"),
      { target: { value: " finding-9 " } },
    );
    fireEvent.click(screen.getByTestId("response-task-rt-1-link-save"));
    expect(hoisted.linkMutate).toHaveBeenCalledWith({
      responseTaskId: "rt-1",
      data: { findingId: "finding-9" },
    });
  });
});
