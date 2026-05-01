/**
 * EngagementList — regression coverage for the per-card empty-pilot
 * pill introduced by Task #235.
 *
 * Task #189 hid the Generate Layers button behind a per-engagement
 * eligibility pre-flight, but the architect still had to open each
 * engagement to discover whether its jurisdiction had any applicable
 * adapters. Task #235 surfaces the same verdict on the engagements
 * list so non-pilot projects can be triaged in bulk without ever
 * leaving the index. The list and detail surfaces share the same
 * `resolveJurisdiction` + `filterApplicableAdapters` source of truth
 * and the same `noApplicableAdaptersMessage` copy helper from
 * `@workspace/adapters/eligibility`, so the pill tooltip cannot drift
 * from the detail-tab banner copy.
 *
 * The tests pin three behaviours:
 *
 *   1. A row whose jurisdiction resolves to no applicable adapters
 *      renders the "No adapters" pill, with its tooltip set to the
 *      shared helper's exact message string.
 *   2. A row whose jurisdiction is in the pilot does NOT render the
 *      pill — so an in-pilot project is visually clean.
 *   3. The "Show only in-pilot" filter checkbox hides every
 *      out-of-pilot row when toggled on, and shows them again when
 *      toggled off, without mutating the underlying query data.
 *
 * The mock around `@workspace/api-client-react` provides the same
 * shape `useListEngagements` returns from the generated client; no
 * real fetch happens.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { EngagementSummary } from "@workspace/api-client-react";
import { noApplicableAdaptersMessage } from "@workspace/adapters";

const ENGAGEMENTS: EngagementSummary[] = [
  mkEngagement({
    id: "eng-moab",
    name: "Moab Pilot Project",
    jurisdiction: "Moab, UT",
    address: "100 Main St, Moab, UT",
    geocode: {
      latitude: 38.573,
      longitude: -109.5494,
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
    },
  }),
  mkEngagement({
    id: "eng-boulder",
    name: "Boulder Renovation",
    jurisdiction: "Boulder, CO",
    address: "200 Pearl St, Boulder, CO",
    geocode: {
      latitude: 40.015,
      longitude: -105.2705,
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
    },
  }),
  mkEngagement({
    id: "eng-unresolved",
    name: "Unaddressed Project",
    jurisdiction: null,
    address: null,
    geocode: null,
  }),
];

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    useListEngagements: () => ({
      data: ENGAGEMENTS,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: () => {},
    }),
    getListEngagementsQueryKey: () => ["listEngagements"],
  };
});

const { EngagementList } = await import("../EngagementList");

interface MakeOpts {
  id: string;
  name: string;
  jurisdiction: string | null;
  address: string | null;
  geocode: {
    latitude: number;
    longitude: number;
    jurisdictionCity: string | null;
    jurisdictionState: string | null;
  } | null;
}

function mkEngagement(o: MakeOpts): EngagementSummary {
  return {
    id: o.id,
    name: o.name,
    jurisdiction: o.jurisdiction,
    address: o.address,
    status: "active",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    snapshotCount: 1,
    latestSnapshot: null,
    site: {
      address: o.address,
      geocode: o.geocode
        ? {
            latitude: o.geocode.latitude,
            longitude: o.geocode.longitude,
            jurisdictionCity: o.geocode.jurisdictionCity,
            jurisdictionState: o.geocode.jurisdictionState,
            jurisdictionFips: null,
            source: "manual",
            geocodedAt: "2026-04-01T00:00:00.000Z",
          }
        : null,
      projectType: null,
      zoningCode: null,
      lotAreaSqft: null,
    },
    revitCentralGuid: null,
    revitDocumentPath: null,
  } as EngagementSummary;
}

function renderList() {
  const memory = memoryLocation({ path: "/", record: true });
  return render(
    <Router hook={memory.hook}>
      <EngagementList />
    </Router>,
  );
}

afterEach(() => {
  cleanup();
});

describe("EngagementList — empty-pilot pill", () => {
  it("renders the 'No adapters' pill on out-of-pilot rows with the shared helper's message as its tooltip", () => {
    renderList();

    // The Boulder row resolves to no applicable adapters because
    // Colorado is not a pilot state — the pill must be present and
    // its tooltip must match `noApplicableAdaptersMessage` for the
    // resolved jurisdiction so the list copy stays in lockstep with
    // the detail-tab banner.
    const boulderCard = screen.getByTestId("engagement-card-eng-boulder");
    expect(boulderCard.getAttribute("data-in-pilot")).toBe("false");
    const boulderPill = boulderCard.querySelector(
      "[data-testid='engagement-card-no-adapters-pill']",
    );
    expect(boulderPill).not.toBeNull();
    // Boulder has city + state set, so the resolver lands on the
    // state-key-null branch (Colorado isn't in the registry), which
    // is the same input shape the detail banner would compute from.
    expect(boulderPill?.getAttribute("title")).toBe(
      noApplicableAdaptersMessage({ stateKey: null, localKey: null }),
    );

    // The unaddressed row also has no applicable adapters; same pill,
    // same shared-helper tooltip.
    const unresolvedCard = screen.getByTestId("engagement-card-eng-unresolved");
    expect(unresolvedCard.getAttribute("data-in-pilot")).toBe("false");
    expect(
      unresolvedCard.querySelector(
        "[data-testid='engagement-card-no-adapters-pill']",
      ),
    ).not.toBeNull();
  });

  it("does NOT render the pill on rows whose jurisdiction is in the pilot", () => {
    renderList();

    const moabCard = screen.getByTestId("engagement-card-eng-moab");
    expect(moabCard.getAttribute("data-in-pilot")).toBe("true");
    expect(
      moabCard.querySelector(
        "[data-testid='engagement-card-no-adapters-pill']",
      ),
    ).toBeNull();
  });

  it("counts out-of-pilot engagements in the header summary", () => {
    renderList();

    const tally = screen.getByTestId("engagements-out-of-pilot-tally");
    // Boulder + unaddressed → 2 of the 3 fixture rows.
    expect(tally.textContent).toBe("2 out of pilot");
  });

  it("filters out-of-pilot rows when 'Show only in-pilot' is toggled on", () => {
    renderList();

    // All three rows visible by default.
    expect(screen.getByTestId("engagement-card-eng-moab")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-boulder")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-unresolved")).toBeTruthy();

    fireEvent.click(screen.getByTestId("engagements-filter-in-pilot"));

    // Only the Moab pilot row survives the filter.
    expect(screen.getByTestId("engagement-card-eng-moab")).toBeTruthy();
    expect(screen.queryByTestId("engagement-card-eng-boulder")).toBeNull();
    expect(screen.queryByTestId("engagement-card-eng-unresolved")).toBeNull();

    // Toggling back off restores every row — proves the filter is a
    // pure render-time mask, not a destructive mutation of the query
    // data.
    fireEvent.click(screen.getByTestId("engagements-filter-in-pilot"));
    expect(screen.getByTestId("engagement-card-eng-boulder")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-unresolved")).toBeTruthy();
  });
});
