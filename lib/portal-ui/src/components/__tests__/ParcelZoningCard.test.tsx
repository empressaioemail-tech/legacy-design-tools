/**
 * ParcelZoningCard — locks the three rendering branches:
 * populated, unsupported-jurisdiction (Boston-style), and no-geocode.
 *
 * Fixtures use the canonical adapter attribute keys exported from
 * `@workspace/adapters` (ACRES, ZONE_CODE / ZONING, ZONE_DESC,
 * FLD_ZONE) so the test mirrors what the live local-tier adapters
 * actually emit.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  EngagementBriefing,
  EngagementBriefingSource,
} from "@workspace/api-client-react";
import { ParcelZoningCard } from "../ParcelZoningCard";

function mkSource(
  over: Partial<EngagementBriefingSource> &
    Pick<EngagementBriefingSource, "id" | "sourceKind" | "layerKind">,
): EngagementBriefingSource {
  return {
    id: over.id,
    layerKind: over.layerKind,
    sourceKind: over.sourceKind,
    provider: over.provider ?? null,
    snapshotDate: over.snapshotDate ?? "2026-04-15T00:00:00.000Z",
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
    createdAt: over.createdAt ?? "2026-04-16T00:00:00.000Z",
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  } as EngagementBriefingSource;
}

function mkBriefing(
  sources: EngagementBriefingSource[],
): EngagementBriefing {
  return {
    id: "brf-1",
    engagementId: "eng-1",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    sources,
    narrative: null,
  } as EngagementBriefing;
}

const bastropParcelSource = mkSource({
  id: "src-parcel",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-parcels",
  provider: "Bastrop County GIS",
  snapshotDate: "2026-04-20T00:00:00.000Z",
  payload: {
    kind: "parcel",
    parcel: {
      attributes: {
        PARCEL_ID: "R12345",
        ACRES: 0.5,
      },
    },
  },
});

const bastropZoningSource = mkSource({
  id: "src-zoning",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-zoning",
  provider: "Bastrop County Zoning",
  snapshotDate: "2026-04-18T00:00:00.000Z",
  payload: {
    kind: "zoning",
    zoning: {
      attributes: {
        ZONING: "R-1",
        ZONE_DESC: "Single-Family Residential",
      },
    },
  },
});

const bastropFloodplainSource = mkSource({
  id: "src-flood",
  sourceKind: "local-adapter",
  layerKind: "bastrop-tx-floodplain",
  provider: "Bastrop County GIS",
  payload: {
    kind: "floodplain",
    inMappedFloodplain: true,
    features: [{ attributes: { FLD_ZONE: "AE" } }],
  },
});

describe("ParcelZoningCard", () => {
  describe("populated state", () => {
    it("renders parcel id, zoning code+label, lot area, overlay chip, and provenance", () => {
      render(
        <ParcelZoningCard
          hasGeocode={true}
          zoningCodeFromSite={null}
          lotAreaSqftFromSite={null}
          briefing={mkBriefing([
            bastropParcelSource,
            bastropZoningSource,
            bastropFloodplainSource,
          ])}
          siteContextHref="/engagements/eng-1?tab=site-context"
        />,
      );

      const card = screen.getByTestId("parcel-zoning-card");
      expect(card).toHaveAttribute("data-state", "populated");

      // Parcel id is pulled from the local-tier parcel payload.
      expect(
        within(card).getByTestId("parcel-zoning-card-parcel-id"),
      ).toHaveTextContent("R12345");

      // Zoning row joins code + description with " · ".
      expect(
        within(card).getByTestId("parcel-zoning-card-zoning"),
      ).toHaveTextContent("R-1 · Single-Family Residential");

      // Lot area derives from acres * 43,560 (0.5 ac -> 21,780 sq ft)
      // and is formatted with thousands separators.
      expect(
        within(card).getByTestId("parcel-zoning-card-lot-area"),
      ).toHaveTextContent("21,780 sq ft");

      // Overlay chip surfaces the FLD_ZONE from the first feature.
      const overlays = within(card).getByTestId(
        "parcel-zoning-card-overlays",
      );
      expect(
        within(overlays).getByTestId("parcel-zoning-card-overlay-floodplain-in"),
      ).toHaveTextContent("In mapped floodplain (Zone AE)");

      // Provenance footer picks the most recent snapshot (parcel,
      // 2026-04-20) and surfaces its provider name.
      const provenance = within(card).getByTestId(
        "parcel-zoning-card-provenance",
      );
      expect(provenance).toHaveTextContent("Bastrop County GIS");
      expect(provenance).toHaveTextContent(/fetched/i);
    });

    it("prefers the engagement-site zoning code + lot area over the briefing-derived values", () => {
      render(
        <ParcelZoningCard
          hasGeocode={true}
          zoningCodeFromSite="R-2"
          lotAreaSqftFromSite={8400}
          briefing={mkBriefing([
            bastropParcelSource,
            bastropZoningSource,
          ])}
          siteContextHref="/engagements/eng-1?tab=site-context"
        />,
      );

      // Site-supplied "R-2" wins over briefing's "R-1", but the
      // briefing's description still appears alongside it.
      expect(
        screen.getByTestId("parcel-zoning-card-zoning"),
      ).toHaveTextContent("R-2 · Single-Family Residential");

      // Site-supplied 8400 sqft wins over the 21,780 derived from
      // the parcel acres payload.
      expect(
        screen.getByTestId("parcel-zoning-card-lot-area"),
      ).toHaveTextContent("8,400 sq ft");
    });
  });

  describe("unsupported-jurisdiction state", () => {
    it("renders the friendly fallback when the briefing has no parcel/zoning data (e.g. Boston)", () => {
      render(
        <ParcelZoningCard
          hasGeocode={true}
          zoningCodeFromSite={null}
          lotAreaSqftFromSite={null}
          briefing={mkBriefing([
            // A federal-tier FEMA reading is present but the
            // jurisdiction has no local-tier parcel/zoning adapter, so
            // the headline card has no parcel-id / zoning-code to
            // surface and falls back to the unsupported branch.
            mkSource({
              id: "src-fema",
              sourceKind: "federal-adapter",
              layerKind: "fema-nfhl-flood-zone",
              provider: "FEMA NFHL",
              payload: {
                kind: "flood-zone",
                floodZone: "X",
                inSpecialFloodHazardArea: false,
              },
            }),
          ])}
          siteContextHref="/engagements/eng-1?tab=site-context"
        />,
      );

      const card = screen.getByTestId("parcel-zoning-card");
      expect(card).toHaveAttribute("data-state", "unsupported");
      expect(
        screen.getByTestId("parcel-zoning-card-unsupported-message"),
      ).toHaveTextContent(
        /We don't have parcel and zoning data for this jurisdiction yet/i,
      );

      const link = screen.getByTestId("parcel-zoning-card-site-context-link");
      expect(link).toHaveAttribute(
        "href",
        "/engagements/eng-1?tab=site-context",
      );
      expect(link).toHaveTextContent("Site Context");

      // The structured rows / overlays / provenance footer must NOT
      // render in the unsupported branch.
      expect(
        screen.queryByTestId("parcel-zoning-card-parcel-id"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("parcel-zoning-card-overlays"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("parcel-zoning-card-provenance"),
      ).not.toBeInTheDocument();
    });

    it("falls back to the unsupported branch when the briefing is null but a geocode exists", () => {
      render(
        <ParcelZoningCard
          hasGeocode={true}
          zoningCodeFromSite={null}
          lotAreaSqftFromSite={null}
          briefing={null}
          siteContextHref="/engagements/eng-1?tab=site-context"
        />,
      );

      expect(screen.getByTestId("parcel-zoning-card")).toHaveAttribute(
        "data-state",
        "unsupported",
      );
    });
  });

  describe("no-geocode state", () => {
    it("renders the neutral 'Add an address' placeholder", () => {
      render(
        <ParcelZoningCard
          hasGeocode={false}
          zoningCodeFromSite={null}
          lotAreaSqftFromSite={null}
          briefing={null}
          siteContextHref="/engagements/eng-1?tab=site-context"
        />,
      );

      const card = screen.getByTestId("parcel-zoning-card");
      expect(card).toHaveAttribute("data-state", "no-geocode");
      expect(
        screen.getByTestId("parcel-zoning-card-no-geocode-message"),
      ).toHaveTextContent(/Add an address/i);

      // Structured rows + unsupported message must both stay hidden.
      expect(
        screen.queryByTestId("parcel-zoning-card-parcel-id"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("parcel-zoning-card-unsupported-message"),
      ).not.toBeInTheDocument();
    });
  });
});
