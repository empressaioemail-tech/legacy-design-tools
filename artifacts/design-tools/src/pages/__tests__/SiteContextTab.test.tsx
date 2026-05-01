/**
 * SiteContextTab — regression coverage for the empty-pilot-jurisdiction
 * banner introduced by Task #177.
 *
 * The Generate Layers POST returns a structured `422
 * no_applicable_adapters` envelope when the engagement's resolved
 * jurisdiction has no configured adapters (anything outside the three
 * pilot jurisdictions Bastrop TX, Moab UT, Salmon ID). Previously the
 * Site Context tab surfaced that response through the same
 * `generate-layers-error` banner as a real upstream failure, so an
 * architect on a Boulder CO project saw the raw `no_applicable_adapters`
 * slug with no hint that the cause was "this jurisdiction is not in the
 * pilot yet". The fix branches on the slug and renders a
 * `generate-layers-no-adapters-banner` with a CTA that opens the
 * existing `BriefingSourceUploadModal`.
 *
 * These tests pin three behaviors the visual design depends on:
 *
 *   1. A 422 `no_applicable_adapters` ApiError swaps the generic alert
 *      for the empty-pilot banner, surfaces the server's human-readable
 *      `message`, and keeps the upload-CTA wired to the modal toggle.
 *   2. Clicking the CTA opens the upload modal (asserted by the modal's
 *      unique `briefing-source-layer-kind` select-control id), proving
 *      the dead-end is actionable instead of confusing.
 *   3. A non-422 ApiError still falls through to the original
 *      `generate-layers-error` alert path so an upstream timeout is not
 *      silently re-styled as an empty-pilot prompt.
 *
 * The setup mirrors `EngagementDetail.test.tsx` (Task #126): hoisted
 * mocks for the generated React-Query hooks the page consumes, with
 * `useGenerateEngagementLayers` capturing the mutation options so each
 * test can manually fire `onError` with a fake `ApiError` shape (the
 * route would otherwise need a real fetch round-trip we cannot drive
 * under happy-dom). The `@workspace/site-context/client` SiteMap is
 * stubbed because the page module imports it unconditionally even
 * though the Site tab is not activated here.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  FEDERAL_PILOT_LAYER_KINDS,
  PILOT_JURISDICTION_COVERAGE,
  PILOT_JURISDICTIONS,
} from "@workspace/adapters";
import {
  createMutationCapture,
  createQueryKeyStubs,
  makeCapturingMutationHook,
  makeEngagementPageMockHooks,
  noopMutationHook,
} from "@workspace/portal-ui/test-utils";

// ── Hoisted fixture state ───────────────────────────────────────────────
//
// `generate.capturedOptions` is the seam every test drives through:
// the SiteContextTab passes its `mutation: { onError, onSuccess }`
// options to `useGenerateEngagementLayers`, the helper captures
// them, and each test fires `onError` with a fake ApiError to
// trigger the banner branches. The capture lives at module
// top-level (Task #382 shared `createMutationCapture` helper) so
// only the data fixture needs to stay inside `vi.hoisted`.
// Default fixture is a Moab UT engagement so the in-pilot pre-flight
// (Task #189) keeps the empty-pilot banner offscreen until a test
// fires the post-error path on its own. The proactive-banner tests
// below override this fixture before render to a Boulder CO
// engagement that pre-flights as out-of-pilot.
const hoisted = vi.hoisted(() => {
  return {
    engagement: {
      id: "eng-1",
      name: "Moab Pilot",
      jurisdiction: "Moab, UT",
      address: "100 Main St, Moab, UT",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      snapshotCount: 0,
      latestSnapshot: null,
      snapshots: [] as unknown[],
      site: {
        address: "100 Main St, Moab, UT",
        geocode: {
          latitude: 38.573,
          longitude: -109.5494,
          jurisdictionCity: "Moab",
          jurisdictionState: "UT",
          jurisdictionFips: "49019",
          source: "manual",
          geocodedAt: "2026-01-01T00:00:00.000Z",
        },
        projectType: null,
        zoningCode: null,
        lotAreaSqft: null,
      } as unknown,
      revitCentralGuid: null as string | null,
      revitDocumentPath: null as string | null,
    },
  };
});

const generate = createMutationCapture();

// useParams is consumed by the page from wouter; pin it to the seeded
// engagement id so we don't need a Router wrapper.
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useParams: () => ({ id: hoisted.engagement.id }),
  };
});

// Match the real generated constant the upload modal reads from so
// the form renders identically under happy-dom.
vi.mock("@workspace/api-zod", () => ({
  createEngagementSubmissionBodyNoteMax: 2048,
  recordSubmissionResponseBodyReviewerCommentMax: 2048,
}));

// Leaflet's CSS / image side-effects don't survive happy-dom; the
// page imports SiteMap unconditionally even though the Site tab is
// never activated here.
vi.mock("@workspace/site-context/client", () => ({
  SiteMap: () => null,
}));

// Stub every generated hook the page (and the SiteContextTab subtree)
// consumes. The two hooks that drive the test —
// `useGenerateEngagementLayers` and `useGetEngagementBriefing` — are
// wired explicitly: the former captures `mutation` options so each
// test can fire `onError` with a synthetic ApiError, the latter
// returns an empty briefing through real `useQuery` so the
// briefing-sources placeholder paints.
vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    // Shared engagement-page hook bag (Task #398) — provides the
    // dozen identical engagement / submissions / session / snapshot
    // / atom hooks plus `RecordSubmissionResponseBodyStatus`,
    // `ApiError`, and the standard query-key helpers every
    // engagement-page test wires up identically. Submissions
    // accessor omitted so the helper's empty-list default applies
    // (this test never asserts against the submissions tab).
    ...(await makeEngagementPageMockHooks({
      engagement: () => hoisted.engagement,
    })),
    // File-specific query-key helpers the SiteContextTab subtree
    // pulls in for briefing / divergences / generation-status caches
    // — not part of the shared engagement-page bag because they're
    // only relevant to tests that mount the Site Context tab.
    ...createQueryKeyStubs([
      "getGetEngagementBriefingQueryKey",
      "getListEngagementBriefingSourcesQueryKey",
      "getListBimModelDivergencesQueryKey",
      "getGetEngagementBriefingGenerationStatusQueryKey",
    ] as const),
    // SiteContextTab — the briefing read backs the empty-state
    // placeholder and the tier-grouped source rows. An empty
    // briefing keeps the SiteContextTab in its "no sources yet"
    // shape so the only banners visible during these tests are the
    // ones the Generate Layers mutation drives.
    useGetEngagementBriefing: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBriefing", id] as const),
        queryFn: async () => ({ briefing: null }),
      }),
    useListEngagementBriefingSources: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementBriefingSources", id] as const),
        queryFn: async () => [],
      }),
    useGetEngagementBriefingGenerationStatus: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["getEngagementBriefingGenerationStatus", id] as const),
        queryFn: async () => ({ status: "idle" }),
      }),
    useGenerateEngagementBriefing: noopMutationHook,
    // Task #230 — BriefingNarrativePanel mounts the Recent runs
    // disclosure unconditionally. The disclosure only fetches when
    // the auditor opens it, but the hook is still consulted on
    // every render to register the `enabled: false` query, so
    // an inert stub is required to keep the panel from blowing up
    // on this test surface (which never opens the disclosure).
    getListEngagementBriefingGenerationRunsQueryKey: (id: string) => [
      "listEngagementBriefingGenerationRuns",
      id,
    ],
    useListEngagementBriefingGenerationRuns: (
      id: string,
      opts?: {
        query?: { queryKey?: readonly unknown[]; enabled?: boolean };
      },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listEngagementBriefingGenerationRuns", id] as const),
        queryFn: async () => ({ runs: [] }),
        enabled: opts?.query?.enabled ?? true,
      }),
    // The upload-modal subtree uses this hook even though no submit
    // happens during the test — without a stub the modal blows up
    // with "No 'useCreateEngagementBriefingSource' export defined" the
    // moment the CTA opens it.
    useCreateEngagementBriefingSource: noopMutationHook,
    useRestoreEngagementBriefingSource: noopMutationHook,
    useRetryBriefingSourceConversion: noopMutationHook,
    // The hook under test — capture the mutation options so each
    // test can synthesize an ApiError and fire `onError` directly,
    // bypassing the real fetch round-trip.
    useGenerateEngagementLayers: makeCapturingMutationHook(generate),
    // PushToRevitAffordance is mounted inside SiteContextTab and
    // pulls these three hooks on every render. None of them affect
    // the empty-pilot banner under test, so we hand back inert
    // shapes that keep the affordance in its idle "no bim model"
    // state instead of asserting against it.
    ...createQueryKeyStubs([
      "getGetEngagementBimModelQueryKey",
      "getGetBimModelRefreshQueryKey",
    ] as const),
    useGetEngagementBimModel: (
      id: string,
      opts?: { query?: { queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getEngagementBimModel", id] as const),
        queryFn: async () => ({ bimModel: null }),
      }),
    useGetBimModelRefresh: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ?? (["getBimModelRefresh", id] as const),
        queryFn: async () => null,
        enabled: opts?.query?.enabled ?? false,
      }),
    usePushEngagementBimModel: noopMutationHook,
    useListBimModelDivergences: (
      id: string,
      opts?: { query?: { enabled?: boolean; queryKey?: readonly unknown[] } },
    ) =>
      useQuery({
        queryKey:
          opts?.query?.queryKey ??
          (["listBimModelDivergences", id] as const),
        queryFn: async () => ({ divergences: [] }),
        enabled: opts?.query?.enabled ?? false,
      }),
  };
});

const { EngagementDetail, GenerateLayersSummaryBanner } = await import(
  "../EngagementDetail"
);

/**
 * Build the minimum-viable shape `SiteContextTab#onError` reads from.
 * The page never calls `instanceof ApiError`; it only reaches into
 * `.data.error` (the slug) and `.data.message` (the human-readable
 * copy) on the thrown error, falling back to `.message` on the Error
 * itself. Constructing a plain Error here keeps the test agnostic to
 * the real `ApiError` constructor signature (which takes a Response,
 * not a status int) so the unit test does not have to fabricate a
 * fetch Response under happy-dom just to drive the error branches.
 */
