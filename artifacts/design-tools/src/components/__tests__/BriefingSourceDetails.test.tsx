/**
 * BriefingSourceDetails — the "View layer details" expander on the
 * Site Context tab. Tests focus on:
 *   - rendering structured payload for each known `kind`
 *   - extracting the jurisdiction key from the packed `provider`
 *     string and matching the reported zoning district to the right
 *     setback row (case-insensitive)
 *   - graceful "no match" hint when the district isn't in the table
 *
 * The setback fetch is stubbed by mocking `useGetLocalSetbackTable`
 * directly, which sidesteps needing a QueryClient + MSW for a test
 * focused on render logic.
 */

import {
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EngagementBriefingSource } from "@workspace/api-client-react";

const setbackHook = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  return {
    ...actual,
    // Stub: returns whatever shape the surrounding test set on
    // `setbackHook.state`. The real hook also exposes a queryKey, but
    // the component never reads it.
    useGetLocalSetbackTable: () => setbackHook.state,
    getGetLocalSetbackTableQueryKey: (k: string) => [
      "/local/setbacks",
      k,
    ],
  };
});

const {
  BriefingSourceDetails,
  formatFederalSummaryMarkdown,
  formatSetbackSummaryMarkdown,
} = await import("../BriefingSourceDetails");

function mkSource(
  over: Partial<EngagementBriefingSource> &
    Pick<EngagementBriefingSource, "id">,
): EngagementBriefingSource {
  return {
    id: over.id,
    layerKind: over.layerKind ?? "zoning",
    sourceKind: over.sourceKind ?? "local-adapter",
    provider: over.provider ?? null,
    snapshotDate: over.snapshotDate ?? "2026-01-01T00:00:00.000Z",
    note: over.note ?? null,
    uploadObjectPath: over.uploadObjectPath ?? "",
    uploadOriginalFilename: over.uploadOriginalFilename ?? "",
    uploadContentType: over.uploadContentType ?? "",
    uploadByteSize: over.uploadByteSize ?? 0,
    dxfObjectPath: over.dxfObjectPath ?? null,
    glbObjectPath: over.glbObjectPath ?? null,
    conversionStatus: over.conversionStatus ?? null,
    conversionError: over.conversionError ?? null,
    payload: over.payload ?? {},
    createdAt: over.createdAt ?? "2026-01-02T00:00:00.000Z",
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  };
}

