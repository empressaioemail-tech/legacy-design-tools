/**
 * DA-PI-6 — Stakeholder Briefing HTML template.
 *
 * Pure-string HTML renderer for the stakeholder briefing. Lives in its
 * own module so it is testable without ever launching a browser: the
 * Puppeteer wrapper in {@link ./briefingPdf} simply navigates a
 * headless page to `data:text/html;base64,<this string>` and prints it
 * to PDF.
 *
 * Splitting the renderer this way buys us three things:
 *   1. The content/layout/copy contract is verified by fast unit
 *      tests against the returned HTML string — no Chromium cold
 *      start in CI.
 *   2. The browser process becomes a thin "render this HTML to PDF"
 *      adapter with no business logic of its own.
 *   3. The same HTML can be exposed verbatim from a future
 *      `/print/briefing/:id` debug route so designers can iterate on
 *      the layout without re-running the export pipeline.
 *
 * Page contract (fixed by the brief):
 *   1. Cover page — engagement name, jurisdiction, address, generation
 *      / briefing / engagement ids, generated metadata, exported-at.
 *   2. Table of Contents.
 *   3. Sections A–G — one per heading block, citation tokens replaced
 *      inline with plain-text "[Provider]" / "[Code: id]" labels per
 *      the brief's plain-text-citation contract.
 *   4. Citation appendix grouped federal → state → local → manual →
 *      general, each row tagged with adapter key, layer kind,
 *      snapshot date, and a freshness verdict.
 *   5. Site map composite — embeds a real OpenStreetMap static tile
 *      centred on the engagement's geocoded coordinates when present;
 *      falls back to a labelled "no coordinates on file" panel
 *      otherwise. (The brief's stretch goal of a live Cesium ortho
 *      composite ships in a follow-up sprint when the Cesium viewport
 *      lands; the layout slot is stable so the swap-in is mechanical.)
 *   6. Briefing-source thumbnails — embeds the actual uploaded
 *      preview image for sources that carry one, falling back to a
 *      labelled card for adapter-fed sources whose payload doesn't
 *      include a preview URL.
 *
 * Header + footer are stamped on every printed page via CSS `@page`
 * margin boxes (Puppeteer prints those into the page chrome).
 */

import {
  SECTION_LABELS,
  type BriefingSections,
} from "@workspace/briefing-engine";
import {
  BRIEFING_PDF_HEADER_TOKENS,
  DEFAULT_BRIEFING_PDF_HEADER,
} from "@workspace/briefing-pdf-tokens";

// Re-exported for the route + tests that already import the constant
// from this module. The single source of truth lives in
// `@workspace/briefing-pdf-tokens` so the Settings live preview
// can't drift from what an export actually prints.
export { DEFAULT_BRIEFING_PDF_HEADER };

/**
 * Footer watermark stamped on every printed page. The wording carries
 * the confidentiality + freshness disclaimer the brief asks for: the
 * PDF is a synthesised pre-design artefact, not an authoritative
 * regulatory record, and the recipient is expected to verify against
 * the cited primary sources before any binding decision.
 */
export const FOOTER_WATERMARK =
  "Pre-Design Briefing — Not a Survey or Engineering Document. Verify all data with authoritative sources before relying for design or compliance decisions.";

/**
 * Subset of the engagement row the renderer cares about. Keeping the
 * input shape minimal lets the route hand us only the columns it
 * already loads (no extra DB round trip). `latitude` / `longitude` are
 * optional; when present we render a real OSM static-tile map on the
 * site-map page.
 */
