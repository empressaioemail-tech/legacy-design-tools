/**
 * P-466 / P-449. Fullscreen deeper view. Draws the ring, the envelope geom,
 * and the flood overlay the result already carries. Does not derive an envelope.
 */
import { markerHtml } from "./answer-first-html.js";
import {
  type BriefSection,
  type PanelModel,
  customerDate,
  customerSource,
  escapeHtml,
  floodOverlayOf,
  groundLayerHtml,
  groundPlan,
  landUseCustomerName,
  mapboxAttributionHtml,
  ringSvg,
  sourceOf,
  stateWord,
} from "./panel-lib.js";

const DISCLAIMER =
  "Derived from public records. Not a boundary survey. Verify with city staff and licensed professionals.";

const GROUPS: { title: string; ids: string[] }[] = [
  { title: "Zoning and rules", ids: ["zoning", "setbacks-envelope", "height"] },
  { title: "Flood and drainage", ids: ["flood", "drainage"] },
  { title: "Utilities and districts", ids: ["utilities", "water", "septic", "special-district", "districts"] },
  { title: "Structure on record", ids: ["land-use", "structure", "structures"] },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type DetailOpts = {
  groundOn: boolean;
  floodOn: boolean;
  envelopeOn: boolean;
  linesOn: boolean;
  sheet: "low" | "high";
};

function dateLong(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

function displayState(paint: string): string {
  if (paint === "refused") return "Refused";
  if (paint === "unread") return "Not read";
  if (paint === "absent-verified" || paint === "absent") return "absent, verified";
  if (paint === "unknown") return "unknown";
  return stateWord(paint as "present");
}

function sectionValue(s: BriefSection): string {
  if (s.paint !== "present" || !s.data) return displayState(s.paint);
  const d = s.data;
  if (s.id === "zoning" && typeof d.district === "string") return d.district;
  if (s.id === "flood" && typeof d.floodZone === "string") return `Zone ${String(d.floodZone).toUpperCase()}`;
  if (s.id === "land-use") return landUseCustomerName(d) || displayState(s.paint);
  if (s.id === "setbacks-envelope") {
    const part = (k: string, word: string) =>
      typeof d[k] === "number" && Number.isFinite(d[k] as number) ? `${d[k]} ft ${word}` : "";
    const bits = [part("frontFt", "front"), part("sideFt", "side"), part("rearFt", "rear"), part("cornerFt", "corner")].filter(Boolean);
    return bits.length ? bits.join(", ") : displayState(s.paint);
  }
  return displayState(s.paint);
}

function sourceLine(s: BriefSection): string {
  const bits: string[] = [];
  const source = customerSource(sourceOf(s));
  if (source) bits.push(source);
  const dated = dateLong(customerDate(s.asOf));
  if (dated) bits.push(dated);
  if (!bits.length) return "Source is not on this result.";
  return bits.join(". ");
}

function rowHtml(s: BriefSection, i: number): string {
  return (
    `<button type="button" class="ss-row" data-act="row" data-i="${i}" data-state="${escapeHtml(s.paint)}" onclick="window.__ss&&window.__ss.row(this)">` +
    `<span class="ss-tile-k">${escapeHtml(s.title || s.id)}</span>` +
    `<span class="ss-tile-v">${markerHtml(s.paint)}<span>${escapeHtml(sectionValue(s))}</span></span>` +
    `<span class="ss-tile-detail" hidden>${escapeHtml(sourceLine(s))}</span>` +
    `</button>`
  );
}

function panelHtml(model: PanelModel): string {
  const sections = model.sections ?? [];
  const used = new Set<string>();
  const groups = GROUPS.map((g) => {
    const rows = sections.filter((s) => g.ids.includes(s.id) && s.paint === "present");
    for (const s of rows) used.add(s.id);
    if (!rows.length) return "";
    return `<section class="ss-group"><h3>${escapeHtml(g.title)}</h3>${rows.map((s, i) => rowHtml(s, i)).join("")}</section>`;
  }).join("");
  const unknown = sections.filter((s) => s.paint === "unknown" || s.paint === "unread" || s.paint === "refused");
  const unknownHtml = unknown.length
    ? `<section class="ss-group" data-still-unknown="1"><h3>Still unknown</h3>${unknown.map((s, i) => rowHtml(s, 100 + i)).join("")}</section>`
    : "";
  const address = model.inlineCard?.title || model.label || "";
  const answer = model.inlineCard?.answer
    ? `<p class="af-answer" data-answer="1">${escapeHtml(model.inlineCard.answer)}</p>`
    : "";
  return (
    `<aside class="ss-panel" data-panel="1">` +
    `<div class="ss-sheet-handle" data-act="sheet" onclick="window.__ss&&window.__ss.sheet()" role="button" tabindex="0">Facts</div>` +
    (address ? `<p class="ss-address">${escapeHtml(address)}</p>` : "") +
    answer +
    groups +
    unknownHtml +
    `<p class="ss-disclaimer">${escapeHtml(DISCLAIMER)}</p>` +
    `<button type="button" class="btn" data-act="collapse" onclick="window.__ss&&window.__ss.collapse()">Back</button>` +
    `</aside>`
  );
}

export function detailHtml(model: PanelModel, opts: DetailOpts): string {
  const flood = opts.floodOn ? floodOverlayOf(model.overlays) : null;
  const envelopeOverlay = model.overlays.find((o) => o.id === "envelope" && o.geom && o.geom.length >= 3) ?? null;
  const geom = opts.envelopeOn && envelopeOverlay?.geom ? envelopeOverlay.geom : null;
  const named = model.overlays.find((o) => o.id === "envelope") ?? null;
  const floodSection = (model.sections ?? []).find((s) => s.id === "flood");
  const svg = ringSvg(model.ring ?? [], [], {
    quiet: false,
    envelope: geom,
    flood,
    paintFlood: !!flood,
    floodMethod: floodSection?.data && typeof floodSection.data.method === "string" ? floodSection.data.method : null,
    frame: model.frame ?? null,
  });
  const outcome = groundPlan(model.ring ?? [], model.anchor ?? null, model.anchorRead ?? null);
  const layer = opts.groundOn && outcome.plan ? groundLayerHtml(outcome.plan) : "";
  const map = svg
    ? `<div class="gwrap af-aerial ss-map" data-ground="${layer ? "on" : "off"}" data-lines="${opts.linesOn ? "on" : "off"}">${layer}${svg}` +
      `<div class="ss-gis">GIS-approximate</div>` +
      (!geom && named ? `<div class="ss-mapnote" data-envelope="undrawn">No envelope drawn</div>` : "") +
      `</div>`
    : `<div class="af-aerial af-aerial-none" data-aerial="absent"><p class="af-outline">Parcel outline not on this read</p></div>`;
  const credit = outcome.plan ? mapboxAttributionHtml() : "";
  const toggle = (key: string, label: string, on: boolean) =>
    `<button type="button" class="btn${on ? " on" : ""}" data-act="layer" data-layer="${key}" data-on="${on ? "1" : "0"}" onclick="window.__ss&&window.__ss.layer(this)">${label}</button>`;
  const layers =
    `<div class="ss-layers">` +
    toggle("aerial", "Aerial", opts.groundOn) +
    toggle("lines", "Parcel lines", opts.linesOn) +
    toggle("envelope", "Envelope", opts.envelopeOn) +
    toggle("flood", "Flood", opts.floodOn) +
    `</div>`;
  return (
    `<div class="ss-detail" data-layout="detail" data-sheet="${opts.sheet}">` +
    `<div class="ss-stage">${map}${layers}<div class="ss-row-credit">${credit}</div></div>` +
    panelHtml(model) +
    `</div>`
  );
}
