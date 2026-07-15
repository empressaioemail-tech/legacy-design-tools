import { describe, expect, it } from "vitest";
import type { GenerateBriefingResult } from "@workspace/briefing-engine";
import type { GenerateOrchestratedFindingsResult } from "@workspace/finding-engine";
import {
  rehydrateSpineBriefingResult,
  rehydrateSpineFindingsResult,
  rehydrateSpineFetchUsgs3depDemResult,
  rehydrateSpineHydrologyWorkerResult,
  rehydrateSpineRainfallForcingSource,
} from "../engineSpineDeserialize";

describe("rehydrateSpineFindingsResult", () => {
  it("coerces ISO date strings on findings and generatedAt to Date", () => {
    const iso = "2026-06-11T05:50:24.000Z";
    const wire = {
      findings: [
        {
          atomId: "finding:sub:ABC",
          submissionId: "sub",
          severity: "concern",
          category: "egress",
          text: "test",
          citations: [],
          confidence: 0.8,
          lowConfidence: false,
          elementRef: null,
          sourceRef: null,
          aiGeneratedAt: iso,
        },
      ],
      invalidCitations: [],
      discardedFindings: [],
      generatedAt: iso,
      producer: "anthropic",
      orchestration: {
        orchestrated: true,
        disciplinesRun: ["building"],
        pieceCount: 1,
        deduplicatedCount: 0,
      },
    } as unknown as GenerateOrchestratedFindingsResult;
    const result = rehydrateSpineFindingsResult(wire);

    expect(result.generatedAt).toBeInstanceOf(Date);
    expect(result.findings[0]!.aiGeneratedAt).toBeInstanceOf(Date);
    expect(result.findings[0]!.aiGeneratedAt.toISOString()).toBe(iso);
  });

  it("passes through existing Date objects unchanged", () => {
    const now = new Date("2026-06-11T05:50:24.000Z");
    const result = rehydrateSpineFindingsResult({
      findings: [
        {
          atomId: "finding:sub:ABC",
          submissionId: "sub",
          severity: "concern",
          category: "egress",
          text: "test",
          citations: [],
          confidence: 0.8,
          lowConfidence: false,
          elementRef: null,
          sourceRef: null,
          aiGeneratedAt: now,
        },
      ],
      invalidCitations: [],
      discardedFindings: [],
      generatedAt: now,
      producer: "mock",
    });

    expect(result.generatedAt).toBe(now);
    expect(result.findings[0]!.aiGeneratedAt).toBe(now);
  });
});

describe("rehydrateSpineBriefingResult", () => {
  const sections = {
    a: "summary",
    b: "threshold",
    c: "gates",
    d: "infra",
    e: "envelope",
    f: "context",
    g: "checklist",
  };

  it("coerces ISO generatedAt string to Date", () => {
    const iso = "2026-06-11T14:28:43.000Z";
    const wire = {
      sections,
      invalidCitations: [],
      materializableElements: [],
      generatedAt: iso,
      generatedBy: "system:briefing-engine",
      producer: "anthropic",
    } as unknown as GenerateBriefingResult;

    const result = rehydrateSpineBriefingResult(wire);

    expect(result.generatedAt).toBeInstanceOf(Date);
    expect(result.generatedAt.toISOString()).toBe(iso);
  });

  it("passes through existing Date objects unchanged", () => {
    const now = new Date("2026-06-11T14:28:43.000Z");
    const result = rehydrateSpineBriefingResult({
      sections,
      invalidCitations: [],
      materializableElements: [],
      generatedAt: now,
      generatedBy: "user-1",
      producer: "mock",
    });

    expect(result.generatedAt).toBe(now);
  });
});

describe("hydrology/topography spine rehydration audit", () => {
  it("hydrology worker result is a no-op (no Date-typed persisted fields)", () => {
    const wire = {
      status: "ok",
      library: "pysheds",
      libraryVersion: "0.3",
      routing: "d8",
      accumulationThreshold: 50,
      drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
      flowLinesGeoJson: { type: "FeatureCollection", features: [] },
      rainfallResultGeoJson: null,
      pourPoint: { lng: -97.94, lat: 29.88 },
    } as const;
    expect(rehydrateSpineHydrologyWorkerResult(wire)).toBe(wire);
  });

  it("rainfall forcing result is a no-op (fetchedAt stays ISO string in JSON)", () => {
    const wire = {
      kind: "noaa-atlas-14",
      returnPeriodYears: 100,
      depthInches: 4,
      estimate: {
        lat: 29.88,
        lng: -97.94,
        source: "noaa-atlas-14-pfds",
        fetchedAt: "2026-06-11T14:28:08.000Z",
        designStorms: [],
        endpoint: "https://hdsc.nws.noaa.gov/cgi-bin/hdsc/new/cgi_readH5.py",
      },
    } satisfies import("@workspace/site-context/server").RainfallForcingSource;
    expect(rehydrateSpineRainfallForcingSource(wire)).toBe(wire);
  });

  it("USGS DEM fetch result is a no-op (fetchedAt is ISO string, not Date)", () => {
    const wire = {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/tiff",
      bbox: { westLng: -98, southLat: 29, eastLng: -97, northLat: 30 },
      resolutionMeters: 10,
      // Layer-0 coverage-honesty pair added to FetchUsgs3depDemResult:
      // requested is echoed, actual stays null on the exportImage path.
      resolutionMetersRequested: 10,
      resolutionMetersActual: null,
      widthPx: 100,
      heightPx: 100,
      endpoint: "spine:/v1/hydrology/dem",
      fetchedAt: "2026-06-11T14:28:08.000Z",
    } satisfies import("@workspace/site-context/server").FetchUsgs3depDemResult;
    expect(rehydrateSpineFetchUsgs3depDemResult(wire)).toBe(wire);
  });
});
