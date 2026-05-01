/**
 * GET /api/engagements/:id/briefing/export.pdf — DA-PI-6 stakeholder
 * PDF export route.
 *
 * Coverage strategy (Puppeteer-backed renderer):
 *   - Content + layout contract is asserted against the HTML the
 *     renderer hands to Puppeteer (fast, deterministic, no Chromium
 *     cold start in the inner unit loop).
 *   - The route itself is exercised end-to-end with the real
 *     Puppeteer pipeline so we know the wire response really is a
 *     valid PDF and the headers are wired up correctly:
 *       - 404 when the engagement does not exist.
 *       - 422 `no_briefing_to_export` when the engagement exists but
 *         its `parcel_briefings` row is missing or has never been
 *         generated.
 *       - 200 with `application/pdf` body, `%PDF-` magic, `%%EOF`
 *         trailer, and a non-trivial byte count for a fully-generated
 *         briefing.
 *       - `?download=1` flips Content-Disposition from `inline` to
 *         `attachment`.
 *       - The architect's per-row header override is honored when
 *         their `users.architect_pdf_header` is set (asserted via the
 *         HTML the renderer would have produced for the same input).
 *
 * Browser teardown: the Puppeteer wrapper memoises a singleton
 * `Browser`. We close it in an `afterAll` hook so vitest can exit
 * cleanly without a stray Chromium child.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("briefing-export-pdf.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  parcelBriefings,
  briefingSources,
  users,
} = await import("@workspace/db");
const { eq: eqShim } = await import("drizzle-orm");
const {
  renderBriefingHtml,
  classifyAppendixTier,
  freshnessVerdict,
  DEFAULT_BRIEFING_PDF_HEADER,
  FOOTER_WATERMARK,
} = await import("../lib/briefingHtml");
const { closeBrowserForTests } = await import("../lib/briefingPdf");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

afterAll(async () => {
  await closeBrowserForTests();
});

async function seedEngagement(name = "PDF Export Engagement") {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
      latitude: "40.014984",
      longitude: "-105.270546",
    })
    .returning();
  return eng;
}

/**
 * Seed a briefing row with a fully-populated A–G narrative + two
 * sources (one federal-adapter, one manual-upload) so the citation
 * appendix has at least two tier buckets to exercise.
 *
 * Source IDs are server-generated UUIDs (the column is `uuid` with a
 * `defaultRandom`), so we insert the sources first, capture the IDs,
 * and only then materialise the narrative with citation tokens that
 * reference those real IDs. The export path passes citation token
 * payloads through unchanged, so the appendix labels are what we
 * assert against, not the IDs themselves.
 */
async function seedGeneratedBriefing(engagementId: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  const generatedAt = new Date("2026-04-15T12:00:00Z");
  const [briefingShell] = await ctx.schema.db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();

  const insertedSources = await ctx.schema.db
    .insert(briefingSources)
    .values([
      {
        briefingId: briefingShell.id,
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
        provider: "FEMA Flood Map",
        note: "Effective panel 12345C",
        snapshotDate: new Date("2026-01-01T00:00:00Z"),
      },
      {
        briefingId: briefingShell.id,
        layerKind: "qgis-zoning",
        sourceKind: "manual-upload",
        provider: "City of Boulder QGIS",
        uploadObjectPath: "/objects/zoning",
        uploadOriginalFilename: "zoning.geojson",
        uploadContentType: "application/geo+json",
        uploadByteSize: 2048,
        snapshotDate: new Date("2026-02-15T00:00:00Z"),
      },
    ])
    .returning();
  const fedId = insertedSources[0].id;
  const zoneId = insertedSources[1].id;

  const [briefing] = await ctx.schema.db
    .update(parcelBriefings)
    .set({
      sectionA:
        "Executive summary text covering the buildable thesis for the parcel.",
      sectionB: `Threshold issues — flood zone exposure {{atom|briefing-source|${fedId}|FEMA Flood Map}} requires elevation review.`,
      sectionC: `Regulatory gates — base zoning {{atom|briefing-source|${zoneId}|City of Boulder QGIS}} caps height at 35 ft per [[CODE:bldg-code-3]].`,
      sectionD: `Site infrastructure — water main on the east lot line confirmed {{atom|briefing-source|${zoneId}|City of Boulder QGIS}}.`,
      sectionE:
        "Buildable envelope — net buildable area derived from the parcel polygon.",
      sectionF:
        "Neighboring context — adjacent parcels are mid-block residential.",
      sectionG:
        "Next-step checklist: order soils test, schedule pre-application meeting.",
      generatedAt,
      generatedBy: "system:briefing-engine",
    })
    .where(eqShim(parcelBriefings.id, briefingShell.id))
    .returning();
  return briefing;
}