describe("BriefingSourceDetails", () => {
  it("renders parcel id from a parcel-kind payload", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-parcel",
          layerKind: "parcels",
          sourceKind: "federal-adapter",
          provider: "us-tiger:parcels (TIGER)",
          payload: {
            kind: "parcel",
            parcel: {
              attributes: {
                PARCEL_ID: "R0123456",
                Acres: 1.42,
                OWNER: "JOHN DOE",
              },
            },
          },
        })}
      />,
    );
    expect(screen.getByText("PARCEL_ID")).toBeInTheDocument();
    expect(screen.getByText("R0123456")).toBeInTheDocument();
    expect(screen.getByText("Acres")).toBeInTheDocument();
    expect(screen.getByText("1.42")).toBeInTheDocument();
  });

  it("renders FEMA flood-zone fields from a floodplain payload", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-flood",
          layerKind: "floodplain",
          sourceKind: "federal-adapter",
          provider: "us-fema:floodplain (FEMA NFHL)",
          payload: {
            kind: "floodplain",
            inMappedFloodplain: true,
            features: [
              {
                attributes: {
                  FLD_ZONE: "AE",
                  FIRM_PANEL: "48055C0210F",
                  EFF_DATE: 1389312000000,
                },
              },
            ],
          },
        })}
      />,
    );
    expect(
      screen.getByText("In mapped FEMA floodplain"),
    ).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("FLD_ZONE")).toBeInTheDocument();
    expect(screen.getByText("AE")).toBeInTheDocument();
    expect(screen.getByText("FIRM_PANEL")).toBeInTheDocument();
    expect(screen.getByText("48055C0210F")).toBeInTheDocument();
    expect(screen.getByText("EFF_DATE")).toBeInTheDocument();
  });

  it("renders the matched setback row for a local-tier zoning payload", () => {
    setbackHook.state = {
      data: {
        jurisdictionKey: "grand-county-ut",
        jurisdictionDisplayName: "Grand County, UT (Moab area)",
        districts: [
          {
            district_name: "RR-1 Rural Residential",
            front_ft: 30,
            rear_ft: 25,
            side_ft: 15,
            side_corner_ft: 25,
            max_height_ft: 32,
            max_lot_coverage_pct: 30,
            max_impervious_pct: 40,
            citation_url: "https://example.test/code",
          },
          {
            district_name: "RR-2 Rural Residential",
            front_ft: 30,
            rear_ft: 25,
            side_ft: 15,
            side_corner_ft: 25,
            max_height_ft: 32,
            max_lot_coverage_pct: 25,
            max_impervious_pct: 35,
            citation_url: "https://example.test/code",
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-zoning",
          layerKind: "zoning",
          sourceKind: "local-adapter",
          provider: "grand-county-ut:zoning (Grand County, UT GIS)",
          payload: {
            kind: "zoning",
            zoning: {
              attributes: {
                ZONE_DIST: "rr-1 rural residential",
              },
            },
          },
        })}
      />,
    );
    // Setback panel rendered for the right jurisdiction.
    expect(
      screen.getByTestId("briefing-source-setbacks-src-zoning"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Grand County, UT \(Moab area\)/),
    ).toBeInTheDocument();
    // The matched row's stats are visible (front/rear/side/etc).
    expect(screen.getByText("30 ft")).toBeInTheDocument(); // front
    expect(screen.getByText("32 ft")).toBeInTheDocument(); // height
    expect(screen.getByText("30%")).toBeInTheDocument(); // max coverage
    // The non-matching district's distinguishing values must NOT
    // appear (RR-2 has 25% coverage / 35% impervious).
    expect(screen.queryByText("25%")).toBeNull();
  });

  it("shows a 'no match' hint when the reported district isn't in the table", () => {
    setbackHook.state = {
      data: {
        jurisdictionKey: "grand-county-ut",
        jurisdictionDisplayName: "Grand County, UT (Moab area)",
        districts: [
          {
            district_name: "RR-1 Rural Residential",
            front_ft: 30,
            rear_ft: 25,
            side_ft: 15,
            side_corner_ft: 25,
            max_height_ft: 32,
            max_lot_coverage_pct: 30,
            max_impervious_pct: 40,
            citation_url: "https://example.test/code",
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-zoning-nomatch",
          layerKind: "zoning",
          sourceKind: "local-adapter",
          provider: "grand-county-ut:zoning (Grand County, UT GIS)",
          payload: {
            kind: "zoning",
            zoning: {
              attributes: { ZONE_DIST: "Some Unmapped District" },
            },
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        /No row in the grand-county-ut setback table matched/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders the FEMA flood-zone summary (zone + SFHA) from a flood-zone payload", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fema",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA National Flood Hazard Layer (NFHL)",
          // Mirrors the `kind: "flood-zone"` payload the FEMA NFHL
          // adapter persists (lib/adapters/src/federal/fema-nfhl.ts).
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: true,
            floodZone: "AE",
            zoneSubtype: null,
            baseFloodElevation: 432,
            features: [{ attributes: { FLD_ZONE: "AE" } }],
          },
        })}
      />,
    );
    expect(screen.getByText("FEMA flood zone")).toBeInTheDocument();
    expect(screen.getByText("AE")).toBeInTheDocument();
    expect(screen.getByText("Special Flood Hazard Area")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("Base flood elevation")).toBeInTheDocument();
    expect(screen.getByText("432 ft")).toBeInTheDocument();
  });

  it("renders the snapshot date + provider footer beneath a federal flood-zone summary (Task #209)", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fema-prov",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA National Flood Hazard Layer (NFHL)",
          // Stamped at noon UTC so toLocaleDateString lands on the
          // same calendar day in every test runner timezone.
          snapshotDate: "2026-03-15T12:00:00.000Z",
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: true,
            floodZone: "AE",
            features: [{ attributes: { FLD_ZONE: "AE" } }],
          },
        })}
      />,
    );
    const footer = screen.getByTestId(
      "briefing-source-provenance-src-fema-prov",
    );
    // The footer reuses the same `formatSnapshotDate` helper the
    // federal-summary markdown digest uses (Task #210), which slices
    // the ISO snapshot to its `YYYY-MM-DD` head — timezone-stable
    // across runners.
    expect(footer).toHaveTextContent("as of 2026-03-15");
    expect(footer).toHaveTextContent(
      "source: FEMA National Flood Hazard Layer (NFHL)",
    );
  });

  it("renders the snapshot date + provider footer beneath a non-federal zoning summary (Task #221)", () => {
    // No setback table — keeps the footer assertion isolated from the
    // setback panel below it, while still exercising the local-tier
    // zoning case the task calls out by name.
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 404 },
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-zoning-prov",
          layerKind: "zoning",
          sourceKind: "local-adapter",
          provider: "grand-county-ut:zoning (Grand County, UT GIS)",
          snapshotDate: "2026-04-02T12:00:00.000Z",
          payload: {
            kind: "zoning",
            zoning: { attributes: { ZONE_DIST: "RR-1" } },
          },
        })}
      />,
    );
    const footer = screen.getByTestId(
      "briefing-source-provenance-src-zoning-prov",
    );
    expect(footer).toHaveTextContent("as of 2026-04-02");
    expect(footer).toHaveTextContent(
      "source: grand-county-ut:zoning (Grand County, UT GIS)",
    );
  });

  it("renders the FEMA flood-zone graceful empty hint when the parcel is unmapped", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fema-empty",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA National Flood Hazard Layer (NFHL)",
          // The "no mapped flood zone" branch the FEMA adapter takes
          // when the ArcGIS feature list comes back empty.
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: false,
            floodZone: null,
            features: [],
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        /Parcel does not intersect a mapped FEMA flood zone/i,
      ),
    ).toBeInTheDocument();
  });

  it("does not render a setback panel for federal-adapter rows", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fed-zoning",
          layerKind: "zoning",
          sourceKind: "federal-adapter",
          provider: "us-tiger:zoning (TIGER)",
          payload: {
            kind: "zoning",
            zoning: { attributes: { ZONING: "C-1" } },
          },
        })}
      />,
    );
    expect(
      screen.queryByTestId("briefing-source-setbacks-src-fed-zoning"),
    ).toBeNull();
    // Highlighted attribute still rendered.
    expect(screen.getByText("ZONING")).toBeInTheDocument();
    expect(screen.getByText("C-1")).toBeInTheDocument();
  });
});

