import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("@workspace/api-client-react", () => ({
  useGetSession: () => ({ data: { permissions: [] }, isLoading: false }),
  getGetSessionQueryKey: () => ["session"],
  useListMyReviewerRequests: () => ({ data: { requests: [] } }),
  getListMyReviewerRequestsQueryKey: () => ["listMyReviewerRequests"],
}));

const { default: FindingsLibrary } = await import("../FindingsLibrary");

function renderPage() {
  const memory = memoryLocation({ path: "/findings", record: true });
  return render(
    <Router hook={memory.hook}>
      <FindingsLibrary />
    </Router>,
  );
}

afterEach(() => {
  cleanup();
});

describe("FindingsLibrary", () => {
  it("renders the no-findings empty state and no demo rows", () => {
    renderPage();
    const empty = screen.getByTestId("findings-library-empty-state");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/No findings yet/i);
    expect(screen.queryByTestId("findings-table")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/SUB-2026-/);
  });
});
