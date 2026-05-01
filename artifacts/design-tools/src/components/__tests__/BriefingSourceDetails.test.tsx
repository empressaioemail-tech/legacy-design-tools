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

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

const { BriefingSourceDetails } = await import("../BriefingSourceDetails");

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