describe("formatFederalSummaryMarkdown", () => {
  it("formats a FEMA NFHL flood-zone payload as a one-line markdown digest", () => {
    const md = formatFederalSummaryMarkdown(
      mkSource({
        id: "src-fema",
        sourceKind: "federal-adapter",
        snapshotDate: "2026-01-01T00:00:00.000Z",
        payload: {
          kind: "flood-zone",
          inSpecialFloodHazardArea: true,
          floodZone: "AE",
          zoneSubtype: null,
          baseFloodElevation: 432,
          features: [{ attributes: { FLD_ZONE: "AE" } }],
        },
      }),
    );
    expect(md).toBe(
      "**FEMA NFHL** — Zone AE, in SFHA, BFE 432 ft — snapshot 2026-01-01",
    );
  });

  it("formats the FEMA NFHL 'no mapped flood zone' branch", () => {
    const md = formatFederalSummaryMarkdown(
      mkSource({
        id: "src-fema-empty",
        sourceKind: "federal-adapter",
        snapshotDate: "2026-02-15T12:00:00.000Z",
        payload: {
          kind: "flood-zone",
          inSpecialFloodHazardArea: false,
          floodZone: null,
          features: [],
        },
      }),
    );
    expect(md).toBe(
      "**FEMA NFHL** — no mapped flood zone (treat as Zone X) — snapshot 2026-02-15",
    );
  });

  it("formats an FCC broadband-availability payload", () => {
    const md = formatFederalSummaryMarkdown(
      mkSource({
        id: "src-fcc",
        sourceKind: "federal-adapter",
        snapshotDate: "2026-03-20T00:00:00.000Z",
        payload: {
          kind: "broadband-availability",
          providerCount: 3,
          fastestDownstreamMbps: 1000,
          fastestUpstreamMbps: 35,
        },
      }),
    );
    expect(md).toBe(
      "**FCC** — 3 providers, 1000 Mbps down, 35 Mbps up — snapshot 2026-03-20",
    );
  });

  it("returns null for a non-federal kind so the copy button stays hidden", () => {
    const md = formatFederalSummaryMarkdown(
      mkSource({
        id: "src-zoning",
        sourceKind: "local-adapter",
        payload: {
          kind: "zoning",
          zoning: { attributes: { ZONING: "C-1" } },
        },
      }),
    );
    expect(md).toBeNull();
  });
});

