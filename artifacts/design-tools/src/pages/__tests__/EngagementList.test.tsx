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
import { createQueryKeyStubs } from "@workspace/portal-ui/test-utils";

/**
 * The fixture deliberately interleaves in-pilot and out-of-pilot
 * rows in *the same shape the API returns them*: `updatedAt desc`,
 * with no awareness of pilot status. The Boulder row is the most
 * recently updated, then Moab, then the unaddressed row. This lets
 * the Task #277 sort test prove the component re-orders the
 * out-of-pilot rows below the in-pilot one without losing the
 * within-group `updatedAt desc` order — Boulder must still appear
 * above the unaddressed row in the out-of-pilot tail.
 */
const ENGAGEMENTS: EngagementSummary[] = [
  mkEngagement({
    id: "eng-boulder",
    name: "Boulder Renovation",
    jurisdiction: "Boulder, CO",
    address: "200 Pearl St, Boulder, CO",
    updatedAt: "2026-04-20T00:00:00.000Z",
    geocode: {
      latitude: 40.015,
      longitude: -105.2705,
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
    },
  }),
  mkEngagement({
    id: "eng-moab",
    name: "Moab Pilot Project",
    jurisdiction: "Moab, UT",
    address: "100 Main St, Moab, UT",
    updatedAt: "2026-04-15T00:00:00.000Z",
    geocode: {
      latitude: 38.573,
      longitude: -109.5494,
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
    },
  }),
  mkEngagement({
    id: "eng-unresolved",
    name: "Unaddressed Project",
    jurisdiction: null,
    address: null,
    updatedAt: "2026-04-10T00:00:00.000Z",
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
    // Task #382: shared query-key stub helper from
    // `@workspace/portal-ui/test-utils`.
    ...createQueryKeyStubs(["getListEngagementsQueryKey"] as const),
  };
});

const { EngagementList } = await import("../EngagementList");

interface MakeOpts {
  id: string;
  name: string;
  jurisdiction: string | null;
  address: string | null;
  updatedAt?: string;
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
    updatedAt: o.updatedAt ?? "2026-04-15T00:00:00.000Z",
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

describe("EngagementList — empty-pilot pill (PL-04)", () => {
  it("renders the 'No adapters' pill only on rows whose engagement has no geocode", () => {
    renderList();

    // PL-04: Boulder CO is geocoded, so federal adapters apply and
    // the row is now treated as in-pilot. The pill must be absent.
    const boulderCard = screen.getByTestId("engagement-card-eng-boulder");
    expect(boulderCard.getAttribute("data-in-pilot")).toBe("true");
    expect(
      boulderCard.querySelector(
        "[data-testid='engagement-card-no-adapters-pill']",
      ),
    ).toBeNull();

    // The unaddressed row has no geocode at all — federal adapters
    // bail along with state/local, so this row is the genuine
    // no-applicable-adapters case the pill is meant to surface.
    const unresolvedCard = screen.getByTestId("engagement-card-eng-unresolved");
    expect(unresolvedCard.getAttribute("data-in-pilot")).toBe("false");
    const unresolvedPill = unresolvedCard.querySelector(
      "[data-testid='engagement-card-no-adapters-pill']",
    );
    expect(unresolvedPill).not.toBeNull();
    // Tooltip flows from the shared helper — under PL-04 the
    // no-geocode branch reads "Add an address …".
    expect(unresolvedPill?.getAttribute("title")).toBe(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: null, localKey: null },
        hasGeocode: false,
      }),
    );
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

  it("counts out-of-pilot (no-geocode) engagements in the header summary", () => {
    renderList();

    const tally = screen.getByTestId("engagements-out-of-pilot-tally");
    // PL-04: only the unaddressed row is "out of pilot" — Boulder
    // has a geocode and now picks up the federal four.
    expect(tally.textContent).toBe("1 out of pilot");
  });

  it("sorts in-pilot rows ahead of out-of-pilot rows while preserving 'updatedAt desc' within each group", () => {
    renderList();

    // PL-04: Boulder is in-pilot (federal-only). The two in-pilot
    // rows are sorted by `updatedAt desc` — Boulder (2026-04-20) ahead
    // of Moab (2026-04-15) — and the unaddressed row stays in the
    // out-of-pilot tail.
    const cards = document.querySelectorAll(
      "[data-testid^='engagement-card-eng-']",
    );
    const order = Array.from(cards).map((c) => c.getAttribute("data-testid"));
    expect(order).toEqual([
      "engagement-card-eng-boulder",
      "engagement-card-eng-moab",
      "engagement-card-eng-unresolved",
    ]);
  });

  it("filters out-of-pilot rows when 'Show only in-pilot' is toggled on", () => {
    renderList();

    // All three rows visible by default.
    expect(screen.getByTestId("engagement-card-eng-moab")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-boulder")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-unresolved")).toBeTruthy();

    fireEvent.click(screen.getByTestId("engagements-filter-in-pilot"));

    // Boulder + Moab survive; only the unaddressed row is hidden.
    expect(screen.getByTestId("engagement-card-eng-moab")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-boulder")).toBeTruthy();
    expect(screen.queryByTestId("engagement-card-eng-unresolved")).toBeNull();

    // Toggling back off restores every row — proves the filter is a
    // pure render-time mask, not a destructive mutation of the query
    // data.
    fireEvent.click(screen.getByTestId("engagements-filter-in-pilot"));
    expect(screen.getByTestId("engagement-card-eng-boulder")).toBeTruthy();
    expect(screen.getByTestId("engagement-card-eng-unresolved")).toBeTruthy();
  });
});
