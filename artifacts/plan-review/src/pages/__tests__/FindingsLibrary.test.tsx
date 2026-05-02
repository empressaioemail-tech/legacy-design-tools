/**
 * FindingsLibrary — regression spec for the quick-filter buttons (Task #133).
 *
 * The Findings Library page exposes four quick-filter buttons (All / Blocking
 * / AI-only / Open) above the table. They were just wired up to actually
 * filter the rows and to compose with the top-bar search box. Without a
 * pinned test, a future page-state refactor could silently turn them back
 * into dead buttons.
 *
 * This spec follows the same "lock in" pattern as `EngagementsList.test.tsx`
 * (URL-driven status tabs) and the design-tools side's banner/comment-toggle
 * tests: render the page in isolation against the existing mock dataset and
 * assert against `data-testid`-anchored selectors. The dataset asserts use
 * filtered counts derived from `FINDINGS` so the test stays robust when new
 * fixture rows are added, as long as the *kind* of fixture row coverage
 * (at least one blocking / AI / open row, plus at least one row that is
 * NONE of those) is preserved.
 *
 * `useNavGroups` reads the session via `useGetSession`, so we mock
 * `@workspace/api-client-react` to hand back an empty permission set; the
 * gated nav entries simply don't render and the page itself is ungated.
 * The page also uses wouter `<Link>` for the submittal column, so we wrap
 * the render in a `Router` with an in-memory location hook.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { FINDINGS } from "../../data/mock";

vi.mock("@workspace/api-client-react", () => ({
  useGetSession: () => ({ data: { permissions: [] }, isLoading: false }),
  getGetSessionQueryKey: () => ["session"],
  // Task #444 — `useNavGroups` now reads pending reviewer-requests
  // for the sidebar badge. Audience here is undefined so the hook
  // is gated to `enabled: false`, but the symbol still has to
  // resolve at module load.
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

function getDataRowCount(): number {
  const table = screen.getByTestId("findings-table");
  // Exclude the header row.
  return within(table).getAllByRole("row").length - 1;
}

function isQuickFilterActive(id: "all" | "blocking" | "ai-only" | "open"): boolean {
  const btn = screen.getByTestId(`findings-quick-filter-${id}`);
  return btn.getAttribute("aria-pressed") === "true";
}

const TOTAL = FINDINGS.length;
const BLOCKING_COUNT = FINDINGS.filter((f) => f.severity === "blocking").length;
const AI_ONLY_COUNT = FINDINGS.filter((f) => f.source === "ai-reviewer").length;
const OPEN_COUNT = FINDINGS.filter((f) => f.status === "open").length;

afterEach(() => {
  cleanup();
});

describe("FindingsLibrary — quick filters", () => {
  it("renders every finding and starts with the All filter pressed", () => {
    renderPage();

    expect(getDataRowCount()).toBe(TOTAL);
    expect(isQuickFilterActive("all")).toBe(true);
    expect(isQuickFilterActive("blocking")).toBe(false);
    expect(isQuickFilterActive("ai-only")).toBe(false);
    expect(isQuickFilterActive("open")).toBe(false);
    expect(screen.queryByTestId("findings-no-matches")).toBeNull();
  });

  it("Blocking restricts to severity=blocking rows and flips aria-pressed", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("findings-quick-filter-blocking"));

    expect(isQuickFilterActive("blocking")).toBe(true);
    expect(isQuickFilterActive("all")).toBe(false);
    expect(getDataRowCount()).toBe(BLOCKING_COUNT);

    // Sanity: Blocking should be a strict subset of the full list.
    expect(BLOCKING_COUNT).toBeGreaterThan(0);
    expect(BLOCKING_COUNT).toBeLessThan(TOTAL);

    // Every visible severity pill must read "blocking".
    const table = screen.getByTestId("findings-table");
    const severityCells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td:first-child")?.textContent?.trim());
    for (const text of severityCells) {
      expect(text).toBe("blocking");
    }
  });

  it("AI-only restricts to source=ai-reviewer rows (Source column reads 'AI')", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("findings-quick-filter-ai-only"));

    expect(isQuickFilterActive("ai-only")).toBe(true);
    expect(getDataRowCount()).toBe(AI_ONLY_COUNT);
    expect(AI_ONLY_COUNT).toBeGreaterThan(0);
    expect(AI_ONLY_COUNT).toBeLessThan(TOTAL);

    // Source is the 5th column in the table.
    const table = screen.getByTestId("findings-table");
    const sourceCells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td:nth-child(5)")?.textContent?.trim());
    for (const text of sourceCells) {
      expect(text).toBe("AI");
    }
  });

  it("Open restricts to status=open rows", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("findings-quick-filter-open"));

    expect(isQuickFilterActive("open")).toBe(true);
    expect(getDataRowCount()).toBe(OPEN_COUNT);
    expect(OPEN_COUNT).toBeGreaterThan(0);
    expect(OPEN_COUNT).toBeLessThan(TOTAL);

    // Status is the last (8th) column.
    const table = screen.getByTestId("findings-table");
    const statusCells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td:nth-child(8)")?.textContent?.trim());
    for (const text of statusCells) {
      expect(text).toBe("open");
    }
  });

  it("only one quick-filter button is pressed at a time", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("findings-quick-filter-blocking"));
    expect(isQuickFilterActive("blocking")).toBe(true);
    expect(isQuickFilterActive("all")).toBe(false);

    fireEvent.click(screen.getByTestId("findings-quick-filter-ai-only"));
    expect(isQuickFilterActive("ai-only")).toBe(true);
    expect(isQuickFilterActive("blocking")).toBe(false);
    expect(isQuickFilterActive("all")).toBe(false);
    expect(isQuickFilterActive("open")).toBe(false);

    fireEvent.click(screen.getByTestId("findings-quick-filter-open"));
    expect(isQuickFilterActive("open")).toBe(true);
    expect(isQuickFilterActive("ai-only")).toBe(false);
  });

  it("clicking All restores the full table after another filter was active", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("findings-quick-filter-blocking"));
    expect(getDataRowCount()).toBe(BLOCKING_COUNT);

    fireEvent.click(screen.getByTestId("findings-quick-filter-all"));
    expect(isQuickFilterActive("all")).toBe(true);
    expect(getDataRowCount()).toBe(TOTAL);
    expect(screen.queryByTestId("findings-no-matches")).toBeNull();
  });

  it("combining a quick filter with a non-matching search shows the filter-aware empty state", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("findings-quick-filter-blocking"));
    expect(getDataRowCount()).toBe(BLOCKING_COUNT);

    // Pick a query that no row can possibly match so the no-matches row
    // is forced regardless of which fixture rows happen to be blocking.
    const search = screen.getByPlaceholderText("Search findings...");
    fireEvent.change(search, { target: { value: "zzz-no-such-finding-xyz" } });

    const empty = screen.getByTestId("findings-no-matches");
    // Copy must mention the active filter label and the search term so the
    // user can tell why nothing came back.
    expect(empty.textContent).toContain("Blocking");
    expect(empty.textContent).toContain("zzz-no-such-finding-xyz");

    // Clearing the search but keeping the filter brings the rows back.
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.queryByTestId("findings-no-matches")).toBeNull();
    expect(getDataRowCount()).toBe(BLOCKING_COUNT);
  });
});