export interface PdfEngagement {
  id: string;
  name: string;
  jurisdiction?: string | null;
  address?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

/** Subset of a current briefing source the renderer cares about. */
export interface PdfBriefingSource {
  id: string;
  layerKind: string;
  sourceKind: string;
  provider: string | null;
  snapshotDate: string | Date;
  note?: string | null;
  /**
   * Object storage path of the architect's manually-uploaded source
   * file when one exists (`upload_object_path` on `briefing_sources`).
   * The thumbnail page renders this as an `<img>` tag for sources
   * whose content type is image-shaped; non-image uploads (DXF, GeoJSON,
   * PDF, …) get a labelled file-type card instead.
   */
  uploadObjectPath?: string | null;
  /** Original filename from the upload — surfaced on the thumbnail card. */
  uploadOriginalFilename?: string | null;
  /** Content type of the uploaded file (drives image-vs-file rendering). */
  uploadContentType?: string | null;
}

/** Subset of the parcel briefing row the renderer cares about. */
export interface PdfBriefingNarrative {
  /**
   * Per-run generation identifier — the
   * `parcel_briefings.generation_id` FK to the
   * `briefing_generation_jobs` row that produced the current
   * `section_a..g` body. Changes every time the briefing is
   * regenerated. NULL for legacy briefings whose producing job
   * was pruned before Task #281; the cover surfaces that
   * explicitly rather than fabricating an id.
   */
  generationId: string | null;
  /**
   * Stable identifier of the underlying `parcel_briefings` row —
   * surfaced alongside `generationId` so an operator can pull the
   * briefing up even after a regeneration has cycled the
   * generation id.
   */
  briefingId: string;
  sections: BriefingSections;
  generatedAt: Date | null;
  generatedBy: string | null;
}

export interface RenderBriefingHtmlInput {
  engagement: PdfEngagement;
  narrative: PdfBriefingNarrative;
  sources: ReadonlyArray<PdfBriefingSource>;
  /**
   * Per-architect header override resolved from
   * `users.architect_pdf_header`. Null/empty falls back to the default
   * header text.
   */
  header: string | null;
  /**
   * Display name of the architect who triggered the export, when the
   * request carried a resolved `user`-kind requestor. Surfaced on the
   * cover page as `Architect of record`. Null for anonymous /
   * system-driven exports.
   */
  architectName?: string | null;
}

const SECTION_ORDER: ReadonlyArray<keyof BriefingSections> = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
];

/**
 * Replace inline citation tokens with plain-text "[Label]" markers so
 * the rendered narrative reads as a stakeholder briefing rather than a
 * machine-readable transcript. The full grouped list of cited sources
 * lives in the appendix — these inline labels are pointers to it.
 *
 * Token grammar (mirrors `lib/briefing-engine/src/citationValidator.ts`):
 *   - {{atom|briefing-source|<id>|<displayLabel>}}
 *   - [[CODE:<atomId>]]
 */
const SOURCE_TOKEN = /\{\{atom\|briefing-source\|([^|}]+)\|([^}]+)\}\}/g;
const CODE_TOKEN = /\[\[CODE:([^\]]+)\]\]/g;

export function plainTextCitations(text: string): string {
  return text
    .replace(SOURCE_TOKEN, (_m, _id, label) => `[${String(label).trim()}]`)
    .replace(CODE_TOKEN, (_m, atom) => `[Code: ${String(atom).trim()}]`);
}

/**
 * Tier the citation appendix groups sources under. Mirrors the brief's
 * federal → state → local ordering with a `manual` tier appended for
 * architect uploads and a `general` catch-all so an unknown future
 * adapter `sourceKind` does not silently disappear.
 */
type AppendixTier = "federal" | "state" | "local" | "manual" | "general";

const APPENDIX_TIER_ORDER: ReadonlyArray<AppendixTier> = [
  "federal",
  "state",
  "local",
  "manual",
  "general",
];

const APPENDIX_TIER_LABELS: Readonly<Record<AppendixTier, string>> = {
  federal: "Federal-tier sources",
  state: "State-tier sources",
  local: "Local-tier sources",
  manual: "Manually-uploaded sources",
  general: "Other sources",
};

export function classifyAppendixTier(source: PdfBriefingSource): AppendixTier {
  const kind = source.sourceKind.toLowerCase();
  if (kind === "manual-upload") return "manual";
  if (kind === "federal-adapter") return "federal";
  if (kind === "state-adapter") return "state";
  if (kind === "local-adapter") return "local";
  return "general";
}

function groupSourcesForAppendix(
  sources: ReadonlyArray<PdfBriefingSource>,
): Record<AppendixTier, PdfBriefingSource[]> {
  const buckets: Record<AppendixTier, PdfBriefingSource[]> = {
    federal: [],
    state: [],
    local: [],
    manual: [],
    general: [],
  };
  for (const s of sources) buckets[classifyAppendixTier(s)].push(s);
  return buckets;
}

function formatSnapshotDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

/**
 * Plain-text freshness verdict shown next to each appendix row. The
 * brief asks for a freshness indicator alongside the snapshot date so
 * the stakeholder can tell at a glance whether the cited source is
 * recent (< 90 days), aging (90–365 days), or stale (> 365 days). The
 * thresholds are intentionally coarse — this is a human-readable
 * annotation, not a regulatory determination.
 */
export function freshnessVerdict(
  snapshotDate: string | Date,
  now: number,
): "fresh" | "aging" | "stale" | "unknown" {
  const d =
    snapshotDate instanceof Date ? snapshotDate : new Date(snapshotDate);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return "unknown";
  const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
  if (ageDays < 90) return "fresh";
  if (ageDays < 365) return "aging";
  return "stale";
}

/**
 * HTML escape — applied to every interpolated user value so a malicious
 * engagement name or briefing body cannot break out of the template.
 * Covers the standard XML entity set plus the single-quote variant.
 */
function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestamp(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function coerceCoordinate(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isImageMime(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("image/");
}

/** Render the full briefing as a single HTML document. */
export function renderBriefingHtml(input: RenderBriefingHtmlInput): string {
  const header =
    input.header && input.header.trim().length > 0
      ? input.header.trim()
      : DEFAULT_BRIEFING_PDF_HEADER;
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    renderHead(input, header),
    "<body>",
    renderCover(input),
    renderToc(),
    ...SECTION_ORDER.map((k) => renderSection(k, input.narrative.sections[k])),
    renderAppendix(input.sources),
    renderMap(input.engagement),
    renderThumbnailGrid(input.sources),
    "</body>",
    "</html>",
  ].join("\n");
}

function renderHead(input: RenderBriefingHtmlInput, header: string): string {
  const title = `Stakeholder Briefing — ${input.engagement.name}`;
  return `<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  @page {
    size: Letter;
    margin: 0.85in 0.7in 0.95in 0.7in;
    @top-left { content: "${esc(header)}"; font-family: ${BRIEFING_PDF_HEADER_TOKENS.fontFamily}; font-size: ${BRIEFING_PDF_HEADER_TOKENS.fontSize}; color: ${BRIEFING_PDF_HEADER_TOKENS.color}; }
    @bottom-center { content: "${esc(FOOTER_WATERMARK)}"; font-family: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif; font-size: 7.5pt; color: #555; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font-family: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif; font-size: 7.5pt; color: #888; }
  }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif;
    color: #111;
    font-size: 10.5pt;
    line-height: 1.45;
  }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 24pt; margin: 0 0 0.4em; font-weight: 600; }
  h2 { font-size: 16pt; margin: 0 0 0.6em; font-weight: 600; }
  h3 { font-size: 12pt; margin: 1.2em 0 0.4em; font-weight: 600; }
  .subtitle { font-size: 14pt; color: #444; margin: 0.2em 0; }
  .meta { color: #555; font-size: 10pt; line-height: 1.7; margin-top: 1.6em; }
  .meta div { margin: 0; }
  .toc { padding-left: 1.1em; }
  .toc li { margin: 0.25em 0; }
  .section-body { white-space: pre-wrap; }
  .appendix-empty { color: #555; }
  .appendix-tier { margin-bottom: 1.2em; }
  .appendix-row { margin: 0.35em 0 0.6em; padding-bottom: 0.35em; border-bottom: 1px dotted #ddd; }
  .appendix-row .label { font-weight: 600; }
  .appendix-row .meta-line { color: #555; font-size: 9.5pt; }
  .appendix-row .note { color: #444; font-size: 9.5pt; margin-top: 0.2em; }
  .freshness-fresh { color: #1f7a3a; }
  .freshness-aging { color: #b27a00; }
  .freshness-stale { color: #b1361b; }
  .freshness-unknown { color: #555; }
  .map-frame { width: 100%; height: 6in; border: 1px solid #ccc; border-radius: 4px; overflow: hidden; }
  .map-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .map-empty {
    width: 100%; height: 6in; border: 1px dashed #bbb; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    color: #777; font-size: 11pt;
  }
  .map-meta { color: #555; font-size: 9.5pt; margin-top: 0.6em; }
  .thumb-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25in;
    margin-top: 0.4in;
  }
  .thumb-card {
    border: 1px solid #ddd; border-radius: 3px; padding: 0.18in;
    page-break-inside: avoid;
  }
  .thumb-card .preview {
    width: 100%; height: 1.4in; background: #f4f4f4;
    border-radius: 2px; display: flex; align-items: center; justify-content: center;
    color: #888; font-size: 9pt; overflow: hidden;
  }
  .thumb-card .preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-card .label { font-weight: 600; font-size: 9.5pt; margin-top: 0.12in; }
  .thumb-card .meta { font-size: 8.5pt; color: #555; margin-top: 0.04in; }
</style>
</head>`;
}

function renderCover(input: RenderBriefingHtmlInput): string {
  const { engagement, narrative, architectName } = input;
  const generatedLine = narrative.generatedAt
    ? `Briefing generated: ${esc(formatTimestamp(narrative.generatedAt))}`
    : "Briefing generated: (not yet recorded)";
  const generationLine = narrative.generationId
    ? `Generation id: ${esc(narrative.generationId)}`
    : "Generation id: (not recorded — legacy briefing predates Task #281)";
  const architectLine =
    architectName && architectName.trim().length > 0
      ? `<div>Architect of record: ${esc(architectName.trim())}</div>`
      : "";
  const generatedByLine = narrative.generatedBy
    ? `<div>Generated by: ${esc(narrative.generatedBy)}</div>`
    : "";
  return `<section class="page" data-page="cover">
  <h1>Stakeholder Briefing</h1>
  <div class="subtitle">${esc(engagement.name)}</div>
  ${engagement.jurisdiction ? `<div class="subtitle">${esc(engagement.jurisdiction)}</div>` : ""}
  ${engagement.address ? `<div class="subtitle">${esc(engagement.address)}</div>` : ""}
  <div class="meta">
    <div>${generatedLine}</div>
    ${generatedByLine}
    ${architectLine}
    <div>${generationLine}</div>
    <div>Briefing id: ${esc(narrative.briefingId)}</div>
    <div>Engagement id: ${esc(engagement.id)}</div>
    <div>Sources cited: ${input.sources.length}</div>
    <div>Exported: ${esc(formatTimestamp(new Date()))}</div>
  </div>
</section>`;
}

function renderToc(): string {
  const items = [
    ...SECTION_ORDER.map(
      (k) => `${k.toUpperCase()} — ${SECTION_LABELS[k]}`,
    ),
    "Citation appendix",
    "Site map composite",
    "Briefing-source thumbnails",
  ];
  return `<section class="page" data-page="toc">
  <h2>Contents</h2>
  <ol class="toc">
    ${items.map((i) => `<li>${esc(i)}</li>`).join("\n    ")}
  </ol>
</section>`;
}

function renderSection(
  key: keyof BriefingSections,
  body: string | undefined | null,
): string {
  const text = plainTextCitations(body || "(section empty)");
  return `<section class="page" data-page="section-${key}">
  <h2>${esc(`${key.toUpperCase()} — ${SECTION_LABELS[key]}`)}</h2>
  <div class="section-body">${esc(text)}</div>
</section>`;
}

function renderAppendix(sources: ReadonlyArray<PdfBriefingSource>): string {
  if (sources.length === 0) {
    return `<section class="page" data-page="appendix">
  <h2>Citation appendix</h2>
  <p class="appendix-empty">No briefing sources are attached to this engagement.</p>
</section>`;
  }
  const now = Date.now();
  const buckets = groupSourcesForAppendix(sources);
  const tierBlocks: string[] = [];
  for (const tier of APPENDIX_TIER_ORDER) {
    const rows = buckets[tier];
    if (rows.length === 0) continue;
    const rowMarkup = rows
      .map((r) => {
        const label = (r.provider?.trim() || r.layerKind).toString();
        const snapshotIso = formatSnapshotDate(r.snapshotDate);
        const fresh = freshnessVerdict(r.snapshotDate, now);
        const noteMarkup =
          r.note && r.note.trim().length > 0
            ? `<div class="note">${esc(r.note.trim())}</div>`
            : "";
        return `<div class="appendix-row">
      <div class="label">${esc(label)}</div>
      <div class="meta-line">adapter: ${esc(r.sourceKind)} · layer: ${esc(r.layerKind)} · snapshot: ${esc(snapshotIso)} · <span class="freshness-${esc(fresh)}">freshness: ${esc(fresh)}</span></div>
      ${noteMarkup}
    </div>`;
      })
      .join("\n    ");
    tierBlocks.push(`<div class="appendix-tier">
    <h3>${esc(APPENDIX_TIER_LABELS[tier])}</h3>
    ${rowMarkup}
  </div>`);
  }
  return `<section class="page" data-page="appendix">
  <h2>Citation appendix</h2>
  <p class="appendix-empty" style="color:#555;font-size:9.5pt">Cited sources grouped by tier. Federal → state → local → manual uploads → other.</p>
  ${tierBlocks.join("\n  ")}
</section>`;
}

function renderMap(engagement: PdfEngagement): string {
  const lat = coerceCoordinate(engagement.latitude);
  const lon = coerceCoordinate(engagement.longitude);
  if (lat === null || lon === null) {
    return `<section class="page" data-page="map">
  <h2>Site map composite</h2>
  <div class="map-empty">[ no geocoded coordinates on file for this engagement ]</div>
  <div class="map-meta">A future Cesium ortho composite will overlay all toggled-on layers; the slot above is reserved for that capture.</div>
</section>`;
  }
  // OSM static map service via staticmap.openstreetmap.de — public, no
  // API key. Renders the parcel centroid with a marker. We keep this
  // server-resolved (no client JS) so Puppeteer doesn't need to wait
  // for tile loads beyond the single image fetch.
  const z = 15;
  const size = "780x540";
  const mapUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=${z}&size=${size}&markers=${lat},${lon},red-pushpin`;
  return `<section class="page" data-page="map">
  <h2>Site map composite</h2>
  <div class="map-frame"><img src="${esc(mapUrl)}" alt="Site map centred on ${esc(lat)},${esc(lon)}" /></div>
  <div class="map-meta">Centre: ${esc(lat.toFixed(6))}, ${esc(lon.toFixed(6))} (zoom ${z}). Tiles © OpenStreetMap contributors.</div>
</section>`;
}

function renderThumbnailGrid(
  sources: ReadonlyArray<PdfBriefingSource>,
): string {
  if (sources.length === 0) {
    return `<section class="page" data-page="thumbnails">
  <h2>Briefing-source thumbnails</h2>
  <p class="appendix-empty">No briefing sources to render.</p>
</section>`;
  }
  const cards = sources
    .map((s) => {
      const label = (s.provider?.trim() || s.layerKind).toString();
      const filename = s.uploadOriginalFilename
        ? `${s.uploadOriginalFilename}`
        : s.layerKind;
      let preview: string;
      if (s.uploadObjectPath && isImageMime(s.uploadContentType)) {
        // /objects/<id> is the public read-only path served by the
        // ObjectStorageService. Puppeteer fetches it through the
        // same proxy the FE uses so signed-URL semantics match.
        preview = `<img src="${esc(s.uploadObjectPath)}" alt="${esc(label)}" />`;
      } else {
        const tag = s.uploadContentType
          ? s.uploadContentType.split("/").pop() ?? s.uploadContentType
          : s.sourceKind;
        preview = `<span>[ ${esc(tag)} ]</span>`;
      }
      return `<div class="thumb-card">
    <div class="preview">${preview}</div>
    <div class="label">${esc(label)}</div>
    <div class="meta">${esc(filename)}</div>
  </div>`;
    })
    .join("\n  ");
  return `<section class="page" data-page="thumbnails">
  <h2>Briefing-source thumbnails</h2>
  <p class="appendix-empty" style="color:#555;font-size:9.5pt">Per-source preview tiles. Image uploads render the original artwork; non-image sources show their file-type tag.</p>
  <div class="thumb-grid">
  ${cards}
  </div>
</section>`;
}