function makeApiErrorLike(
  status: number,
  data: { error: string; message: string },
): Error & { status: number; data: { error: string; message: string } } {
  const err = new Error(data.message) as Error & {
    status: number;
    data: { error: string; message: string };
  };
  err.status = status;
  err.data = data;
  return err;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  const client = makeQueryClient();
  // Pre-seed the caches the page reads on first paint so it lands
  // fully rendered before we drive the Site Context tab.
  client.setQueryData(["getEngagement", hoisted.engagement.id], {
    ...hoisted.engagement,
  });
  client.setQueryData(["listEngagements"], [{ ...hoisted.engagement }]);
  client.setQueryData(["getSession"], { permissions: [] as string[] });
  // The page reads the active tab from `?tab=…` once on mount, so
  // landing directly on the Site Context tab keeps these tests focused
  // on the SiteContextTab subtree.
  window.history.replaceState(null, "", "/?tab=site-context");
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <EngagementDetail />
    </QueryClientProvider>
  );
  const utils = render(node);
  return { ...utils, client };
}

beforeEach(() => {
  hoisted.engagement = {
    id: "eng-1",
    name: "Moab Pilot",
    jurisdiction: "Moab, UT",
    address: "100 Main St, Moab, UT",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snapshotCount: 0,
    latestSnapshot: null,
    snapshots: [],
    site: {
      address: "100 Main St, Moab, UT",
      geocode: {
        latitude: 38.573,
        longitude: -109.5494,
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        jurisdictionFips: "49019",
        source: "manual",
        geocodedAt: "2026-01-01T00:00:00.000Z",
      },
      projectType: null,
      zoningCode: null,
      lotAreaSqft: null,
    },
    revitCentralGuid: null,
    revitDocumentPath: null,
  };
  generate.reset();
});

