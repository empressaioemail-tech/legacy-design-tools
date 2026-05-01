/**
 * EngagementsList — regression spec for the `?status=` shareable filter
 * query string introduced in Task #108.
 *
 * The page exposes four status tabs (Active / On hold / Archived / All)
 * and reflects the active tab in the URL via wouter's `useLocation` and
 * `useSearch`. Task #108 was verified manually; this spec pins the
 * behaviour so that future routing refactors (or a wouter swap) cannot
 * silently regress the deep-linking contract.
 *
 * The test mocks `@workspace/api-client-react` so the page renders with
 * deterministic data and no network, then drives the page through a
 * wouter `Router` configured with the in-memory location hook so we can
 * assert against the recorded URL after each tab click without touching
 * `window.history`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { EngagementSummary } from "@workspace/api-client-react";

// One row per status so every tab has at least one item to render and so
// each tab's count badge is non-zero, mirroring a realistic seeded list.
const ENGAGEMENTS: EngagementSummary[] = [
  mkEngagement({ id: "eng-active", name: "Active Project", status: "active" }),
  mkEngagement({
    id: "eng-on-hold",
    name: "Paused Project",
    status: "on_hold",
  }),
  mkEngagement({
    id: "eng-archived",
    name: "Old Project",
    status: "archived",
  }),
];

vi.mock("@workspace/api-client-react", () => ({
  useListEngagements: () => ({
    data: ENGAGEMENTS,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
  getListEngagementsQueryKey: () => ["engagements"],
  // Sidebar permissions: the test session has no claims, which is fine
  // because the Engagements page itself is not gated; the gated nav
  // entries (e.g. Users & Roles) just won't render in the sidebar.
  useGetSession: () => ({ data: { permissions: [] }, isLoading: false }),
  getGetSessionQueryKey: () => ["session"],
  EngagementStatus: {
    active: "active",
    on_hold: "on_hold",
    archived: "archived",
  },
}));

const { default: EngagementsList } = await import("../EngagementsList");

function mkEngagement(
  over: Partial<EngagementSummary> &
    Pick<EngagementSummary, "id" | "name" | "status">,
): EngagementSummary {
  return {
    id: over.id,
    name: over.name,
    status: over.status,
    jurisdiction: over.jurisdiction ?? "Moab, UT",
    address: over.address ?? "100 Main St",
    createdAt: over.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-04-15T00:00:00.000Z",
    snapshotCount: over.snapshotCount ?? 1,
    latestSnapshot: over.latestSnapshot ?? null,
    site: over.site ?? {
      latitude: null,
      longitude: null,
      countyFips: null,
      stateFips: null,
      placeFips: null,
    },
    revitCentralGuid: over.revitCentralGuid ?? null,
    revitDocumentPath: over.revitDocumentPath ?? null,
  } as EngagementSummary;
}

function renderAt(initialPath: string) {
  const memory = memoryLocation({ path: initialPath, record: true });
  const utils = render(
    <Router hook={memory.hook}>
      <EngagementsList />
    </Router>,
  );
  return { ...utils, memory };
}

function selectedTabTestId(): string | null {
  const tabs = screen.getAllByRole("tab");
  const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true");
  return selected?.getAttribute("data-testid") ?? null;
}

beforeEach(() => {
  // No shared state to reset; mocks are pure.
});

afterEach(() => {
  cleanup();
});

describe("EngagementsList — `?status=` filter URL", () => {
  it("defaults to the Active tab and leaves the URL clean on first load", () => {
    const { memory } = renderAt("/engagements");

    expect(selectedTabTestId()).toBe("engagements-filter-active");
    // History should not have been rewritten by the initial render — the
    // pristine path should still be the only entry.
    expect(memory.history).toEqual(["/engagements"]);
  });

  it("clicking a non-default tab pushes `?status=` into the URL", () => {
    const { memory } = renderAt("/engagements");

    fireEvent.click(screen.getByTestId("engagements-filter-on-hold"));
    expect(selectedTabTestId()).toBe("engagements-filter-on-hold");
    expect(memory.history.at(-1)).toBe("/engagements?status=on_hold");

    fireEvent.click(screen.getByTestId("engagements-filter-archived"));
    expect(selectedTabTestId()).toBe("engagements-filter-archived");
    expect(memory.history.at(-1)).toBe("/engagements?status=archived");

    fireEvent.click(screen.getByTestId("engagements-filter-all"));
    expect(selectedTabTestId()).toBe("engagements-filter-all");
    expect(memory.history.at(-1)).toBe("/engagements?status=all");
  });

  it("clicking back to Active strips the `?status=` parameter", () => {
    const { memory } = renderAt("/engagements?status=on_hold");
    expect(selectedTabTestId()).toBe("engagements-filter-on-hold");

    fireEvent.click(screen.getByTestId("engagements-filter-active"));
    expect(selectedTabTestId()).toBe("engagements-filter-active");
    expect(memory.history.at(-1)).toBe("/engagements");
  });

  it("re-mounting on `?status=on_hold` keeps the On hold tab selected", () => {
    // Simulates a page reload / fresh navigation with the share-link URL.
    renderAt("/engagements?status=on_hold");
    expect(selectedTabTestId()).toBe("engagements-filter-on-hold");
  });

  it("deep-links to the Archived tab when `?status=archived` is in the URL", () => {
    renderAt("/engagements?status=archived");
    expect(selectedTabTestId()).toBe("engagements-filter-archived");
  });

  it("deep-links to the All tab when `?status=all` is in the URL", () => {
    renderAt("/engagements?status=all");
    expect(selectedTabTestId()).toBe("engagements-filter-all");
  });

  it("falls back to Active when `?status=` is an unknown value", () => {
    renderAt("/engagements?status=bogus");
    expect(selectedTabTestId()).toBe("engagements-filter-active");
  });
});
