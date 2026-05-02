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
import { noApplicableAdaptersMessage } from "@workspace/adapters";

// One row per status so every tab has at least one item to render and so
// each tab's count badge is non-zero, mirroring a realistic seeded list.
//
// The Active row carries a Moab, UT geocode so the per-row pilot
// eligibility (Task #278) lands on the in-pilot branch — the empty-
// pilot pill test below relies on this. The other two rows are left
// without a geocode so the resolver lands on the unresolved branch
// and the pill must render.
const ENGAGEMENTS: EngagementSummary[] = [
  mkEngagement({
    id: "eng-active",
    name: "Active Project",
    status: "active",
    site: {
      address: "100 Main St, Moab, UT",
      geocode: {
        latitude: 38.573,
        longitude: -109.5494,
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        jurisdictionFips: null,
        source: "manual",
        geocodedAt: "2026-04-01T00:00:00.000Z",
      },
      projectType: null,
      zoningCode: null,
      lotAreaSqft: null,
    },
  } as Partial<EngagementSummary> &
    Pick<EngagementSummary, "id" | "name" | "status">),
  // Out-of-pilot rows: explicit nulls on every resolver input so the
  // jurisdiction collapses to the unresolved branch and the empty-
  // pilot pill is exercised. The default `jurisdiction: "Moab, UT"`
  // would otherwise be parsed by the freeform-text fallback in
  // `resolveJurisdiction` and flip these rows back into pilot.
  mkEngagement({
    id: "eng-on-hold",
    name: "Paused Project",
    status: "on_hold",
    jurisdiction: null,
    address: null,
  }),
  mkEngagement({
    id: "eng-archived",
    name: "Old Project",
    status: "archived",
    jurisdiction: null,
    address: null,
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
  // Task #444 — `useNavGroups` now reads pending reviewer-requests
  // for the sidebar badge. Audience here is undefined so the hook
  // is gated to `enabled: false`, but the symbol still has to
  // resolve at module load.
  useListMyReviewerRequests: () => ({ data: { requests: [] } }),
  getListMyReviewerRequestsQueryKey: () => ["listMyReviewerRequests"],
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
  // We intentionally use `in` rather than `??` for the nullable fields
  // below so callers can pass explicit `null` to opt out of the
  // default (e.g. the Task #278 pill test needs jurisdiction/address
  // to actually be null so `resolveJurisdiction` lands on the
  // unresolved branch).
  return {
    id: over.id,
    name: over.name,
    status: over.status,
    jurisdiction: "jurisdiction" in over ? over.jurisdiction : "Moab, UT",
    address: "address" in over ? over.address : "100 Main St",
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

/**
 * Per-row "No adapters" pill — Task #278.
 *
 * Mirrors the design-tools EngagementList card-pill regression
 * (Task #235) on the plan-review surface so reviewers can triage
 * out-of-pilot projects without opening each detail page. Both
 * surfaces feed the shared `resolveJurisdiction` +
 * `filterApplicableAdapters` pair from
 * `@workspace/adapters/eligibility` and surface the tooltip via the
 * shared `noApplicableAdaptersMessage` helper, so the wording cannot
 * drift between the two lists or the EngagementDetail banner.
 *
 * Reuses the top-of-file `ENGAGEMENTS` fixture (and its mock):
 *   - eng-active → Moab, UT geocode → in pilot → no pill.
 *   - eng-on-hold / eng-archived → no geocode → resolver lands on
 *     the unresolved branch → pill must render. We assert the pill
 *     using the All tab so every row is visible regardless of
 *     status filtering.
 */
describe("EngagementsList — empty-pilot pill (Task #278)", () => {
  it("renders the 'No adapters' pill on the in-pilot Active row's absence and the unresolved rows' presence, using the shared helper's tooltip", () => {
    renderAt("/engagements?status=all");

    const moabRow = screen.getByTestId("engagement-row-eng-active");
    expect(moabRow.getAttribute("data-in-pilot")).toBe("true");
    expect(
      moabRow.querySelector(
        "[data-testid='engagement-row-no-adapters-pill']",
      ),
    ).toBeNull();

    const onHoldRow = screen.getByTestId("engagement-row-eng-on-hold");
    expect(onHoldRow.getAttribute("data-in-pilot")).toBe("false");
    const onHoldPill = onHoldRow.querySelector(
      "[data-testid='engagement-row-no-adapters-pill']",
    );
    expect(onHoldPill).not.toBeNull();
    // The on-hold and archived fixtures have no city/state geocode, so
    // the resolver lands on the unresolved branch — the same input
    // shape the EngagementDetail banner would compute from. We assert
    // against the shared helper directly so a copy tweak on either
    // side fails this test instead of silently drifting.
    expect(onHoldPill?.getAttribute("title")).toBe(
      noApplicableAdaptersMessage({ stateKey: null, localKey: null }),
    );

    const archivedRow = screen.getByTestId("engagement-row-eng-archived");
    expect(archivedRow.getAttribute("data-in-pilot")).toBe("false");
    expect(
      archivedRow.querySelector(
        "[data-testid='engagement-row-no-adapters-pill']",
      ),
    ).not.toBeNull();
  });
});

/**
 * "Show only in-pilot" filter + out-of-pilot tally — Task #303 B.2.
 *
 * Mirrors the design-tools EngagementList Task #235 stretch toggle on
 * the plan-review surface so reviewers can focus triage on the
 * actionable subset without bouncing back to design-tools. Both
 * surfaces feed the same `resolveJurisdiction` +
 * `filterApplicableAdapters` pair from `@workspace/adapters`, and
 * the row pill, the tally, and the toggle all read the same shared
 * `eligibilityById` map so the three surfaces' verdicts cannot drift.
 *
 * The fixture above seeds three rows: one in-pilot (Moab geocode)
 * and two out-of-pilot (no geocode → unresolved branch). The All
 * tab makes every row visible regardless of status, which is what
 * the toggle's filtering and the tally's count are computed against.
 */
describe("EngagementsList — in-pilot filter + tally (Task #303 B.2)", () => {
  it("renders the out-of-pilot tally inline with the summary", () => {
    renderAt("/engagements?status=all");
    const tally = screen.getByTestId("engagements-out-of-pilot-tally");
    // Two of the three fixture rows resolve to no applicable
    // adapters (no geocode + null jurisdiction/address).
    expect(tally.textContent).toBe("2 out of pilot");
  });

  it("does not render the tally when every engagement is in pilot", async () => {
    // Swap the fixture for a single in-pilot row so the
    // outOfPilotCount falls to 0 and the tally <span> is omitted.
    const original = ENGAGEMENTS.slice();
    ENGAGEMENTS.splice(0, ENGAGEMENTS.length, original[0]!);
    cleanup();
    renderAt("/engagements?status=all");
    expect(screen.queryByTestId("engagements-out-of-pilot-tally")).toBeNull();
    // Restore so subsequent tests see the full fixture.
    ENGAGEMENTS.splice(0, ENGAGEMENTS.length, ...original);
  });

  it("flipping 'Show only in-pilot' hides every out-of-pilot row", () => {
    renderAt("/engagements?status=all");
    expect(screen.getByTestId("engagement-row-eng-active")).not.toBeNull();
    expect(screen.getByTestId("engagement-row-eng-on-hold")).not.toBeNull();
    expect(screen.getByTestId("engagement-row-eng-archived")).not.toBeNull();

    fireEvent.click(screen.getByTestId("engagements-filter-in-pilot"));

    expect(screen.getByTestId("engagement-row-eng-active")).not.toBeNull();
    expect(screen.queryByTestId("engagement-row-eng-on-hold")).toBeNull();
    expect(screen.queryByTestId("engagement-row-eng-archived")).toBeNull();
  });

  it("renders the dedicated empty-state when the toggle hides every row in the active tab", () => {
    // The Active tab only contains the in-pilot row, so the toggle
    // does NOT empty the list there. Switch to a status with only
    // out-of-pilot rows (On hold) so the toggle's empty-state hits.
    renderAt("/engagements?status=on_hold");
    fireEvent.click(screen.getByTestId("engagements-filter-in-pilot"));
    const empty = screen.getByTestId("engagements-empty-filtered-in-pilot");
    expect(empty.textContent).toContain('Uncheck "Show only in-pilot"');
    // The free-text "No engagements match" copy must NOT show — that
    // path is reserved for an actual search miss.
    expect(screen.queryByTestId("engagements-no-matches")).toBeNull();
  });
});