describe("BriefingSourceDetails federal copy-summary button", () => {
  it("writes the markdown digest to the clipboard when clicked", async () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    // Re-stub navigator.clipboard fresh so a previous test's mock can't
    // leak in (mirrors DevAtomsProbe.test.tsx's pattern).
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });

    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fema-copy",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA National Flood Hazard Layer (NFHL)",
          snapshotDate: "2026-01-01T00:00:00.000Z",
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: true,
            floodZone: "AE",
            zoneSubtype: null,
            baseFloodElevation: 432,
            features: [{ attributes: { FLD_ZONE: "AE" } }],
          },
        })}
      />,
    );

    const button = screen.getByTestId(
      "briefing-source-copy-summary-src-fema-copy",
    );
    expect(button).toHaveTextContent("Copy summary");
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "**FEMA NFHL** — Zone AE, in SFHA, BFE 432 ft — snapshot 2026-01-01",
      );
    });
    await waitFor(() => {
      expect(button).toHaveTextContent("Copied!");
    });
  });

  it("does not render a copy-summary button for non-federal payloads", () => {
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-parcel-nocopy",
          layerKind: "parcels",
          sourceKind: "federal-adapter",
          provider: "us-tiger:parcels (TIGER)",
          payload: {
            kind: "parcel",
            parcel: { attributes: { PARCEL_ID: "R0123456" } },
          },
        })}
      />,
    );
    expect(
      screen.queryByTestId(
        "briefing-source-copy-summary-src-parcel-nocopy",
      ),
    ).toBeNull();
  });
});

describe("formatSetbackSummaryMarkdown", () => {
  it("formats a Grand County, UT (Moab area) RR-1 row as a one-line markdown digest", () => {
    const md = formatSetbackSummaryMarkdown({
      jurisdictionDisplayName: "Grand County, UT (Moab area)",
      district: {
        district_name: "RR-1 Rural Residential",
        front_ft: 30,
        rear_ft: 25,
        side_ft: 15,
        side_corner_ft: 25,
        max_height_ft: 32,
        max_lot_coverage_pct: 30,
        max_impervious_pct: 40,
        citation_url: "https://example.test/code",
      },
      snapshotDate: "2026-01-01T00:00:00.000Z",
    });
    expect(md).toBe(
      "**Grand County, UT (Moab area)** — RR-1 Rural Residential — front 30 ft, rear 25 ft, side 15 ft, height 32 ft, max coverage 30% — snapshot 2026-01-01",
    );
  });

  it("drops the snapshot suffix when snapshotDate is missing", () => {
    const md = formatSetbackSummaryMarkdown({
      jurisdictionDisplayName: "Bastrop County, TX",
      district: {
        district_name: "C-1 Commercial",
        front_ft: 25,
        rear_ft: 10,
        side_ft: 10,
        side_corner_ft: 15,
        max_height_ft: 35,
        max_lot_coverage_pct: 50,
        max_impervious_pct: 65,
        citation_url: "",
      },
      snapshotDate: null,
    });
    expect(md).toBe(
      "**Bastrop County, TX** — C-1 Commercial — front 25 ft, rear 10 ft, side 10 ft, height 35 ft, max coverage 50%",
    );
  });
});