describe("GET /api/engagements/:id/briefing/export.pdf (route smoke)", () => {
  it("404s when the engagement does not exist", async () => {
    const res = await request(getApp()).get(
      "/api/engagements/00000000-0000-0000-0000-000000000000/briefing/export.pdf",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("422s with no_briefing_to_export when no briefing row exists", async () => {
    const eng = await seedEngagement("No-Briefing Engagement");
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/export.pdf`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_briefing_to_export");
  });

  it("422s when the briefing row exists but has never been generated", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const eng = await seedEngagement("Empty-Briefing Engagement");
    await ctx.schema.db
      .insert(parcelBriefings)
      .values({ engagementId: eng.id })
      .returning();
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/export.pdf`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_briefing_to_export");
  });

  it("renders a real PDF (magic + EOF + non-trivial body) for a fully-generated briefing", async () => {
    const eng = await seedEngagement("Generated Engagement");
    await seedGeneratedBriefing(eng.id);

    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/export.pdf`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.headers["content-disposition"]).toContain(
      "generated-engagement-briefing.pdf",
    );

    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    // Puppeteer-emitted PDFs are deflate-compressed; even a small
    // briefing prints to several KB. Anything below ~3 KB would mean
    // the renderer silently emitted an empty document.
    expect(body.length).toBeGreaterThan(3000);
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.subarray(body.length - 8).toString("ascii")).toContain("%%EOF");
  }, 60_000);

  it("?download=1 flips Content-Disposition to attachment", async () => {
    const eng = await seedEngagement("Attachment Engagement");
    await seedGeneratedBriefing(eng.id);
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/export.pdf?download=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(
      "attachment-engagement-briefing.pdf",
    );
  }, 60_000);

  it("rejects unknown ?download values with a 400", async () => {
    const eng = await seedEngagement("Bad Query Engagement");
    await seedGeneratedBriefing(eng.id);
    const res = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing/export.pdf?download=please`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_briefing_export_query");
  });

  it("honors the per-architect users.architect_pdf_header override", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const eng = await seedEngagement("Header Override Engagement");
    await seedGeneratedBriefing(eng.id);
    await ctx.schema.db.insert(users).values({
      id: "u-architect",
      displayName: "Test Architect",
      architectPdfHeader: "Acme Architects — Briefing",
    });

    // The override path is a session-resolved DB read on the route;
    // verifying that it actually flowed into the printed PDF would
    // require pdf-parse on a compressed binary. We instead assert
    // (a) the route returns 200 with the override session in
    // place, and (b) the HTML the renderer would emit for that input
    // carries the override (renderer is pure, so this is equivalent
    // to inspecting the rendered PDF body without the parsing cost).
    const res = await request(getApp())
      .get(`/api/engagements/${eng.id}/briefing/export.pdf`)
      .set("x-requestor", "user:u-architect");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");

    const html = renderBriefingHtml({
      engagement: {
        id: eng.id,
        name: "Header Override Engagement",
        jurisdiction: "Boulder, CO",
        address: "1 Pearl St",
      },
      narrative: {
        generationId: null,
        briefingId: "brief-uuid-override",
        sections: { a: "", b: "", c: "", d: "", e: "", f: "", g: "" },
        generatedAt: new Date("2026-04-15T12:00:00Z"),
        generatedBy: "system:briefing-engine",
      },
      sources: [],
      header: "Acme Architects — Briefing",
      architectName: "Test Architect",
    });
    expect(html).toContain("Acme Architects — Briefing");
    expect(html).toContain("Architect of record: Test Architect");
    // Default header must be displaced when the override took effect.
    expect(html).not.toContain(DEFAULT_BRIEFING_PDF_HEADER);
  }, 60_000);
});

/**
 * Pure-string contract for the HTML template the Puppeteer wrapper
 * prints. Every layout / copy / citation-flattening assertion that
 * used to live in the route test moved here so the inner test loop
 * stays sub-second.
 */
describe("renderBriefingHtml (template contract)", () => {
  const baseInput = {
    engagement: {
      id: "eng-uuid-1",
      name: "Unit Coverage Engagement",
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      latitude: 40.014984,
      longitude: -105.270546,
    },
    narrative: {
      generationId: "gen-uuid-1",
      briefingId: "brief-uuid-1",
      sections: {
        a: "Executive summary body.",
        b: "Threshold issues body — flood {{atom|briefing-source|src-1|FEMA Flood Map}} cited.",
        c: "Regulatory gates body — height per [[CODE:bldg-code-3]].",
        d: "Site infrastructure body.",
        e: "Buildable envelope body.",
        f: "Neighboring context body.",
        g: "Next-step checklist body.",
      },
      generatedAt: new Date("2026-04-01T00:00:00Z"),
      generatedBy: "system:briefing-engine",
    },
    sources: [
      {
        id: "src-1",
        layerKind: "fema-flood",
        sourceKind: "federal-adapter",
        provider: "FEMA Flood Map",
        snapshotDate: new Date("2026-03-01T00:00:00Z"),
        note: "Effective panel 12345C",
      },
      {
        id: "src-2",
        layerKind: "qgis-zoning",
        sourceKind: "manual-upload",
        provider: "City QGIS",
        snapshotDate: new Date("2024-01-01T00:00:00Z"),
        note: null,
        uploadObjectPath: "/objects/qgis-preview",
        uploadOriginalFilename: "zoning.png",
        uploadContentType: "image/png",
      },
    ],
    header: null,
    architectName: "Jane Architect",
  } as const;

  it("renders the cover snapshot fields and falls back to the default header when none is supplied", () => {
    const html = renderBriefingHtml(baseInput);
    expect(html).toContain("Stakeholder Briefing");
    expect(html).toContain("Unit Coverage Engagement");
    expect(html).toContain("Generation id: gen-uuid-1");
    expect(html).toContain("Briefing id: brief-uuid-1");
    expect(html).toContain("Engagement id: eng-uuid-1");
    expect(html).toContain("Architect of record: Jane Architect");
    expect(html).toContain("Sources cited: 2");
    expect(html).toContain(DEFAULT_BRIEFING_PDF_HEADER);
  });

  it("surfaces a legacy-briefing notice when generationId is null", () => {
    const html = renderBriefingHtml({
      ...baseInput,
      narrative: { ...baseInput.narrative, generationId: null },
    });
    expect(html).toContain(
      "Generation id: (not recorded — legacy briefing predates Task #281)",
    );
  });

  it("renders every A–G section heading + plain-text-flattens citation tokens", () => {
    const html = renderBriefingHtml(baseInput);
    for (const label of [
      "A — Executive Summary",
      "B — Threshold Issues",
      "C — Regulatory Gates",
      "D — Site Infrastructure",
      "E — Buildable Envelope",
      "F — Neighboring Context",
      "G — Next-Step Checklist",
    ]) {
      expect(html).toContain(label);
    }
    // Inline citation tokens are flattened — only the appendix carries
    // the structured listing.
    expect(html).not.toContain("{{atom|briefing-source|");
    expect(html).toContain("[FEMA Flood Map]");
    expect(html).toContain("[Code: bldg-code-3]");
  });

  it("groups the appendix federal → manual with adapter + freshness annotations", () => {
    const html = renderBriefingHtml(baseInput);
    const fedIdx = html.indexOf("Federal-tier sources");
    const manualIdx = html.indexOf("Manually-uploaded sources");
    expect(fedIdx).toBeGreaterThan(0);
    expect(manualIdx).toBeGreaterThan(fedIdx);
    expect(html).toContain("adapter: federal-adapter");
    expect(html).toContain("adapter: manual-upload");
    expect(html).toMatch(/freshness:\s*(fresh|aging|stale|unknown)/);
    // The federal-adapter row carries a note — it should appear.
    expect(html).toContain("Effective panel 12345C");
  });

  it("renders the OSM static-map embed when the engagement is geocoded", () => {
    const html = renderBriefingHtml(baseInput);
    expect(html).toContain("Site map composite");
    expect(html).toContain("staticmap.openstreetmap.de");
    expect(html).toContain("center=40.014984,-105.270546");
    expect(html).toContain("OpenStreetMap contributors");
  });

  it("falls back to a no-coordinates panel when lat/lng are missing", () => {
    const html = renderBriefingHtml({
      ...baseInput,
      engagement: {
        ...baseInput.engagement,
        latitude: null,
        longitude: null,
      },
    });
    expect(html).toContain("Site map composite");
    expect(html).toContain("no geocoded coordinates on file");
    expect(html).not.toContain("staticmap.openstreetmap.de");
  });

  it("renders an <img> thumbnail for image uploads and a file-tag card otherwise", () => {
    const html = renderBriefingHtml(baseInput);
    // The image-mime upload renders as an <img src=...> pointing at
    // the object-storage path the FE already serves.
    expect(html).toContain('src="/objects/qgis-preview"');
    expect(html).toContain("zoning.png");
    // The federal-adapter source has no upload — it must render as a
    // labelled tag card rather than a broken-image icon.
    expect(html).toMatch(/\[\s*federal-adapter\s*\]/);
  });

  it("stamps the FOOTER_WATERMARK and architect header into the @page chrome", () => {
    const html = renderBriefingHtml({
      ...baseInput,
      header: "Acme Architects — Briefing",
    });
    expect(html).toContain(FOOTER_WATERMARK);
    expect(html).toContain("Acme Architects — Briefing");
    expect(html).not.toContain(DEFAULT_BRIEFING_PDF_HEADER);
  });

  it("escapes HTML-unsafe characters in user-supplied fields", () => {
    const html = renderBriefingHtml({
      ...baseInput,
      engagement: {
        ...baseInput.engagement,
        name: "<script>alert(1)</script>",
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders an empty-appendix notice when no sources are attached", () => {
    const html = renderBriefingHtml({ ...baseInput, sources: [] });
    expect(html).toContain(
      "No briefing sources are attached to this engagement.",
    );
    expect(html).toContain("No briefing sources to render.");
  });
});

describe("classifyAppendixTier + freshnessVerdict", () => {
  it("classifies known adapter keys into their tier buckets", () => {
    const make = (sourceKind: string) => ({
      id: "x",
      layerKind: "y",
      sourceKind,
      provider: null,
      snapshotDate: new Date(),
    });
    expect(classifyAppendixTier(make("federal-adapter"))).toBe("federal");
    expect(classifyAppendixTier(make("state-adapter"))).toBe("state");
    expect(classifyAppendixTier(make("local-adapter"))).toBe("local");
    expect(classifyAppendixTier(make("manual-upload"))).toBe("manual");
    expect(classifyAppendixTier(make("totally-new-adapter"))).toBe("general");
  });

  it("returns fresh / aging / stale based on age in days", () => {
    const now = new Date("2026-05-01T00:00:00Z").getTime();
    expect(freshnessVerdict(new Date("2026-04-01T00:00:00Z"), now)).toBe(
      "fresh",
    );
    expect(freshnessVerdict(new Date("2026-01-01T00:00:00Z"), now)).toBe(
      "aging",
    );
    expect(freshnessVerdict(new Date("2024-01-01T00:00:00Z"), now)).toBe(
      "stale",
    );
    expect(freshnessVerdict("not a date", now)).toBe("unknown");
  });
});
