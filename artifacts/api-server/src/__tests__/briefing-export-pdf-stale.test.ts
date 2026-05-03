/**
 * Pure-renderer tests for Task #468 stale-source annotations on the
 * exported briefing PDF. Kept in a standalone file (no `setupRouteTests`)
 * so they don't depend on the integration DB schema fixture used by the
 * sibling `briefing-export-pdf.test.ts` suite.
 */

import { describe, it, expect } from "vitest";
import {
  renderBriefingHtml,
  extractCitedSourceIds,
  staleAnnotationCopy,
  STALE_FOOTER_NOTE,
} from "../lib/briefingHtml";

const baseInput = {
  engagement: {
    id: "eng-uuid-stale",
    name: "Stale Source Engagement",
    jurisdiction: "Boulder, CO",
    address: "1 Pearl St",
    latitude: null,
    longitude: null,
  },
  narrative: {
    generationId: "gen-uuid-stale",
    briefingId: "brief-uuid-stale",
    sections: {
      a: "Executive summary body — no citations.",
      b: "Threshold issues body — flood {{atom|briefing-source|src-stale|FEMA Flood Map}} cited.",
      c: "Regulatory gates body — base zoning {{atom|briefing-source|src-fresh|City QGIS}} caps height.",
      d: "Site infrastructure body — water main confirmed {{atom|briefing-source|src-stale|FEMA Flood Map}} and {{atom|briefing-source|src-fresh|City QGIS}}.",
      e: "Buildable envelope body.",
      f: "Neighboring context body.",
      g: "Next-step checklist body.",
    },
    generatedAt: new Date("2026-04-01T00:00:00Z"),
    generatedBy: "system:briefing-engine",
  },
  sources: [
    {
      id: "src-stale",
      layerKind: "fema-flood",
      sourceKind: "federal-adapter",
      provider: "FEMA Flood Map",
      snapshotDate: new Date("2026-03-01T00:00:00Z"),
      note: null,
    },
    {
      id: "src-fresh",
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "City QGIS",
      snapshotDate: new Date("2026-03-01T00:00:00Z"),
      note: null,
    },
  ],
  header: null,
  architectName: null,
} as const;

describe("stale-source annotations on the exported PDF (Task #468)", () => {
  it("extractCitedSourceIds returns the unique briefing-source ids cited inline", () => {
    expect(extractCitedSourceIds(null)).toEqual([]);
    expect(extractCitedSourceIds("plain text — no citations")).toEqual([]);
    expect(
      extractCitedSourceIds(
        "two refs {{atom|briefing-source|s1|A}} and {{atom|briefing-source|s2|B}} and a dup {{atom|briefing-source|s1|A}}",
      ),
    ).toEqual(["s1", "s2"]);
  });

  it("staleAnnotationCopy matches the in-app chip wording exactly", () => {
    expect(staleAnnotationCopy(1)).toBe("1 source may be stale");
    expect(staleAnnotationCopy(3)).toBe("3 sources may be stale");
  });

  it("annotates only sections that cite at least one stale source — and stamps the cache-verdict footer note there", () => {
    const html = renderBriefingHtml({
      ...baseInput,
      staleSourceIds: ["src-stale"],
    });
    expect(html).toContain('data-testid="briefing-section-stale-b"');
    expect(html).toContain("1 source may be stale");
    expect(html).toContain('data-testid="briefing-section-stale-d"');
    expect(html).not.toContain('data-testid="briefing-section-stale-a"');
    expect(html).not.toContain('data-testid="briefing-section-stale-c"');
    expect(html).not.toContain('data-testid="briefing-section-stale-e"');
    expect(html).toContain(STALE_FOOTER_NOTE);
  });

  it("renders no annotation at all when staleSourceIds is omitted, empty, or only references unknown ids", () => {
    const baseline = renderBriefingHtml(baseInput);
    expect(baseline).not.toContain('data-testid="briefing-section-stale-');
    expect(baseline).not.toContain("may be stale");
    expect(baseline).not.toContain(STALE_FOOTER_NOTE);

    const empty = renderBriefingHtml({ ...baseInput, staleSourceIds: [] });
    expect(empty).not.toContain("may be stale");

    const unknown = renderBriefingHtml({
      ...baseInput,
      staleSourceIds: ["never-cited"],
    });
    expect(unknown).not.toContain('data-testid="briefing-section-stale-');
  });

  it("pluralises the chip when a section cites multiple distinct stale sources", () => {
    const input = {
      ...baseInput,
      narrative: {
        ...baseInput.narrative,
        sections: {
          ...baseInput.narrative.sections,
          d: "Two stale {{atom|briefing-source|src-stale|FEMA}} and {{atom|briefing-source|src-stale-2|City}}.",
        },
      },
      sources: [
        ...baseInput.sources,
        {
          id: "src-stale-2",
          layerKind: "qgis-zoning",
          sourceKind: "local-adapter",
          provider: "City Adapter",
          snapshotDate: new Date("2026-03-01T00:00:00Z"),
          note: null,
        },
      ],
      staleSourceIds: ["src-stale", "src-stale-2"],
    };
    const html = renderBriefingHtml(input);
    expect(html).toContain('data-testid="briefing-section-stale-d"');
    expect(html).toContain("2 sources may be stale");
  });
});