describe("BriefingSourceDetails setback copy-summary button", () => {
  it("writes the setback markdown digest to the clipboard when clicked", async () => {
    setbackHook.state = {
      data: {
        jurisdictionKey: "grand-county-ut",
        jurisdictionDisplayName: "Grand County, UT (Moab area)",
        districts: [
          {
            district_name: "RR-1 Rural Residential",
            front_ft: 30,
            rear_ft: 25,
            side_ft: 15,
            side_corner_ft: 25,
            max_height_ft: 32,
            max_lot_coverage_pct: 30,
            max_impervious_pct: 40,
            citation_url: "https://example.test/code",
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });

    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-zoning-copy",
          layerKind: "zoning",
          sourceKind: "local-adapter",
          provider: "grand-county-ut:zoning (Grand County, UT GIS)",
          snapshotDate: "2026-01-01T00:00:00.000Z",
          payload: {
            kind: "zoning",
            zoning: {
              attributes: { ZONE_DIST: "RR-1 Rural Residential" },
            },
          },
        })}
      />,
    );

    const button = screen.getByTestId(
      "briefing-source-copy-setback-src-zoning-copy",
    );
    expect(button).toHaveTextContent("Copy summary");
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "**Grand County, UT (Moab area)** — RR-1 Rural Residential — front 30 ft, rear 25 ft, side 15 ft, height 32 ft, max coverage 30% — snapshot 2026-01-01",
      );
    });
    await waitFor(() => {
      expect(button).toHaveTextContent("Copied!");
    });
  });

  it("does not render a copy-summary button when no setback row matched", () => {
    setbackHook.state = {
      data: {
        jurisdictionKey: "grand-county-ut",
        jurisdictionDisplayName: "Grand County, UT (Moab area)",
        districts: [
          {
            district_name: "RR-1 Rural Residential",
            front_ft: 30,
            rear_ft: 25,
            side_ft: 15,
            side_corner_ft: 25,
            max_height_ft: 32,
            max_lot_coverage_pct: 30,
            max_impervious_pct: 40,
            citation_url: "https://example.test/code",
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-zoning-nomatch-nocopy",
          layerKind: "zoning",
          sourceKind: "local-adapter",
          provider: "grand-county-ut:zoning (Grand County, UT GIS)",
          payload: {
            kind: "zoning",
            zoning: {
              attributes: { ZONE_DIST: "Some Unmapped District" },
            },
          },
        })}
      />,
    );
    expect(
      screen.queryByTestId(
        "briefing-source-copy-setback-src-zoning-nomatch-nocopy",
      ),
    ).toBeNull();
  });
});

describe("BriefingSourceDetails federal snapshot staleness badge", () => {
  // Pin a deterministic "now" so the badge math doesn't depend on the
  // wall clock — the per-dataset thresholds (FEMA: 12mo, FCC: 6mo,
  // USGS: 24mo, EJScreen: 18mo) live with the adapters in
  // lib/adapters/src/federal/*.ts and are the source of truth.
  const NOW = new Date("2026-05-01T00:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setbackHook.state = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the stale badge when a FEMA NFHL snapshot is older than 12 months", () => {
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fema-stale",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA National Flood Hazard Layer (NFHL)",
          // 14 calendar months before NOW — past the FEMA 12-month
          // window declared in lib/adapters/src/federal/fema-nfhl.ts.
          snapshotDate: "2025-03-01T12:00:00.000Z",
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: true,
            floodZone: "AE",
            features: [{ attributes: { FLD_ZONE: "AE" } }],
          },
        })}
      />,
    );
    const badge = screen.getByTestId(
      "briefing-source-federal-stale-src-fema-stale",
    );
    // Visible label includes the elapsed-months reading…
    expect(badge).toHaveTextContent("snapshot is 14 months old");
    // …and the screen-reader label names the dataset's window so the
    // warning isn't conveyed by color alone (Task #222 a11y note).
    expect(badge).toHaveAttribute(
      "aria-label",
      expect.stringContaining("freshness window is 12 months"),
    );
    // role="status" so an SR pings the staleness when the panel
    // expands without taking focus.
    expect(badge).toHaveAttribute("role", "status");
  });

  it("does not render the stale badge when the FEMA NFHL snapshot is fresh", () => {
    render(
      <BriefingSourceDetails
        source={mkSource({
          id: "src-fema-fresh",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA National Flood Hazard Layer (NFHL)",
          // 3 calendar months before NOW — well inside the 12-month
          // FEMA window.
          snapshotDate: "2026-02-01T12:00:00.000Z",
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: false,
            floodZone: "X",
            features: [{ attributes: { FLD_ZONE: "X" } }],
          },
        })}
      />,
    );
    expect(
      screen.queryByTestId("briefing-source-federal-stale-src-fema-fresh"),
    ).toBeNull();
    // Provenance footer still rendered so the "as of …" line stays
    // visible — only the stale-tag piece is suppressed.
    expect(
      screen.getByTestId(
        "briefing-source-federal-provenance-src-fema-fresh",
      ),
    ).toHaveTextContent("as of 2026-02-01");
  });
});