afterEach(() => {
  cleanup();
  // Restore the URL so a leftover `?tab=site-context` from one test
  // does not bleed into subsequent describe blocks.
  window.history.replaceState(null, "", "/");
});

describe("SiteContextTab Generate Layers fallback (Task #177)", () => {
  it("renders the empty-pilot-jurisdiction banner when the server returns 422 no_applicable_adapters", async () => {
    renderPage();

    // The Generate Layers button is only mounted on the Site Context
    // tab; if it isn't visible the page didn't honor the `?tab=` deep
    // link and the rest of the assertions would be confusingly false.
    expect(screen.getByTestId("generate-layers-button")).toBeVisible();

    // Sanity: nothing has fired yet, both banners are absent.
    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("generate-layers-error"),
    ).not.toBeInTheDocument();

    // Drive the failure path through the captured mutation options.
    // Mirroring the real `customFetch` shape: an ApiError carrying the
    // `{ error, message }` envelope on `.data`, with a status of 422.
    expect(generate.capturedOptions?.mutation?.onError).toBeDefined();
    const serverMessage =
      'No adapters configured for jurisdiction "CO" / "Boulder".';
    act(() => {
      generate.capturedOptions!.mutation!.onError!(
        makeApiErrorLike(422, {
          error: "no_applicable_adapters",
          message: serverMessage,
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    // The empty-pilot banner replaces the generic alert.
    const banner = screen.getByTestId("generate-layers-no-adapters-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    expect(
      screen.getByTestId("generate-layers-no-adapters-message"),
    ).toHaveTextContent(serverMessage);
    // Headline + manual-upload guidance copy must be present so the
    // architect can act on the banner without reading the details.
    expect(
      screen.getByText(/No adapters configured for this jurisdiction yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Upload a QGIS overlay below to seed the briefing manually\./i,
      ),
    ).toBeInTheDocument();
    // The generic error alert must NOT also be rendered — a future
    // regression that left both banners up would double-clutter the
    // tab.
    expect(
      screen.queryByTestId("generate-layers-error"),
    ).not.toBeInTheDocument();
  });

  it("opens the BriefingSourceUploadModal when the banner CTA is clicked", () => {
    renderPage();

    // The upload modal has no top-level testid, but the layer-kind
    // select control is uniquely owned by the modal — its absence
    // before the CTA click and presence after is the cleanest proof
    // that the modal mounted.
    expect(
      document.getElementById("briefing-source-layer-kind"),
    ).toBeNull();

    act(() => {
      generate.capturedOptions!.mutation!.onError!(
        makeApiErrorLike(422, {
          error: "no_applicable_adapters",
          message:
            "Could not resolve a pilot jurisdiction from this engagement's site context.",
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    const cta = screen.getByTestId("generate-layers-no-adapters-upload");
    fireEvent.click(cta);

    // Modal is now mounted — the layer-kind select is its anchor.
    expect(
      document.getElementById("briefing-source-layer-kind"),
    ).not.toBeNull();
  });

  it("does not pick the empty-pilot banner when the slug appears at a non-422 status", () => {
    // Defense-in-depth check: the route's contract pairs the
    // `no_applicable_adapters` slug with a 422 specifically. A
    // hypothetical future failure that happens to wrap the same
    // slug at a different status (e.g. a 500 with the same string
    // surfaced from an inner exception path) must not accidentally
    // re-style as the actionable empty-pilot prompt — that would
    // hide a real outage behind upload CTAs. The render branch
    // requires both keys to match, so this case must land on the
    // generic alert instead.
    renderPage();

    act(() => {
      generate.capturedOptions!.mutation!.onError!(
        makeApiErrorLike(500, {
          error: "no_applicable_adapters",
          message: "Internal failure that happened to share the slug",
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("generate-layers-error")).toHaveTextContent(
      "Internal failure that happened to share the slug",
    );
  });

  /**
   * Task #232 — the supported-jurisdictions disclosure must render
   * before any Generate Layers click. Task #188 already lists the
   * pilot set inside the empty-pilot banner, but the banner only
   * appears *after* a click + 422 round-trip on out-of-pilot
   * projects. An architect scoping a Boulder CO project would still
   * waste a click before discovering the systemic dead-end. The
   * pre-click disclosure closes that gap.
   *
   * The assertion iterates `PILOT_JURISDICTIONS` directly so a future
   * adapter addition extends the visible set without touching this
   * test, and any drift between the disclosure and the registry
   * breaks here instead of hiding behind stale copy.
   */
  it("renders the supported-jurisdictions disclosure with the pilot list before any Generate Layers click", () => {
    renderPage();

    // Sanity: the disclosure is mounted on first paint, with no
    // mutation having fired. Both error/banner surfaces must stay
    // absent so this test is unambiguously about the pre-click
    // state.
    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("generate-layers-error"),
    ).not.toBeInTheDocument();

    const disclosure = screen.getByTestId(
      "generate-layers-supported-jurisdictions",
    );
    expect(disclosure).toBeInTheDocument();
    // The summary trigger names the count so an architect can size
    // the dead-end at a glance — three pilot jurisdictions today
    // (Bastrop TX, Moab UT, Salmon ID), so a future addition would
    // bump this without breaking the assertion.
    expect(
      within(disclosure).getByTestId(
        "generate-layers-supported-jurisdictions-summary",
      ),
    ).toHaveTextContent(
      `Supported jurisdictions (${PILOT_JURISDICTIONS.length})`,
    );
    // Sanity: at least one entry — guards against a future
    // refactor that empties the registry but keeps the disclosure
    // shell. The pre-click surface is meaningless if the list is
    // empty.
    expect(PILOT_JURISDICTIONS.length).toBeGreaterThan(0);
    const list = within(disclosure).getByTestId(
      "generate-layers-supported-jurisdictions-list",
    );
    for (const j of PILOT_JURISDICTIONS) {
      expect(list).toHaveTextContent(j.label);
    }

    // Task #253 — per-jurisdiction coverage. Each pilot row exposes
    // its own testid and lists the layer-kinds Generate Layers will
    // fetch for that jurisdiction (e.g. Bastrop, TX → tceq-edwards-
    // aquifer + bastrop-tx-parcels + bastrop-tx-zoning + bastrop-tx-
    // floodplain). Iterating `PILOT_JURISDICTION_COVERAGE` here pins
    // the visible layer-kind set to the same registry the server's
    // `appliesTo` gate filters on — adding a new state/local adapter
    // automatically extends the assertion without a test edit.
    for (const cov of PILOT_JURISDICTION_COVERAGE) {
      const row = within(list).getByTestId(
        `generate-layers-supported-coverage-${cov.localKey}`,
      );
      expect(row).toHaveTextContent(cov.shortLabel);
      // Sanity: we don't ship a pilot jurisdiction with zero state +
      // local adapters — the disclosure would read meaninglessly.
      expect(cov.layers.length).toBeGreaterThan(0);
      for (const layer of cov.layers) {
        expect(row).toHaveTextContent(layer.layerKind);
      }
    }

    // Federal-tier adapters ungate (they fire for every pilot
    // jurisdiction), so the disclosure surfaces them once at the top
    // rather than repeating them under every row. The assertion
    // iterates `FEDERAL_PILOT_LAYER_KINDS` so a future federal adapter
    // automatically extends the visible set without a copy edit here.
    expect(FEDERAL_PILOT_LAYER_KINDS.length).toBeGreaterThan(0);
    const federal = within(list).getByTestId(
      "generate-layers-supported-jurisdictions-federal",
    );
    expect(federal).toHaveTextContent("Always-on federal layers:");
    for (const layerKind of FEDERAL_PILOT_LAYER_KINDS) {
      expect(federal).toHaveTextContent(layerKind);
    }
  });

  /**
   * Companion check: when the empty-pilot banner *does* render
   * (post-click 422), it must surface the same pilot labels the
   * pre-click disclosure already exposed. The two surfaces share
   * the `PILOT_JURISDICTIONS` source, so this guards against a
   * future refactor that forks one of them onto a separate copy.
   */
  it("post-click empty-pilot banner exposes the same labels as the pre-click disclosure", () => {
    renderPage();

    const preClickList = screen.getByTestId(
      "generate-layers-supported-jurisdictions-list",
    );
    for (const j of PILOT_JURISDICTIONS) {
      expect(preClickList).toHaveTextContent(j.label);
    }

    act(() => {
      generate.capturedOptions!.mutation!.onError!(
        makeApiErrorLike(422, {
          error: "no_applicable_adapters",
          message:
            'No adapters configured for jurisdiction "CO" / "Boulder".',
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    const postClickList = screen.getByTestId(
      "generate-layers-no-adapters-supported",
    );
    for (const j of PILOT_JURISDICTIONS) {
      expect(postClickList).toHaveTextContent(j.label);
    }
    // The pre-click disclosure stays mounted alongside the banner —
    // the two surfaces are intentionally additive (banner is the
    // actionable upload prompt, disclosure is the always-on
    // reference) so an architect on a non-pilot project can still
    // see the supported set after acting on the banner.
    expect(
      screen.getByTestId("generate-layers-supported-jurisdictions"),
    ).toBeInTheDocument();
  });

  it("falls through to the generic generate-layers-error alert for non-422 failures", () => {
    renderPage();

    // A 500 with an `internal_error` envelope is the canonical
    // "upstream actually failed" shape; it must keep landing in the
    // existing alert banner so an architect can tell a real outage
    // apart from an out-of-pilot dead-end.
    act(() => {
      generate.capturedOptions!.mutation!.onError!(
        makeApiErrorLike(500, {
          error: "internal_error",
          message: "Failed to run adapters",
        }),
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    const alert = screen.getByTestId("generate-layers-error");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Failed to run adapters");
    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
  });
});

/**
 * Task #229 — fixture rows for the GenerateLayersSummaryBanner unit
 * tests. Builds a `GenerateLayersOutcome` with sensible defaults so
 * each test can override only the keys it cares about (status,
 * fromCache). The shape mirrors the OpenAPI contract — the route
 * always sets `fromCache: false` and `cachedAt: null` for non-`ok`
 * outcomes, so the helper enforces that invariant by clamping
 * those keys whenever `status !== "ok"`.
 */
function makeOutcome(
  overrides: Partial<{
    adapterKey: string;
    status: "ok" | "no-coverage" | "failed";
    fromCache: boolean;
    cachedAt: string | null;
  }> = {},
) {
  const status = overrides.status ?? "ok";
  const isOk = status === "ok";
  return {
    adapterKey: overrides.adapterKey ?? "fixture:layer",
    tier: "federal" as const,
    sourceKind: "federal-adapter" as const,
    layerKind: "fixture-layer",
    status,
    sourceId: isOk ? "src-fixture" : null,
    fromCache: isOk ? (overrides.fromCache ?? false) : false,
    cachedAt: isOk ? (overrides.cachedAt ?? null) : null,
  } as unknown as Parameters<typeof GenerateLayersSummaryBanner>[0]["outcomes"][number];
}

describe("GenerateLayersSummaryBanner (Task #229)", () => {
  // Stable reference clock for the relative-time assertions below.
  // happy-dom's `Date.now()` reads from the real system clock by
  // default; pinning it lets the "12 minutes ago" / "just now"
  // text be asserted exactly instead of with a tolerance window.
  const now = new Date("2026-05-01T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides itself entirely when no Generate Layers run has resolved yet", () => {
    // Initial page-load shape: `lastRunAt` is still null (no
    // mutation has succeeded) and the outcomes array is empty.
    // The banner must not render at all so first-time visitors
    // don't see a "Last run never" placeholder.
    const { container } = render(
      <GenerateLayersSummaryBanner
        outcomes={[]}
        lastRunAt={null}
        isRefreshing={false}
        onForceRefresh={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("generate-layers-summary-banner"),
    ).not.toBeInTheDocument();
    // Defense-in-depth: nothing at all rendered, not even a
    // wrapper element. A future refactor that renders an empty
    // `<div role="status" />` would still violate the "hide
    // entirely" contract; this catches that.
    expect(container.firstChild).toBeNull();
  });

  it("hides when lastRunAt is set but the outcomes array is empty", () => {
    // Defense-in-depth for the second hide guard: even if state
    // got hydrated such that `lastRunAt` exists without
    // outcomes, the banner has nothing meaningful to summarize
    // and must stay hidden.
    render(
      <GenerateLayersSummaryBanner
        outcomes={[]}
        lastRunAt={now}
        isRefreshing={false}
        onForceRefresh={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("generate-layers-summary-banner"),
    ).not.toBeInTheDocument();
  });

  it("renders the freshness label, cache ratio, and Force refresh CTA against a fixture", () => {
    // Mixed-fixture: 5 outcomes, 4 ok layers, 3 of those served
    // from cache, plus one no-coverage and one failed that must
    // be excluded from the ratio. Pinning `lastRunAt` 12
    // minutes before `now` exercises the long-form
    // `formatRunAgeLabel` minute branch ("12 minutes ago").
    const lastRunAt = new Date(now.getTime() - 12 * 60_000);
    render(
      <GenerateLayersSummaryBanner
        outcomes={[
          makeOutcome({ adapterKey: "fed:flood", fromCache: true }),
          makeOutcome({ adapterKey: "fed:wetlands", fromCache: true }),
          makeOutcome({ adapterKey: "state:zoning", fromCache: true }),
          makeOutcome({ adapterKey: "local:setbacks", fromCache: false }),
          makeOutcome({ adapterKey: "fed:fault", status: "no-coverage" }),
          makeOutcome({ adapterKey: "state:water", status: "failed" }),
        ]}
        lastRunAt={lastRunAt}
        isRefreshing={false}
        onForceRefresh={() => {}}
      />,
    );

    const banner = screen.getByTestId("generate-layers-summary-banner");
    expect(banner).toBeInTheDocument();
    // role=status keeps the banner in the polite live region so
    // screen readers announce the freshness change after a run
    // without trapping focus.
    expect(banner).toHaveAttribute("role", "status");
    // Full sentence assertion — "Last run 12 minutes ago — 3 of
    // 4 layers served from cache." — pins both the relative-time
    // helper output and the cache-ratio (only ok outcomes count
    // toward the denominator; failed/no-coverage are excluded).
    expect(banner).toHaveTextContent(
      /Last run 12 minutes ago.*3 of 4 layers served from cache\./,
    );
    expect(
      screen.getByTestId("generate-layers-summary-banner-force-refresh"),
    ).toBeInTheDocument();
  });

  it("renders 'just now' for sub-minute runs and 'hours ago' for older ones", () => {
    // Sub-minute (just-resolved) reads "Last run just now".
    const { rerender } = render(
      <GenerateLayersSummaryBanner
        outcomes={[makeOutcome({ fromCache: false })]}
        lastRunAt={new Date(now.getTime() - 5_000)}
        isRefreshing={false}
        onForceRefresh={() => {}}
      />,
    );
    expect(
      screen.getByTestId("generate-layers-summary-banner"),
    ).toHaveTextContent(/Last run just now/);
    // 1-of-1 wording is singular ("1 layer", not "1 layers").
    expect(
      screen.getByTestId("generate-layers-summary-banner"),
    ).toHaveTextContent(/0 of 1 layer served from cache\./);

    // Same component, swap to a 3-hour-old run; the long-form
    // "hours ago" branch (>=60min, <48h) renders.
    rerender(
      <GenerateLayersSummaryBanner
        outcomes={[makeOutcome({ fromCache: true })]}
        lastRunAt={new Date(now.getTime() - 3 * 60 * 60_000)}
        isRefreshing={false}
        onForceRefresh={() => {}}
      />,
    );
    expect(
      screen.getByTestId("generate-layers-summary-banner"),
    ).toHaveTextContent(/Last run 3 hours ago/);
  });

  it("omits the cache-ratio sentence when no outcome reached status=ok", () => {
    // All outcomes failed or had no coverage — there are no
    // "layers" to count, so the cache-count sub-span must be
    // suppressed. The freshness label still renders so the user
    // knows a run happened, but adding "0 of 0 layers served
    // from cache" would read as a confusing zero-divisor stat.
    render(
      <GenerateLayersSummaryBanner
        outcomes={[
          makeOutcome({ adapterKey: "fed:flood", status: "failed" }),
          makeOutcome({ adapterKey: "state:zoning", status: "no-coverage" }),
        ]}
        lastRunAt={new Date(now.getTime() - 60_000)}
        isRefreshing={false}
        onForceRefresh={() => {}}
      />,
    );
    expect(
      screen.getByTestId("generate-layers-summary-banner"),
    ).toHaveTextContent(/Last run 1 minute ago/);
    expect(
      screen.queryByTestId("generate-layers-summary-banner-cache-count"),
    ).not.toBeInTheDocument();
  });

  it("invokes onForceRefresh when the banner CTA is clicked, and disables it while refreshing", () => {
    // Wiring check: the CTA must call the same forceRefresh
    // mutation the controls header already exposes (Task #204).
    // The test asserts the banner's onForceRefresh callback
    // fires exactly once per click — equivalent to the
    // `generateMutation.mutate({ params: { forceRefresh: true } })`
    // call the SiteContextTab passes in.
    const onForceRefresh = vi.fn();
    const { rerender } = render(
      <GenerateLayersSummaryBanner
        outcomes={[makeOutcome({ fromCache: true })]}
        lastRunAt={now}
        isRefreshing={false}
        onForceRefresh={onForceRefresh}
      />,
    );
    const cta = screen.getByTestId(
      "generate-layers-summary-banner-force-refresh",
    );
    expect(cta).not.toBeDisabled();
    fireEvent.click(cta);
    expect(onForceRefresh).toHaveBeenCalledTimes(1);

    // While the mutation is in flight the CTA must disable
    // itself so a double-click cannot kick off a second
    // overlapping run.
    rerender(
      <GenerateLayersSummaryBanner
        outcomes={[makeOutcome({ fromCache: true })]}
        lastRunAt={now}
        isRefreshing={true}
        onForceRefresh={onForceRefresh}
      />,
    );
    expect(
      screen.getByTestId("generate-layers-summary-banner-force-refresh"),
    ).toBeDisabled();
  });

  it("appears in the SiteContextTab after a successful Generate Layers run resolves", async () => {
    // Integration check: the banner is wired into the page's
    // mutation onSuccess callback, so firing onSuccess with a
    // fixture response should mount it. This verifies the
    // SiteContextTab passes the right `lastRunAt` / `outcomes`
    // through, not just that the standalone component works.
    renderPage();

    // Sanity: nothing rendered yet before any run.
    expect(
      screen.queryByTestId("generate-layers-summary-banner"),
    ).not.toBeInTheDocument();

    expect(generate.capturedOptions?.mutation?.onSuccess).toBeDefined();
    await act(async () => {
      await generate.capturedOptions!.mutation!.onSuccess!(
        {
          briefing: null,
          outcomes: [
            makeOutcome({ adapterKey: "fed:flood", fromCache: true }),
            makeOutcome({ adapterKey: "fed:wetlands", fromCache: false }),
          ],
        },
        { id: hoisted.engagement.id },
        undefined,
      );
    });

    const banner = screen.getByTestId("generate-layers-summary-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(
      /Last run just now.*1 of 2 layers served from cache\./,
    );
  });
});

/**
 * Pre-flight pilot-eligibility tests (Task #189).
 *
 * The Site Context tab evaluates jurisdiction eligibility from the
 * cached engagement record on render — no Generate Layers click is
 * required for the empty-pilot banner to appear when the engagement
 * resolves outside the three pilot jurisdictions. These tests pin
 * three behaviors:
 *
 *   1. Boulder CO (out-of-pilot) renders the empty-pilot banner
 *      proactively, with the same shared message helper the server's
 *      422 envelope uses, and disables the Generate Layers button so
 *      no wasted POST round-trip can fire.
 *   2. The disabled button carries the same human-readable message
 *      as a `title` tooltip so a hover before the architect's eye
 *      reaches the banner still surfaces the cause.
 *   3. Moab UT (in-pilot) leaves the button enabled and the banner
 *      offscreen — the proactive gate is jurisdiction-driven, not a
 *      catch-all that breaks the happy path.
 */
describe("SiteContextTab Generate Layers pre-flight (Task #189)", () => {
  it("disables Generate Layers and renders the empty-pilot banner proactively for an out-of-pilot engagement", () => {
    // Boulder CO: not in any of the three DA-PI-4 pilots
    // (Bastrop TX, Moab UT, Salmon ID). The cached engagement
    // record carries the city/state columns the resolver consults,
    // so the proactive gate flips to "out of pilot" without the
    // mutation ever firing.
    hoisted.engagement = {
      ...hoisted.engagement,
      jurisdiction: "Boulder, CO",
      address: "100 Walnut St, Boulder, CO 80302",
      site: {
        address: "100 Walnut St, Boulder, CO 80302",
        geocode: {
          latitude: 40.0149,
          longitude: -105.2705,
          jurisdictionCity: "Boulder",
          jurisdictionState: "CO",
          jurisdictionFips: "08013",
          source: "manual",
          geocodedAt: "2026-01-01T00:00:00.000Z",
        },
        projectType: null,
        zoningCode: null,
        lotAreaSqft: null,
      },
    };

    renderPage();

    // The proactive banner is up before any click — that's the
    // entire point of Task #189: the architect doesn't have to
    // discover the dead-end through a wasted POST.
    const banner = screen.getByTestId("generate-layers-no-adapters-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    // Pre-flight message comes from the shared
    // `noApplicableAdaptersMessage` helper the server route uses,
    // so the FE pre-flight copy and the BE 422 copy cannot drift.
    // Boulder resolves to no `stateKey`, so the helper yields the
    // "could not resolve a pilot jurisdiction" branch.
    expect(
      screen.getByTestId("generate-layers-no-adapters-message"),
    ).toHaveTextContent(/Could not resolve a pilot jurisdiction/i);
    // The actionable manual-upload guidance must render alongside
    // the headline so the dead-end is immediately recoverable.
    expect(
      screen.getByText(/No adapters configured for this jurisdiction yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Upload a QGIS overlay below to seed the briefing manually\./i,
      ),
    ).toBeInTheDocument();

    // Generate Layers button is disabled — no wasted round-trip.
    const button = screen.getByTestId(
      "generate-layers-button",
    ) as HTMLButtonElement;
    expect(button).toBeDisabled();
    // Tooltip surfaces the same shared message so a hover reveals
    // the cause without scrolling to the banner.
    expect(button).toHaveAttribute(
      "title",
      expect.stringMatching(/Could not resolve a pilot jurisdiction/i),
    );
    // The generic error alert must NOT also be rendered — the
    // proactive gate is exclusive of the post-error branch.
    expect(
      screen.queryByTestId("generate-layers-error"),
    ).not.toBeInTheDocument();
  });

  it("leaves the Generate Layers button enabled and the banner absent for an in-pilot engagement", () => {
    // Default fixture is Moab UT — keep it as-is. This test is the
    // happy-path counter-assertion: the proactive gate must not
    // false-fire on an in-pilot engagement (would block every
    // architect from running the layers).
    renderPage();

    expect(
      screen.queryByTestId("generate-layers-no-adapters-banner"),
    ).not.toBeInTheDocument();
    const button = screen.getByTestId(
      "generate-layers-button",
    ) as HTMLButtonElement;
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      expect.stringMatching(/Run every applicable federal\/state\/local/i),
    );
  });
});
